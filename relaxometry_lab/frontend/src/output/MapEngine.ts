export interface MapEngineResult {
  shape: [number, number]; // [origRows(Y), origCols(X)]
  map_b64: string;
  anat_b64: string | null;
  orient: { right: string; left: string; top: string; bottom: string } | null;
  voxel_mm: [number, number] | null;
}

export interface MapRefs {
  mapCanvas: HTMLCanvasElement;
  colorbarCanvas: HTMLCanvasElement;
}

/** 8-stop approximation of MATLAB "parula", ported verbatim from static/app.js. */
export function parula(t: number): [number, number, number] {
  const stops: [number, number, number][] = [
    [53, 42, 135],
    [15, 92, 221],
    [0, 144, 218],
    [7, 163, 179],
    [68, 172, 101],
    [157, 184, 55],
    [228, 197, 35],
    [254, 232, 37],
  ];
  const n = stops.length - 1;
  const i = Math.min(n - 1, Math.floor(t * n));
  const f = t * n - i;
  const a = stops[i],
    b = stops[i + 1];
  return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)];
}

/**
 * Direct TypeScript port of OutputPanel's map-canvas logic in static/app.js
 * (_renderMap/_renderColorbar/_onMapWheel/drag/rotate/flip/coordinate
 * transforms). Same rationale as OrthoEngine: canvas pixel work and
 * zoom/pan/drag math stay imperative, driven straight off refs, not React
 * state — this is deliberately not "React-ified".
 */
export class MapEngine {
  vmin = 0;
  vmax = 1;
  overlayAlpha = 0.75;
  transform = { rotation: 0, flipH: false, flipV: false };
  zoom = 1;
  panX = 0;
  panY = 0;
  viewport: { srcX: number; srcY: number; srcW: number; srcH: number } | null = null;

  private refs: MapRefs | null = null;
  private result: MapEngineResult | null = null;
  private selected: { x: number; y: number } | null = null;
  private dragState: { startX: number; startY: number; startPanX: number; startPanY: number } | null = null;

  private _onWheel = (e: WheelEvent) => this.handleWheel(e);
  private _onMouseDown = (e: MouseEvent) => this.handleMouseDown(e);
  private _onMouseMove = (e: MouseEvent) => this.handleMouseMove(e);
  private _onMouseUp = () => this.handleMouseUp();

  mount(refs: MapRefs) {
    this.refs = refs;
    refs.mapCanvas.addEventListener("wheel", this._onWheel, { passive: false });
    refs.mapCanvas.addEventListener("mousedown", this._onMouseDown);
    document.addEventListener("mousemove", this._onMouseMove);
    document.addEventListener("mouseup", this._onMouseUp);
  }

  unmount() {
    if (this.refs) {
      this.refs.mapCanvas.removeEventListener("wheel", this._onWheel as EventListener);
      this.refs.mapCanvas.removeEventListener("mousedown", this._onMouseDown);
    }
    document.removeEventListener("mousemove", this._onMouseMove);
    document.removeEventListener("mouseup", this._onMouseUp);
    this.refs = null;
  }

  /** Initial load into the Output step: resets zoom/pan/range to the fresh result's own vmin/vmax. */
  loadResult(result: MapEngineResult, vmin: number, vmax: number) {
    this.result = result;
    this.vmin = vmin;
    this.vmax = vmax;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    if (this.refs) this.refs.mapCanvas.style.cursor = "default";
    this.renderColorbar();
    this.render(this.selected);
  }

  /** Slice change: swap the map data only, keep the user's current view/range (matches vanilla setSlice()). */
  updateResult(result: MapEngineResult) {
    this.result = result;
    this.render(this.selected);
  }

  setSelected(sel: { x: number; y: number } | null) {
    this.selected = sel;
    if (this.result) this.render(sel);
  }

  setOverlayAlpha(v: number) {
    this.overlayAlpha = v;
    if (this.result) this.render(this.selected);
  }

  setRange(vmin: number, vmax: number) {
    this.vmin = vmin;
    this.vmax = vmax;
    this.renderColorbar();
    if (this.result) this.render(this.selected);
  }

  rotate(deg: number) {
    this.transform.rotation = (((this.transform.rotation + deg) % 360) + 360) % 360;
    if (this.result) this.render(this.selected);
  }

  flip(axis: "h" | "v") {
    if (axis === "h") this.transform.flipH = !this.transform.flipH;
    else this.transform.flipV = !this.transform.flipV;
    if (this.result) this.render(this.selected);
  }

  resetView() {
    this.transform = { rotation: 0, flipH: false, flipV: false };
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    if (this.refs) this.refs.mapCanvas.style.cursor = "default";
    if (this.result) this.render(this.selected);
  }

  private dispDims(): [number, number] {
    if (!this.result) return [1, 1];
    const { rotation: rot } = this.transform;
    const [origRows, origCols] = this.result.shape;
    return rot === 90 || rot === 270 ? [origRows, origCols] : [origCols, origRows];
  }

  private origToDisplay(oc: number, or_: number, origCols: number, origRows: number): [number, number] {
    const { rotation: rot, flipH, flipV } = this.transform;
    const fc = flipH ? origCols - 1 - oc : oc;
    const fr = flipV ? origRows - 1 - or_ : or_;
    if (rot === 0) return [fc, fr];
    if (rot === 90) return [origRows - 1 - fr, fc];
    if (rot === 180) return [origCols - 1 - fc, origRows - 1 - fr];
    if (rot === 270) return [fr, origCols - 1 - fc];
    return [fc, fr];
  }

  /** Display-pixel (dc,dr) -> original voxel (oc,or). Used to translate map clicks. */
  displayToOrig(dc: number, dr: number, origCols: number, origRows: number): [number, number] {
    const { rotation: rot, flipH, flipV } = this.transform;
    let uc: number, ur: number;
    if (rot === 0) {
      uc = dc;
      ur = dr;
    } else if (rot === 90) {
      uc = dr;
      ur = origRows - 1 - dc;
    } else if (rot === 180) {
      uc = origCols - 1 - dc;
      ur = origRows - 1 - dr;
    } else {
      uc = origCols - 1 - dr;
      ur = dc;
    }
    const oc = Math.min(origCols - 1, Math.max(0, flipH ? origCols - 1 - uc : uc));
    const or_ = Math.min(origRows - 1, Math.max(0, flipV ? origRows - 1 - ur : ur));
    return [oc, or_];
  }

  /** Canvas-fractional (0..1) click coordinates -> original voxel indices. */
  clickToVoxel(fracX: number, fracY: number): [number, number] | null {
    if (!this.result) return null;
    const [origRows, origCols] = this.result.shape;
    const [dispCols, dispRows] = this.dispDims();
    const vp = this.viewport;
    const dcx = Math.min(
      dispCols - 1,
      Math.max(0, Math.floor(vp ? vp.srcX + fracX * vp.srcW : fracX * dispCols))
    );
    const dcy = Math.min(
      dispRows - 1,
      Math.max(0, Math.floor(vp ? vp.srcY + fracY * vp.srcH : fracY * dispRows))
    );
    return this.displayToOrig(dcx, dcy, origCols, origRows);
  }

  private handleWheel(e: WheelEvent): { sliceDelta: number } | void {
    e.preventDefault();
    if (!this.result || !this.refs) return;
    const [dispCols, dispRows] = this.dispDims();
    const cv = this.refs.mapCanvas;
    const rect = cv.getBoundingClientRect();
    const fracX = (e.clientX - rect.left) / rect.width;
    const fracY = (e.clientY - rect.top) / rect.height;

    if (e.ctrlKey || e.metaKey) {
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const newZoom = Math.max(1, Math.min(12, this.zoom * factor));
      const srcW = dispCols / this.zoom;
      const srcH = dispRows / this.zoom;
      const srcX = Math.max(0, Math.min(dispCols - srcW, this.panX));
      const srcY = Math.max(0, Math.min(dispRows - srcH, this.panY));
      const imgX = srcX + fracX * srcW;
      const imgY = srcY + fracY * srcH;
      const nW = dispCols / newZoom,
        nH = dispRows / newZoom;
      this.panX = Math.max(0, Math.min(dispCols - nW, imgX - fracX * nW));
      this.panY = Math.max(0, Math.min(dispRows - nH, imgY - fracY * nH));
      this.zoom = newZoom;
      cv.style.cursor = newZoom > 1 ? "grab" : "default";
      this.render(this.selected);
      return;
    }
    this.onSliceWheel?.(e.deltaY > 0 ? 1 : -1);
  }

  /** Set by the React wrapper: called with +1/-1 when the user scrolls the map without Ctrl/Cmd held. */
  onSliceWheel: ((delta: number) => void) | null = null;

  private handleMouseDown(e: MouseEvent) {
    if (this.zoom <= 1 || e.button !== 0 || !this.refs) return;
    this.dragState = { startX: e.clientX, startY: e.clientY, startPanX: this.panX, startPanY: this.panY };
    this.refs.mapCanvas.style.cursor = "grabbing";
    e.preventDefault();
  }

  private handleMouseMove(e: MouseEvent) {
    if (!this.dragState || !this.result || !this.refs) return;
    const [dispCols, dispRows] = this.dispDims();
    const cv = this.refs.mapCanvas;
    const rect = cv.getBoundingClientRect();
    const srcW = dispCols / this.zoom;
    const srcH = dispRows / this.zoom;
    const dxImg = (-(e.clientX - this.dragState.startX) * srcW) / rect.width;
    const dyImg = (-(e.clientY - this.dragState.startY) * srcH) / rect.height;
    this.panX = Math.max(0, Math.min(dispCols - srcW, this.dragState.startPanX + dxImg));
    this.panY = Math.max(0, Math.min(dispRows - srcH, this.dragState.startPanY + dyImg));
    this.render(this.selected);
  }

  private handleMouseUp() {
    if (!this.dragState || !this.refs) return;
    this.dragState = null;
    this.refs.mapCanvas.style.cursor = this.zoom > 1 ? "grab" : "default";
  }

  renderColorbar() {
    if (!this.refs) return;
    const cv = this.refs.colorbarCanvas;
    const W = cv.clientWidth || 200;
    cv.width = W;
    cv.height = 14;
    const ctx = cv.getContext("2d")!;
    for (let x = 0; x < W; x++) {
      const [r, g, b] = parula(x / W);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x, 0, 1, 14);
    }
  }

  render(sel: { x: number; y: number } | null) {
    const result = this.result;
    if (!result || !this.refs) return;
    const cv = this.refs.mapCanvas;
    const [origRows, origCols] = result.shape;
    const { rotation: rot } = this.transform;

    const dispCols = rot === 90 || rot === 270 ? origRows : origCols;
    const dispRows = rot === 90 || rot === 270 ? origCols : origRows;

    const tmp = document.createElement("canvas");
    tmp.width = dispCols;
    tmp.height = dispRows;
    const tCtx = tmp.getContext("2d")!;
    const idata = tCtx.createImageData(dispCols, dispRows);
    const px = idata.data;

    const t2Bytes = Uint8Array.from(atob(result.map_b64), (c) => c.charCodeAt(0));
    const arr = new Float32Array(t2Bytes.buffer);
    const anat = result.anat_b64 ? Uint8Array.from(atob(result.anat_b64), (c) => c.charCodeAt(0)) : null;
    const vmin = this.vmin,
      vmax = this.vmax,
      alpha = this.overlayAlpha;

    for (let dr = 0; dr < dispRows; dr++) {
      for (let dc = 0; dc < dispCols; dc++) {
        const [oc, or_] = this.displayToOrig(dc, dr, origCols, origRows);
        const origIdx = or_ * origCols + oc;
        const dispIdx = (dr * dispCols + dc) * 4;
        const ag = anat ? anat[origIdx] : 30;
        const v = arr[origIdx];
        if (isNaN(v) || !isFinite(v)) {
          px[dispIdx] = ag;
          px[dispIdx + 1] = ag;
          px[dispIdx + 2] = ag;
          px[dispIdx + 3] = 255;
        } else {
          const t = Math.max(0, Math.min(1, (v - vmin) / (vmax - vmin || 1)));
          const [r, g, b] = parula(t);
          px[dispIdx] = Math.round(ag * (1 - alpha) + r * alpha);
          px[dispIdx + 1] = Math.round(ag * (1 - alpha) + g * alpha);
          px[dispIdx + 2] = Math.round(ag * (1 - alpha) + b * alpha);
          px[dispIdx + 3] = 255;
        }
      }
    }
    tCtx.putImageData(idata, 0, 0);

    const dpr = window.devicePixelRatio || 1;
    const cssW = cv.clientWidth || dispCols;
    const cssH = Math.round((cssW * dispRows) / dispCols);
    const bW = Math.round(cssW * dpr);
    const bH = Math.round(cssH * dpr);
    if (cv.width !== bW || cv.height !== bH) {
      cv.width = bW;
      cv.height = bH;
    }
    cv.style.width = cssW + "px";
    cv.style.height = cssH + "px";

    const ctx = cv.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;

    const vpSrcW = dispCols / this.zoom;
    const vpSrcH = dispRows / this.zoom;
    const vpSrcX = Math.max(0, Math.min(dispCols - vpSrcW, this.panX));
    const vpSrcY = Math.max(0, Math.min(dispRows - vpSrcH, this.panY));
    this.viewport = { srcX: vpSrcX, srcY: vpSrcY, srcW: vpSrcW, srcH: vpSrcH };
    ctx.drawImage(tmp, vpSrcX, vpSrcY, vpSrcW, vpSrcH, 0, 0, bW, bH);

    const sx = bW / vpSrcW;
    const sy = bH / vpSrcH;

    if (sel && Number.isFinite(sel.x) && Number.isFinite(sel.y)) {
      const [dc, dr] = this.origToDisplay(sel.x, sel.y, origCols, origRows);
      const pxX = (dc - vpSrcX) * sx,
        pxY = (dr - vpSrcY) * sy;
      const arm = 6 * dpr;
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = 3 * dpr;
      ctx.beginPath();
      ctx.moveTo(pxX - arm, pxY);
      ctx.lineTo(pxX + arm, pxY);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(pxX, pxY - arm);
      ctx.lineTo(pxX, pxY + arm);
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,35,35,1.0)";
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      ctx.moveTo(pxX - arm, pxY);
      ctx.lineTo(pxX + arm, pxY);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(pxX, pxY - arm);
      ctx.lineTo(pxX, pxY + arm);
      ctx.stroke();
    }

    if (result.orient) {
      let { right, left, top, bottom } = result.orient;
      const { flipH, flipV } = this.transform;
      if (flipH) [left, right] = [right, left];
      if (flipV) [top, bottom] = [bottom, top];
      if (rot === 90) [right, bottom, left, top] = [top, right, bottom, left];
      if (rot === 180) {
        [right, left] = [left, right];
        [top, bottom] = [bottom, top];
      }
      if (rot === 270) [right, bottom, left, top] = [bottom, left, top, right];

      const fs = Math.round(12 * dpr);
      const pad = Math.round(9 * dpr);
      ctx.font = `bold ${fs}px -apple-system, sans-serif`;
      ctx.fillStyle = "rgba(230,230,230,0.92)";
      ctx.shadowColor = "#000";
      ctx.shadowBlur = Math.round(3 * dpr);
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillText(left, pad, bH / 2);
      ctx.textAlign = "right";
      ctx.fillText(right, bW - pad, bH / 2);
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(top, bW / 2, pad);
      ctx.textBaseline = "bottom";
      ctx.fillText(bottom, bW / 2, bH - pad);
      ctx.shadowBlur = 0;
    }

    if (result.voxel_mm) {
      const horizMM = rot === 90 || rot === 270 ? result.voxel_mm[1] : result.voxel_mm[0];
      const pxPerMm = sx / horizMM;
      const targetMM = (bW * 0.18) / pxPerMm;
      const steps = [2, 5, 10, 20, 50, 100];
      const barMM = steps.reduce((b, v) => (Math.abs(v - targetMM) < Math.abs(b - targetMM) ? v : b));
      const barPx = barMM * pxPerMm;
      const bx = bW - Math.round(10 * dpr);
      const by = bH - Math.round(10 * dpr);

      ctx.shadowColor = "#000";
      ctx.shadowBlur = Math.round(2 * dpr);
      ctx.strokeStyle = "rgba(230,230,230,0.9)";
      ctx.lineWidth = Math.round(2 * dpr);
      ctx.beginPath();
      ctx.moveTo(bx - barPx, by);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = "rgba(230,230,230,0.9)";
      ctx.font = `${Math.round(9 * dpr)}px -apple-system, sans-serif`;
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      ctx.fillText(`${barMM} mm`, bx, by - Math.round(3 * dpr));
    }
  }
}
