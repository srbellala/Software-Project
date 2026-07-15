import { fetchSegVolume, fetchVolume } from "../api/ortho";

export type ViewName = "axial" | "coronal" | "sagittal";

export interface OrthoRefs {
  canvases: Record<ViewName, HTMLCanvasElement>;
  sliceInputs: Record<ViewName, HTMLInputElement>;
  sliceValues: Record<ViewName, HTMLSpanElement>;
  posLabels: Record<ViewName, HTMLSpanElement>;
}

const VIEW_AXIS: Record<ViewName, number> = { axial: 0, coronal: 1, sagittal: 2 };

/**
 * Direct TypeScript port of the vanilla OrthoViewer class (static/app.js).
 * Canvas pixel manipulation, zoom/pan math, and high-frequency slider/label
 * sync stay fully imperative (writing straight to refs) exactly like the
 * original — this is deliberately NOT routed through React state, since
 * re-rendering on every mousemove/wheel tick would be wasteful and the
 * original design already solved this well. React only owns mount/unmount
 * timing (via refs) and the low-frequency chrome around this engine
 * (overlay toggle, volume slider label, navigation buttons).
 */
export class OrthoEngine {
  vol: Float32Array | null = null;
  seg: Int32Array | null = null;
  shape: [number, number, number] | null = null; // [Z, Y, X]
  cpos: [number, number, number] = [0, 0, 0];
  showOverlay = false;
  overlayAlpha = 0.4;
  curVol = 0;
  nVols = 1;
  acqParams: number[] = [];
  acqLabel = "TE";
  private _voxMm: [number, number, number] = [1, 1, 1];
  private _wmin = 0;
  private _wmax = 1;

  private _refs: OrthoRefs | null = null;
  private _ctx: Partial<Record<ViewName, CanvasRenderingContext2D>> = {};
  private _viewZoom: Record<ViewName, number> = { axial: 1, coronal: 1, sagittal: 1 };
  private _viewPanX: Record<ViewName, number> = { axial: 0, coronal: 0, sagittal: 0 };
  private _viewPanY: Record<ViewName, number> = { axial: 0, coronal: 0, sagittal: 0 };
  private _viewDrag: { view: ViewName; startX: number; startY: number; startPanX: number; startPanY: number } | null =
    null;

  private _onMouseMove = (e: MouseEvent) => this._handleViewMouseMove(e);
  private _onMouseUp = () => this._handleViewMouseUp();
  private _viewListeners: Partial<Record<ViewName, { click: (e: MouseEvent) => void; down: (e: MouseEvent) => void; wheel: (e: WheelEvent) => void }>> = {};
  private _resizeObserver: ResizeObserver | null = null;

  mount(refs: OrthoRefs) {
    this._refs = refs;
    for (const view of Object.keys(refs.canvases) as ViewName[]) {
      const c = refs.canvases[view];
      this._ctx[view] = c.getContext("2d") ?? undefined;

      const onClick = (e: MouseEvent) => this._onClick(view, e);
      const onDown = (e: MouseEvent) => this._onViewMouseDown(view, e);
      const onWheel = (e: WheelEvent) => this._onWheel(view, e);
      c.addEventListener("click", onClick);
      c.addEventListener("mousedown", onDown);
      c.addEventListener("wheel", onWheel, { passive: false });
      this._viewListeners[view] = { click: onClick, down: onDown, wheel: onWheel };
    }
    document.addEventListener("mousemove", this._onMouseMove);
    document.addEventListener("mouseup", this._onMouseUp);

    // Same fix as MapEngine: canvas backing size is only recomputed inside
    // render(), driven by container width at that moment — without this,
    // a later container resize leaves the canvas undersized with the dark
    // parent's background showing through as a black gap.
    this._resizeObserver = new ResizeObserver(() => this.render());
    for (const view of Object.keys(refs.canvases) as ViewName[]) {
      const wrap = refs.canvases[view].parentElement;
      if (wrap) this._resizeObserver.observe(wrap);
    }
  }

  unmount() {
    if (this._refs) {
      for (const view of Object.keys(this._refs.canvases) as ViewName[]) {
        const c = this._refs.canvases[view];
        const l = this._viewListeners[view];
        if (l) {
          c.removeEventListener("click", l.click);
          c.removeEventListener("mousedown", l.down);
          c.removeEventListener("wheel", l.wheel as EventListener);
        }
      }
    }
    document.removeEventListener("mousemove", this._onMouseMove);
    document.removeEventListener("mouseup", this._onMouseUp);
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._refs = null;
  }

  private _onWheel(view: ViewName, e: WheelEvent) {
    e.preventDefault();
    const refs = this._refs;
    if (!refs) return;
    const c = refs.canvases[view];
    if (e.ctrlKey || e.metaKey) {
      const [dW, dH] = this._viewDims(view);
      const rect = c.getBoundingClientRect();
      const fracX = (e.clientX - rect.left) / rect.width;
      const fracY = (e.clientY - rect.top) / rect.height;
      const curZ = this._viewZoom[view];
      const newZ = Math.max(1, Math.min(12, curZ * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      const srcW = dW / curZ,
        srcH = dH / curZ;
      const srcX = Math.max(0, Math.min(dW - srcW, this._viewPanX[view]));
      const srcY = Math.max(0, Math.min(dH - srcH, this._viewPanY[view]));
      const imgX = srcX + fracX * srcW,
        imgY = srcY + fracY * srcH;
      const nW = dW / newZ,
        nH = dH / newZ;
      this._viewPanX[view] = Math.max(0, Math.min(dW - nW, imgX - fracX * nW));
      this._viewPanY[view] = Math.max(0, Math.min(dH - nH, imgY - fracY * nH));
      this._viewZoom[view] = newZ;
      c.style.cursor = newZ > 1 ? "grab" : "default";
      this._drawView(view);
    } else {
      const delta = e.deltaY > 0 ? 1 : -1;
      const cur = this.cpos[VIEW_AXIS[view]];
      const next = Math.max(0, Math.min(this._viewMax(view), cur + delta));
      refs.sliceInputs[view].value = String(next);
      this.setSlice(view, next);
    }
  }

  async load(sid: string, nVols: number, acqParams: number[], acqLabel: string) {
    this.nVols = nVols;
    this.acqParams = acqParams;
    this.acqLabel = acqLabel;

    const v = await fetchVolume(sid, 0);
    this.shape = v.shape;
    this._voxMm = v.voxMm;
    this.vol = v.data;
    const [Z, Y, X] = this.shape;
    this.cpos = [Math.floor(Z / 2), Math.floor(Y / 2), Math.floor(X / 2)];

    const sorted = Float32Array.from(this.vol).sort();
    const n = sorted.length;
    this._wmin = sorted[Math.floor(n * 0.01)];
    this._wmax = sorted[Math.floor(n * 0.99)];

    this._setupSliders(Z, Y, X);

    const seg = await fetchSegVolume(sid);
    this.seg = seg?.data ?? null;

    this.render();
  }

  async setVol(sid: string, idx: number) {
    this.curVol = idx;
    const v = await fetchVolume(sid, idx);
    this.vol = v.data;
    this.render();
  }

  volValueLabel(): string {
    const i = this.curVol;
    const val = this.acqParams[i] !== undefined ? this.acqParams[i] : i;
    if (this.acqLabel === "TE") return `${val.toFixed(0)} ms`;
    if (this.acqLabel.toLowerCase().includes("flip") || this.acqLabel.toLowerCase().includes("angle"))
      return `${val.toFixed(0)}°`;
    return `#${i}`;
  }

  private _setupSliders(Z: number, Y: number, X: number) {
    const refs = this._refs;
    if (!refs) return;
    const cfg: Record<ViewName, { max: number; init: number }> = {
      axial: { max: Z - 1, init: Math.floor(Z / 2) },
      coronal: { max: Y - 1, init: Math.floor(Y / 2) },
      sagittal: { max: X - 1, init: Math.floor(X / 2) },
    };
    const posLabelKey: Record<ViewName, string> = { axial: "z", coronal: "y", sagittal: "x" };
    for (const view of Object.keys(cfg) as ViewName[]) {
      const { max, init } = cfg[view];
      refs.sliceInputs[view].max = String(max);
      refs.sliceInputs[view].value = String(init);
      refs.sliceValues[view].textContent = String(init);
      refs.posLabels[view].textContent = `${posLabelKey[view]}: ${init}`;
    }
  }

  private _viewDims(view: ViewName): [number, number] {
    if (!this.shape) return [256, 256];
    const [Z, Y, X] = this.shape;
    if (view === "axial") return [X, Y];
    if (view === "coronal") return [X, Z];
    return [Y, Z]; // sagittal
  }

  private _viewMax(view: ViewName): number {
    if (!this.shape) return 0;
    return [this.shape[0] - 1, this.shape[1] - 1, this.shape[2] - 1][VIEW_AXIS[view]];
  }

  setSlice(view: ViewName, val: number) {
    const refs = this._refs;
    const axis = VIEW_AXIS[view];
    this.cpos[axis] = val;
    if (refs) {
      refs.sliceValues[view].textContent = String(val);
      const label = view === "axial" ? "z" : view === "coronal" ? "y" : "x";
      refs.posLabels[view].textContent = `${label}: ${val}`;
    }
    this.render();
  }

  toggleOverlay(v: boolean) {
    this.showOverlay = v;
    this.render();
  }

  setOverlayAlpha(v: number) {
    this.overlayAlpha = v;
    this.render();
  }

  private _voxAt(z: number, y: number, x: number): number {
    if (!this.vol || !this.shape) return 0;
    const [, Y, X] = this.shape;
    return this.vol[z * (Y * X) + y * X + x];
  }

  private _segAt(z: number, y: number, x: number): number {
    if (!this.seg || !this.shape) return 0;
    const [, Y, X] = this.shape;
    return this.seg[z * (Y * X) + y * X + x];
  }

  private _toGray(v: number): number {
    const t = Math.max(0, Math.min(1, (v - this._wmin) / (this._wmax - this._wmin || 1)));
    return Math.round(t * 255);
  }

  private _drawView(view: ViewName) {
    const refs = this._refs;
    if (!refs || !this.vol || !this.shape) return;
    const [Z, Y, X] = this.shape;
    const c = refs.canvases[view];
    const ctx = this._ctx[view];
    if (!ctx) return;
    const [dW, dH] = this._viewDims(view);
    const [cz, cy, cx] = this.cpos;

    const wrap = c.parentElement;
    const dispW = wrap?.clientWidth || dW;
    const dispH = wrap?.clientHeight || dH;
    const ratio = window.devicePixelRatio || 1;
    const bW = Math.round(dispW * ratio);
    const bH = Math.round(dispH * ratio);
    if (c.width !== bW || c.height !== bH) {
      c.width = bW;
      c.height = bH;
    }

    const tmp = document.createElement("canvas");
    tmp.width = dW;
    tmp.height = dH;
    const tCtx = tmp.getContext("2d")!;
    const idata = tCtx.createImageData(dW, dH);
    const px = idata.data;

    for (let row = 0; row < dH; row++) {
      for (let col = 0; col < dW; col++) {
        let vz = 0,
          vy = 0,
          vx = 0;
        if (view === "axial") {
          vz = cz;
          vy = row;
          vx = col;
        }
        if (view === "coronal") {
          vz = dH - 1 - row;
          vy = cy;
          vx = col;
        }
        if (view === "sagittal") {
          vz = dH - 1 - row;
          vy = row;
          vx = cx;
        }

        vz = Math.min(vz, Z - 1);
        vy = Math.min(vy, Y - 1);
        vx = Math.min(vx, X - 1);
        const g = this._toGray(this._voxAt(vz, vy, vx));
        const i = (row * dW + col) * 4;
        px[i] = g;
        px[i + 1] = g;
        px[i + 2] = g;
        px[i + 3] = 255;

        if (this.showOverlay && this._segAt(vz, vy, vx) > 0) {
          const a = this.overlayAlpha;
          px[i] = Math.round(px[i] * (1 - a) + 220 * a);
          px[i + 1] = Math.round(px[i + 1] * (1 - a) + 60 * a);
          px[i + 2] = Math.round(px[i + 2] * (1 - a) + 60 * a);
        }
      }
    }

    tCtx.putImageData(idata, 0, 0);
    ctx.clearRect(0, 0, bW, bH);
    const zoom = this._viewZoom[view];
    const vpW = dW / zoom,
      vpH = dH / zoom;
    const vpX = Math.max(0, Math.min(dW - vpW, this._viewPanX[view]));
    const vpY = Math.max(0, Math.min(dH - vpH, this._viewPanY[view]));
    ctx.drawImage(tmp, vpX, vpY, vpW, vpH, 0, 0, bW, bH);

    const XHAIR: Record<ViewName, string> = {
      axial: "rgba(220,80,80,0.85)",
      coronal: "rgba(230,185,40,0.85)",
      sagittal: "rgba(60,190,90,0.85)",
    };
    const sx = bW / vpW;
    const sy = bH / vpH;
    let hLine = 0,
      vLine = 0;
    if (view === "axial") {
      hLine = cy;
      vLine = cx;
    }
    if (view === "coronal") {
      hLine = dH - 1 - cz;
      vLine = cx;
    }
    if (view === "sagittal") {
      hLine = dH - 1 - cz;
      vLine = cy;
    }
    ctx.strokeStyle = XHAIR[view] || "rgba(200,200,200,0.8)";
    ctx.lineWidth = ratio;
    ctx.beginPath();
    ctx.moveTo(0, (hLine + 0.5 - vpY) * sy);
    ctx.lineTo(bW, (hLine + 0.5 - vpY) * sy);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo((vLine + 0.5 - vpX) * sx, 0);
    ctx.lineTo((vLine + 0.5 - vpX) * sx, bH);
    ctx.stroke();

    const ORIENT: Record<ViewName, { l: string; r: string; t: string; b: string }> = {
      axial: { l: "R", r: "L", t: "A", b: "P" },
      coronal: { l: "R", r: "L", t: "S", b: "I" },
      sagittal: { l: "A", r: "P", t: "S", b: "I" },
    };
    const ori = ORIENT[view];
    const fs = Math.round(12 * ratio);
    const pad = Math.round(9 * ratio);
    ctx.font = `bold ${fs}px -apple-system, sans-serif`;
    ctx.shadowColor = "#000";
    ctx.shadowBlur = Math.round(3 * ratio);
    ctx.fillStyle = "rgba(230,230,230,0.92)";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(ori.l, pad, bH / 2);
    ctx.textAlign = "right";
    ctx.fillText(ori.r, bW - pad, bH / 2);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(ori.t, bW / 2, pad);
    ctx.textBaseline = "bottom";
    ctx.fillText(ori.b, bW / 2, bH - pad);
    ctx.shadowBlur = 0;

    const VOX_W: Record<ViewName, number> = {
      axial: this._voxMm[2],
      coronal: this._voxMm[2],
      sagittal: this._voxMm[1],
    };
    const voxW = VOX_W[view] || 1;
    const pxPerMm = bW / (vpW * voxW);
    const targetMm = (bW * 0.18) / pxPerMm;
    const niceMm = [2, 5, 10, 20, 50, 100].reduce((a, b) => (Math.abs(b - targetMm) < Math.abs(a - targetMm) ? b : a));
    const barPx = niceMm * pxPerMm;
    const bx = bW - Math.round(10 * ratio);
    const by = bH - Math.round(10 * ratio);
    ctx.shadowColor = "#000";
    ctx.shadowBlur = Math.round(2 * ratio);
    ctx.strokeStyle = "rgba(230,230,230,0.9)";
    ctx.lineWidth = Math.round(2 * ratio);
    ctx.beginPath();
    ctx.moveTo(bx - barPx, by);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.font = `${Math.round(9 * ratio)}px -apple-system, sans-serif`;
    ctx.fillStyle = "rgba(230,230,230,0.9)";
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText(`${niceMm} mm`, bx, by - Math.round(3 * ratio));
  }

  render() {
    this._drawView("axial");
    this._drawView("coronal");
    this._drawView("sagittal");
  }

  private _onClick(view: ViewName, e: MouseEvent) {
    const refs = this._refs;
    if (!refs || !this.shape) return;
    const [Z, Y, X] = this.shape;
    const [dW, dH] = this._viewDims(view);
    const rect = refs.canvases[view].getBoundingClientRect();
    const fracX = (e.clientX - rect.left) / rect.width;
    const fracY = (e.clientY - rect.top) / rect.height;
    const zoom = this._viewZoom[view];
    const vpW = dW / zoom,
      vpH = dH / zoom;
    const vpX = Math.max(0, Math.min(dW - vpW, this._viewPanX[view]));
    const vpY = Math.max(0, Math.min(dH - vpH, this._viewPanY[view]));
    const col = Math.round(vpX + fracX * vpW);
    const row = Math.round(vpY + fracY * vpH);

    if (view === "axial") {
      this.cpos[2] = col;
      this.cpos[1] = row;
    }
    if (view === "coronal") {
      this.cpos[2] = col;
      this.cpos[0] = dH - 1 - row;
    }
    if (view === "sagittal") {
      this.cpos[1] = col;
      this.cpos[0] = dH - 1 - row;
    }

    this.cpos[0] = Math.max(0, Math.min(Z - 1, this.cpos[0]));
    this.cpos[1] = Math.max(0, Math.min(Y - 1, this.cpos[1]));
    this.cpos[2] = Math.max(0, Math.min(X - 1, this.cpos[2]));

    refs.sliceInputs.axial.value = String(this.cpos[0]);
    refs.sliceInputs.coronal.value = String(this.cpos[1]);
    refs.sliceInputs.sagittal.value = String(this.cpos[2]);
    refs.sliceValues.axial.textContent = String(this.cpos[0]);
    refs.sliceValues.coronal.textContent = String(this.cpos[1]);
    refs.sliceValues.sagittal.textContent = String(this.cpos[2]);
    refs.posLabels.axial.textContent = `z: ${this.cpos[0]}`;
    refs.posLabels.coronal.textContent = `y: ${this.cpos[1]}`;
    refs.posLabels.sagittal.textContent = `x: ${this.cpos[2]}`;

    this.render();
  }

  private _onViewMouseDown(view: ViewName, e: MouseEvent) {
    if (this._viewZoom[view] <= 1 || e.button !== 0) return;
    const refs = this._refs;
    if (!refs) return;
    this._viewDrag = {
      view,
      startX: e.clientX,
      startY: e.clientY,
      startPanX: this._viewPanX[view],
      startPanY: this._viewPanY[view],
    };
    refs.canvases[view].style.cursor = "grabbing";
    e.preventDefault();
  }

  private _handleViewMouseMove(e: MouseEvent) {
    if (!this._viewDrag || !this.shape || !this._refs) return;
    const { view } = this._viewDrag;
    const [dW, dH] = this._viewDims(view);
    const c = this._refs.canvases[view];
    const rect = c.getBoundingClientRect();
    const srcW = dW / this._viewZoom[view];
    const srcH = dH / this._viewZoom[view];
    const dxImg = (-(e.clientX - this._viewDrag.startX) * srcW) / rect.width;
    const dyImg = (-(e.clientY - this._viewDrag.startY) * srcH) / rect.height;
    this._viewPanX[view] = Math.max(0, Math.min(dW - srcW, this._viewDrag.startPanX + dxImg));
    this._viewPanY[view] = Math.max(0, Math.min(dH - srcH, this._viewDrag.startPanY + dyImg));
    this._drawView(view);
  }

  private _handleViewMouseUp() {
    if (!this._viewDrag || !this._refs) return;
    const v = this._viewDrag.view;
    this._viewDrag = null;
    this._refs.canvases[v].style.cursor = this._viewZoom[v] > 1 ? "grab" : "default";
  }
}
