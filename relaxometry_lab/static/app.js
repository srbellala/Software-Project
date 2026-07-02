/* ── Relaxometry Lab — frontend app ────────────────────────────────────────── */

const API = "";   // same origin

const PLOTLY_CFG = { displayModeBar: false, responsive: true };
const PLOTLY_LAYOUT = {
  paper_bgcolor: "#fafaf8",
  plot_bgcolor:  "#fafaf8",
  font: { family: "system-ui, sans-serif", size: 10, color: "#6b7e94" },
  margin: { l: 46, r: 12, t: 10, b: 38 },
  showlegend: false,
};

/* ────────────────────────────────────────────────────────── utils ─── */
function toast(msg, type="info", ms=3500) {
  const el = document.createElement("div");
  el.className = "toast" + (type==="error" ? " error" : type==="ok" ? " ok" : "");
  el.textContent = msg;
  document.getElementById("toast-area").append(el);
  setTimeout(() => el.remove(), ms);
}

function setStep(n) {
  [1,2,3,4].forEach(i => {
    const sc = document.getElementById(`sc-${i}`);
    const sl = document.getElementById(`sl-${i}`);
    sc.className = "step-circle" + (i < n ? " complete" : i === n ? " active" : "");
    sl.className = "step-label"  + (i < n ? " complete" : i === n ? " active" : "");
    if (i < 4) {
      document.getElementById(`conn-${i}`).className =
        "step-connector" + (i < n ? " complete" : "");
    }
  });
  const _displays = { load: "flex", preview: "block", fit: "block", output: "block" };
  ["load","preview","fit","output"].forEach((nm, idx) => {
    const el = document.getElementById(`step-${nm}`);
    el.style.display = (idx + 1 === n) ? _displays[nm] : "none";
  });
}

/* ────────────────────────────────────────────────────────── Ortho viewer ─── */
class OrthoViewer {
  constructor() {
    this.vol = null;    // Float32Array, ZYX
    this.seg = null;    // Int32Array,  ZYX
    this.shape = null;  // [Z, Y, X]
    this.cpos  = [0, 0, 0];  // [z, y, x] cursor position
    this.showOverlay = false;
    this.overlayAlpha = 0.4;
    this.curVol = 0;
    this.nVols  = 1;
    this.acqParams = [];
    this._voxMm = [1, 1, 1];  // [dz, dy, dx] in mm

    this._cvs = {
      axial:    document.getElementById("cv-axial"),
      coronal:  document.getElementById("cv-coronal"),
      sagittal: document.getElementById("cv-sagittal"),
    };
    this._ctx = {};
    const _viewAxis = { axial: 0, coronal: 1, sagittal: 2 };
    const _viewMax  = (k) => {
      if (!this.shape) return 0;
      return [this.shape[0]-1, this.shape[1]-1, this.shape[2]-1][_viewAxis[k]];
    };
    const _viewSlider = { axial: "sl-axial", coronal: "sl-coronal", sagittal: "sl-sagittal" };

    this._viewZoom = { axial: 1, coronal: 1, sagittal: 1 };
    this._viewPanX = { axial: 0, coronal: 0, sagittal: 0 };
    this._viewPanY = { axial: 0, coronal: 0, sagittal: 0 };
    this._viewDrag = null;

    for (const [k,c] of Object.entries(this._cvs)) {
      this._ctx[k] = c.getContext("2d");
      c.addEventListener("click", (e) => this._onClick(k, e));
      c.addEventListener("mousedown", (e) => this._onViewMouseDown(k, e));
      c.addEventListener("wheel", (e) => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          // Ctrl/Cmd+scroll: zoom toward cursor
          const [dW, dH] = this._viewDims(k);
          const rect  = c.getBoundingClientRect();
          const fracX = (e.clientX - rect.left) / rect.width;
          const fracY = (e.clientY - rect.top)  / rect.height;
          const curZ  = this._viewZoom[k];
          const newZ  = Math.max(1, Math.min(12, curZ * (e.deltaY < 0 ? 1.15 : 1/1.15)));
          const srcW  = dW / curZ, srcH = dH / curZ;
          const srcX  = Math.max(0, Math.min(dW - srcW, this._viewPanX[k]));
          const srcY  = Math.max(0, Math.min(dH - srcH, this._viewPanY[k]));
          const imgX  = srcX + fracX * srcW, imgY = srcY + fracY * srcH;
          const nW = dW / newZ, nH = dH / newZ;
          this._viewPanX[k] = Math.max(0, Math.min(dW - nW, imgX - fracX * nW));
          this._viewPanY[k] = Math.max(0, Math.min(dH - nH, imgY - fracY * nH));
          this._viewZoom[k] = newZ;
          c.style.cursor = newZ > 1 ? "grab" : "default";
          this._drawView(k);
        } else {
          // Regular scroll: change slice
          const delta = e.deltaY > 0 ? 1 : -1;
          const cur   = this.cpos[_viewAxis[k]];
          const next  = Math.max(0, Math.min(_viewMax(k), cur + delta));
          const sl    = document.getElementById(_viewSlider[k]);
          if (sl) sl.value = next;
          this.setSlice(k, next);
        }
      }, { passive: false });
    }
    document.addEventListener("mousemove", (e) => this._onViewMouseMove(e));
    document.addEventListener("mouseup",   ()  => this._onViewMouseUp());
    this._wmin = 0;
    this._wmax = 1;
  }

  async load(sid, nVols, acqParams, acqLabel) {
    this.nVols = nVols;
    this.acqParams = acqParams;

    const resp = await fetch(`${API}/api/load/${sid}/volume?echo=0`);
    if (!resp.ok) throw new Error("Volume fetch failed");

    const shapeHdr = resp.headers.get("X-Shape");
    this.shape = shapeHdr.split(",").map(Number);   // [Z, Y, X]
    const [Z, Y, X] = this.shape;
    this.cpos  = [Math.floor(Z/2), Math.floor(Y/2), Math.floor(X/2)];

    const voxHdr = resp.headers.get("X-VoxelMm");
    this._voxMm = voxHdr ? voxHdr.split(",").map(Number) : [1, 1, 1];  // [dz,dy,dx]

    const buf = await resp.arrayBuffer();
    this.vol = new Float32Array(buf);

    // Compute window min/max (1–99 percentile)
    const sorted = Float32Array.from(this.vol).sort();
    const n = sorted.length;
    this._wmin = sorted[Math.floor(n * 0.01)];
    this._wmax = sorted[Math.floor(n * 0.99)];

    // Setup sliders
    this._setupSliders(Z, Y, X);

    // Volume slider
    const vs = document.getElementById("vol-slider");
    vs.max = nVols - 1;
    vs.value = 0;
    document.getElementById("vol-label").textContent = acqLabel || "Volume";
    this._updateVolLabel();

    // Fetch segmentation if available
    await this._loadSeg(sid);

    this.render();
  }

  async _loadSeg(sid) {
    try {
      const r = await fetch(`${API}/api/load/${sid}/seg-volume`);
      if (!r.ok) return;
      const shdr = r.headers.get("X-Shape");
      if (!shdr) return;
      const buf = await r.arrayBuffer();
      this.seg = new Int32Array(buf);
    } catch(e) { /* no seg loaded */ }
  }

  async setVol(idx) {
    this.curVol = idx;
    this._updateVolLabel();
    // Reload volume for this echo
    if (!App._sid) return;
    const resp = await fetch(`${API}/api/load/${App._sid}/volume?echo=${idx}`);
    if (!resp.ok) return;
    const buf = await resp.arrayBuffer();
    this.vol = new Float32Array(buf);
    this.render();
  }

  _updateVolLabel() {
    const i = this.curVol;
    const val = this.acqParams[i] !== undefined ? this.acqParams[i] : i;
    const lbl = document.getElementById("vol-label").textContent;
    document.getElementById("vol-val").textContent =
      lbl === "TE" ? `${val.toFixed(0)} ms` :
      lbl.includes("flip") || lbl.includes("angle") ? `${val.toFixed(0)}°` :
      `#${i}`;
  }

  _setupSliders(Z, Y, X) {
    const cfg = {
      "sl-axial":    { max: Z-1, init: Math.floor(Z/2) },
      "sl-coronal":  { max: Y-1, init: Math.floor(Y/2) },
      "sl-sagittal": { max: X-1, init: Math.floor(X/2) },
    };
    for (const [id, {max, init}] of Object.entries(cfg)) {
      const el = document.getElementById(id);
      el.max = max; el.value = init;
    }
    document.getElementById("sv-axial").textContent    = Math.floor(Z/2);
    document.getElementById("sv-coronal").textContent  = Math.floor(Y/2);
    document.getElementById("sv-sagittal").textContent = Math.floor(X/2);

    const pa = document.getElementById("pos-axial");
    const pc = document.getElementById("pos-coronal");
    const ps = document.getElementById("pos-sagittal");
    if (pa) pa.textContent = `z: ${Math.floor(Z/2)}`;
    if (pc) pc.textContent = `y: ${Math.floor(Y/2)}`;
    if (ps) ps.textContent = `x: ${Math.floor(X/2)}`;
  }

  _viewDims(view) {
    const [Z, Y, X] = this.shape;
    if (view === "axial")    return [X, Y];
    if (view === "coronal")  return [X, Z];
    if (view === "sagittal") return [Y, Z];
    return [256, 256];
  }

  setSlice(view, val) {
    if (view === "axial") {
      this.cpos[0] = val;
      document.getElementById("sv-axial").textContent = val;
      const e = document.getElementById("pos-axial"); if (e) e.textContent = `z: ${val}`;
    } else if (view === "coronal") {
      this.cpos[1] = val;
      document.getElementById("sv-coronal").textContent = val;
      const e = document.getElementById("pos-coronal"); if (e) e.textContent = `y: ${val}`;
    } else if (view === "sagittal") {
      this.cpos[2] = val;
      document.getElementById("sv-sagittal").textContent = val;
      const e = document.getElementById("pos-sagittal"); if (e) e.textContent = `x: ${val}`;
    }
    this.render();
  }

  toggleOverlay(v) { this.showOverlay = v; this.render(); }
  setOverlayAlpha(v) { this.overlayAlpha = +v; this.render(); }

  _voxAt(z, y, x) {
    const [Z, Y, X] = this.shape;
    const idx = z * (Y * X) + y * X + x;
    return this.vol ? this.vol[idx] : 0;
  }
  _segAt(z, y, x) {
    if (!this.seg) return 0;
    const [Z, Y, X] = this.shape;
    return this.seg[z * (Y * X) + y * X + x];
  }

  _toGray(v) {
    const t = Math.max(0, Math.min(1, (v - this._wmin) / (this._wmax - this._wmin || 1)));
    return Math.round(t * 255);
  }

  _drawView(view) {
    if (!this.vol || !this.shape) return;
    const [Z, Y, X] = this.shape;
    const c   = this._cvs[view];
    const ctx = this._ctx[view];
    const [dW, dH] = this._viewDims(view);   // voxel dimensions
    const [cz, cy, cx] = this.cpos;

    // Size canvas buffer to container's physical pixels
    const wrap  = c.parentElement;
    const dispW = wrap.clientWidth  || dW;
    const dispH = wrap.clientHeight || dH;
    const ratio = window.devicePixelRatio || 1;
    const bW = Math.round(dispW * ratio);
    const bH = Math.round(dispH * ratio);
    if (c.width !== bW || c.height !== bH) {
      c.width  = bW;
      c.height = bH;
    }

    // Build ImageData at voxel resolution
    const tmp   = document.createElement("canvas");
    tmp.width   = dW;
    tmp.height  = dH;
    const tCtx  = tmp.getContext("2d");
    const idata = tCtx.createImageData(dW, dH);
    const px    = idata.data;

    for (let row = 0; row < dH; row++) {
      for (let col = 0; col < dW; col++) {
        let vz, vy, vx;
        if (view === "axial")    { vz = cz; vy = row; vx = col; }
        if (view === "coronal")  { vz = dH-1-row; vy = cy; vx = col; }
        if (view === "sagittal") { vz = dH-1-row; vy = row; vx = cx; }

        vz = Math.min(vz, Z-1); vy = Math.min(vy, Y-1); vx = Math.min(vx, X-1);
        const g = this._toGray(this._voxAt(vz, vy, vx));
        const i = (row * dW + col) * 4;
        px[i]=g; px[i+1]=g; px[i+2]=g; px[i+3]=255;

        // Segmentation overlay (red tint)
        if (this.showOverlay && this._segAt(vz, vy, vx) > 0) {
          const a = this.overlayAlpha;
          px[i]   = Math.round(px[i]   * (1-a) + 220 * a);
          px[i+1] = Math.round(px[i+1] * (1-a) + 60  * a);
          px[i+2] = Math.round(px[i+2] * (1-a) + 60  * a);
        }
      }
    }

    // Draw voxel-res image to temp canvas, then scale to display canvas (with zoom viewport)
    tCtx.putImageData(idata, 0, 0);
    ctx.clearRect(0, 0, bW, bH);
    const zoom = this._viewZoom[view];
    const vpW  = dW / zoom, vpH = dH / zoom;
    const vpX  = Math.max(0, Math.min(dW - vpW, this._viewPanX[view]));
    const vpY  = Math.max(0, Math.min(dH - vpH, this._viewPanY[view]));
    ctx.drawImage(tmp, vpX, vpY, vpW, vpH, 0, 0, bW, bH);

    // Crosshairs — coloured per view to match 3D Slicer panel headers
    const XHAIR = {
      axial:    "rgba(220,80,80,0.85)",
      coronal:  "rgba(230,185,40,0.85)",
      sagittal: "rgba(60,190,90,0.85)",
    };
    const sx = bW / vpW;
    const sy = bH / vpH;
    let hLine, vLine;
    if (view === "axial")    { hLine = cy;        vLine = cx; }
    if (view === "coronal")  { hLine = dH-1-cz;   vLine = cx; }
    if (view === "sagittal") { hLine = dH-1-cz;   vLine = cy; }
    ctx.strokeStyle = XHAIR[view] || "rgba(200,200,200,0.8)";
    ctx.lineWidth   = ratio;
    ctx.beginPath(); ctx.moveTo(0, (hLine+.5-vpY)*sy); ctx.lineTo(bW, (hLine+.5-vpY)*sy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo((vLine+.5-vpX)*sx, 0); ctx.lineTo((vLine+.5-vpX)*sx, bH); ctx.stroke();

    // Orientation labels (standard radiological convention)
    const ORIENT = {
      axial:    { l:"R", r:"L", t:"A", b:"P" },
      coronal:  { l:"R", r:"L", t:"S", b:"I" },
      sagittal: { l:"A", r:"P", t:"S", b:"I" },
    };
    const ori = ORIENT[view];
    const fs  = Math.round(12 * ratio);
    const pad = Math.round(9 * ratio);
    ctx.font = `bold ${fs}px -apple-system, sans-serif`;
    ctx.shadowColor = "#000";
    ctx.shadowBlur  = Math.round(3 * ratio);
    ctx.fillStyle   = "rgba(230,230,230,0.92)";
    ctx.textBaseline = "middle"; ctx.textAlign = "left";  ctx.fillText(ori.l, pad, bH/2);
    ctx.textAlign = "right";  ctx.fillText(ori.r, bW - pad, bH/2);
    ctx.textAlign = "center"; ctx.textBaseline = "top";    ctx.fillText(ori.t, bW/2, pad);
    ctx.textBaseline = "bottom"; ctx.fillText(ori.b, bW/2, bH - pad);
    ctx.shadowBlur = 0;

    // Scale bar (bottom-right corner) — uses vpW so bar adapts correctly when zoomed
    const VOX_W = { axial: this._voxMm[2], coronal: this._voxMm[2], sagittal: this._voxMm[1] };
    const voxW = VOX_W[view] || 1;           // mm per voxel in image width direction
    const pxPerMm = bW / (vpW * voxW);
    const targetMm = bW * 0.18 / pxPerMm;
    const niceMm = [2, 5, 10, 20, 50, 100].reduce((a, b) =>
      Math.abs(b - targetMm) < Math.abs(a - targetMm) ? b : a);
    const barPx = niceMm * pxPerMm;
    const bx = bW - Math.round(10 * ratio);
    const by = bH - Math.round(10 * ratio);
    ctx.shadowColor = "#000"; ctx.shadowBlur = Math.round(2 * ratio);
    ctx.strokeStyle = "rgba(230,230,230,0.9)";
    ctx.lineWidth = Math.round(2 * ratio);
    ctx.beginPath(); ctx.moveTo(bx - barPx, by); ctx.lineTo(bx, by); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.font = `${Math.round(9 * ratio)}px -apple-system, sans-serif`;
    ctx.fillStyle = "rgba(230,230,230,0.9)";
    ctx.textAlign = "right"; ctx.textBaseline = "bottom";
    ctx.fillText(`${niceMm} mm`, bx, by - Math.round(3 * ratio));
  }

  render() {
    this._drawView("axial");
    this._drawView("coronal");
    this._drawView("sagittal");
  }

  _onClick(view, e) {
    if (!this.shape) return;
    const [Z, Y, X] = this.shape;
    const [dW, dH] = this._viewDims(view);
    const rect  = this._cvs[view].getBoundingClientRect();
    const fracX = (e.clientX - rect.left) / rect.width;
    const fracY = (e.clientY - rect.top)  / rect.height;
    // Account for zoom/pan viewport
    const zoom = this._viewZoom[view];
    const vpW  = dW / zoom, vpH = dH / zoom;
    const vpX  = Math.max(0, Math.min(dW - vpW, this._viewPanX[view]));
    const vpY  = Math.max(0, Math.min(dH - vpH, this._viewPanY[view]));
    const col  = Math.round(vpX + fracX * vpW);
    const row  = Math.round(vpY + fracY * vpH);

    if (view === "axial")    { this.cpos[2] = col; this.cpos[1] = row; }
    if (view === "coronal")  { this.cpos[2] = col; this.cpos[0] = dH-1-row; }
    if (view === "sagittal") { this.cpos[1] = col; this.cpos[0] = dH-1-row; }

    this.cpos[0] = Math.max(0, Math.min(Z-1, this.cpos[0]));
    this.cpos[1] = Math.max(0, Math.min(Y-1, this.cpos[1]));
    this.cpos[2] = Math.max(0, Math.min(X-1, this.cpos[2]));

    // Sync sliders
    document.getElementById("sl-axial").value    = this.cpos[0];
    document.getElementById("sl-coronal").value  = this.cpos[1];
    document.getElementById("sl-sagittal").value = this.cpos[2];
    document.getElementById("sv-axial").textContent    = this.cpos[0];
    document.getElementById("sv-coronal").textContent  = this.cpos[1];
    document.getElementById("sv-sagittal").textContent = this.cpos[2];

    this.render();
  }

  _onViewMouseDown(view, e) {
    if (this._viewZoom[view] <= 1 || e.button !== 0) return;
    this._viewDrag = {
      view,
      startX: e.clientX, startY: e.clientY,
      startPanX: this._viewPanX[view], startPanY: this._viewPanY[view],
    };
    this._cvs[view].style.cursor = "grabbing";
    e.preventDefault();
  }

  _onViewMouseMove(e) {
    if (!this._viewDrag || !this.shape) return;
    const { view } = this._viewDrag;
    const [dW, dH] = this._viewDims(view);
    const c    = this._cvs[view];
    const rect = c.getBoundingClientRect();
    const srcW = dW / this._viewZoom[view];
    const srcH = dH / this._viewZoom[view];
    const dxImg = -(e.clientX - this._viewDrag.startX) * srcW / rect.width;
    const dyImg = -(e.clientY - this._viewDrag.startY) * srcH / rect.height;
    this._viewPanX[view] = Math.max(0, Math.min(dW - srcW, this._viewDrag.startPanX + dxImg));
    this._viewPanY[view] = Math.max(0, Math.min(dH - srcH, this._viewDrag.startPanY + dyImg));
    this._drawView(view);
  }

  _onViewMouseUp() {
    if (!this._viewDrag) return;
    const v = this._viewDrag.view;
    this._viewDrag = null;
    this._cvs[v].style.cursor = this._viewZoom[v] > 1 ? "grab" : "default";
  }
}

/* ────────────────────────────────────────────────────────── Output panel ─── */
class OutputPanel {
  constructor() {
    this.result         = null;

    this._vmin          = 0;
    this._vmax          = 1;

    this._overlayAlpha  = 0.75;
    this._mode          = "roi";
    this._voxelExplorer = null;
    this._useAll        = false;
    this._transform     = { rotation: 0, flipH: false, flipV: false };

    // Zoom / pan state (zoom=1 = full view; >1 = zoomed in)
    this._zoom      = 1.0;
    this._panX      = 0;      // viewport origin in voxel-display space (x)
    this._panY      = 0;      // viewport origin in voxel-display space (y)
    this._viewport  = null;   // { srcX, srcY, srcW, srcH } — updated by _renderMap
    this._dragState = null;

    const cv = document.getElementById("cv-map");
    cv.addEventListener("wheel", (e) => this._onMapWheel(e), { passive: false });
    cv.addEventListener("mousedown", (e) => this._onMapMouseDown(e));
    document.addEventListener("mousemove", (e) => this._onMapMouseMove(e));
    document.addEventListener("mouseup",   (e) => this._onMapMouseUp(e));
  }

  load(result) {
    this.result = result;
    this._vmin = result.vmin;
    this._vmax = result.vmax;
    this._zoom = 1;
    this._panX = 0;
    this._panY = 0;
    const mapCv = document.getElementById("cv-map");
    if (mapCv) mapCv.style.cursor = "default";


    // Title / stats
    const lbl = result.label;
    document.getElementById("map-title").textContent   = `${lbl} Map`;
    document.getElementById("hist-title").textContent  = `${lbl} Distribution`;
    document.getElementById("decay-title").textContent =
      lbl === "T2" ? "Median Decay Curve" : "Median VFA Curve";
    document.getElementById("stats-title").textContent = "ROI Statistics";

    const st = result.stats || {};
    const fmt = (v) => v !== undefined ? v.toFixed(1) + " ms" : "—";
    document.getElementById("st-median").textContent = fmt(st.median);
    document.getElementById("st-mean").textContent   = fmt(st.mean);
    document.getElementById("st-std").textContent    = fmt(st.std);
    document.getElementById("st-p25").textContent    = fmt(st.p25);
    document.getElementById("st-p75").textContent    = fmt(st.p75);
    document.getElementById("st-nvox").textContent   = st.n_vox ?? "—";

    // Slice slider
    const ss = document.getElementById("map-slice-slider");
    ss.max = result.n_slices - 1;
    ss.value = result.z;
    document.getElementById("map-slice-val").textContent = result.z;

    // Colorbar labels
    document.getElementById("cb-min").textContent = result.vmin.toFixed(0);
    document.getElementById("cb-max").textContent = result.vmax.toFixed(0);

    // Initialise T2 range inputs
    const minEl = document.getElementById("map-t2-min");
    const maxEl = document.getElementById("map-t2-max");
    if (minEl) minEl.value = Math.round(result.vmin);
    if (maxEl) maxEl.value = Math.round(result.vmax);

    this._renderMap(result);
    this._renderColorbar();
    this._renderDecay(result);
    this._renderHist();
  }

  setSlice(z) {
    document.getElementById("map-slice-val").textContent = z;
    if (!App._sid) return;
    const useAll = this._useAll ? "&use_all=true" : "";
    fetch(`${API}/api/fit/${App._sid}/result?slice_idx=${z}${useAll}`)
      .then(r => r.json())
      .then(res => {
        this.result = res;
        const sel = (this._mode === "voxel") ? this._voxelExplorer?._selected : null;
        this._renderMap(res, sel);
        this._renderDecay(res);
      });
  }

  setOverlayAlpha(v) {
    this._overlayAlpha = v;
    document.getElementById("map-overlay-val").textContent = Math.round(v * 100) + "%";
    if (this.result) {
      const sel = (this._mode === "voxel") ? this._voxelExplorer?._selected : null;
      this._renderMap(this.result, sel);
    }
  }

  setMode(mode) {
    this._mode = mode;
    document.getElementById("mode-roi").classList.toggle("active",   mode === "roi");
    document.getElementById("mode-voxel").classList.toggle("active", mode === "voxel");

    document.getElementById("out-roi-mid").classList.toggle("hidden",   mode !== "roi");
    document.getElementById("out-roi-right").classList.toggle("hidden",  mode !== "roi");
    document.getElementById("out-voxel-mid").classList.toggle("hidden",  mode !== "voxel");
    document.getElementById("out-voxel-right").classList.toggle("hidden", mode !== "voxel");

    const hint = document.getElementById("voxel-map-hint");
    if (hint) hint.classList.toggle("hidden", mode !== "voxel");

    const mapCtrls = document.getElementById("map-controls");
    if (mapCtrls) mapCtrls.classList.toggle("hidden", mode !== "voxel");

    if (mode === "voxel") {
      // Defer render until after CSS layout recalculates canvas sizes
      requestAnimationFrame(() => {
        const vx = this._voxelExplorer;
        if (!vx) return;
        if (!vx._scatter && App._sid) {
          vx.load(App._sid);
        } else if (vx._scatter) {
          vx._renderScatter();
        }
        if (vx._voxelData) {
          vx._renderSignalFit();
          vx._renderResiduals();
        }
        // Charts may have first drawn while this panel was display:none
        // (e.g. scatter is pre-fetched in the background during ROI mode);
        // Plotly.react keeps stale dimensions in that case, so force a resize
        // now that the container has its real, visible size.
        ["cv-scatter", "cv-vxsig", "cv-vxres"].forEach(id => {
          const el = document.getElementById(id);
          if (el && el.data) Plotly.Plots.resize(el);
        });
      });
    }
  }

  // ── View transform controls ──────────────────────────────────────────────
  rotateMap(deg) {
    this._transform.rotation = ((this._transform.rotation + deg) % 360 + 360) % 360;
    if (this.result) {
      const sel = this._mode === "voxel" ? this._voxelExplorer?._selected : null;
      this._renderMap(this.result, sel);
    }
  }
  flipMap(axis) {
    if (axis === "h") this._transform.flipH = !this._transform.flipH;
    else              this._transform.flipV = !this._transform.flipV;
    if (this.result) {
      const sel = this._mode === "voxel" ? this._voxelExplorer?._selected : null;
      this._renderMap(this.result, sel);
    }
  }
  resetView() {
    this._transform = { rotation: 0, flipH: false, flipV: false };
    this._zoom = 1;
    this._panX = 0;
    this._panY = 0;
    const mapCv = document.getElementById("cv-map");
    if (mapCv) mapCv.style.cursor = "default";
    if (this.result) {
      const sel = this._mode === "voxel" ? this._voxelExplorer?._selected : null;
      this._renderMap(this.result, sel);
    }
  }

  // ── Map wheel / drag interaction ─────────────────────────────────────────
  _mapDispDims() {
    if (!this.result) return [1, 1];
    const { rotation: rot } = this._transform;
    const [origRows, origCols] = this.result.shape;
    return (rot === 90 || rot === 270) ? [origRows, origCols] : [origCols, origRows];
  }

  _onMapWheel(e) {
    e.preventDefault();
    if (!this.result) return;
    const [dispCols, dispRows] = this._mapDispDims();
    const cv   = document.getElementById("cv-map");
    const rect = cv.getBoundingClientRect();
    const fracX = (e.clientX - rect.left) / rect.width;
    const fracY = (e.clientY - rect.top)  / rect.height;

    if (e.ctrlKey || e.metaKey) {
      // Zoom toward cursor
      const factor  = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const newZoom = Math.max(1, Math.min(12, this._zoom * factor));
      const srcW = dispCols / this._zoom;
      const srcH = dispRows / this._zoom;
      const srcX = Math.max(0, Math.min(dispCols - srcW, this._panX));
      const srcY = Math.max(0, Math.min(dispRows - srcH, this._panY));
      const imgX = srcX + fracX * srcW;
      const imgY = srcY + fracY * srcH;
      const nW = dispCols / newZoom, nH = dispRows / newZoom;
      this._panX = Math.max(0, Math.min(dispCols - nW, imgX - fracX * nW));
      this._panY = Math.max(0, Math.min(dispRows - nH, imgY - fracY * nH));
      this._zoom = newZoom;
      cv.style.cursor = newZoom > 1 ? "grab" : "default";
    } else {
      // Change slice
      const sl  = document.getElementById("map-slice-slider");
      const cur = parseInt(sl?.value) || 0;
      const max = parseInt(sl?.max)   || 0;
      const next = Math.max(0, Math.min(max, cur + (e.deltaY > 0 ? 1 : -1)));
      if (sl) sl.value = next;
      this.setSlice(next);
      return;
    }
    const sel = this._mode === "voxel" ? this._voxelExplorer?._selected : null;
    this._renderMap(this.result, sel);
  }

  _onMapMouseDown(e) {
    if (this._zoom <= 1 || e.button !== 0) return;
    this._dragState = {
      startX: e.clientX, startY: e.clientY,
      startPanX: this._panX, startPanY: this._panY,
    };
    document.getElementById("cv-map").style.cursor = "grabbing";
    e.preventDefault();
  }

  _onMapMouseMove(e) {
    if (!this._dragState || !this.result) return;
    const [dispCols, dispRows] = this._mapDispDims();
    const cv   = document.getElementById("cv-map");
    const rect = cv.getBoundingClientRect();
    const srcW = dispCols / this._zoom;
    const srcH = dispRows / this._zoom;
    const dxImg = -(e.clientX - this._dragState.startX) * srcW / rect.width;
    const dyImg = -(e.clientY - this._dragState.startY) * srcH / rect.height;
    this._panX = Math.max(0, Math.min(dispCols - srcW, this._dragState.startPanX + dxImg));
    this._panY = Math.max(0, Math.min(dispRows - srcH, this._dragState.startPanY + dyImg));
    const sel = this._mode === "voxel" ? this._voxelExplorer?._selected : null;
    this._renderMap(this.result, sel);
  }

  _onMapMouseUp(_e) {
    if (!this._dragState) return;
    this._dragState = null;
    document.getElementById("cv-map").style.cursor = this._zoom > 1 ? "grab" : "default";
  }

  // ── T2 range controls ────────────────────────────────────────────────────
  setT2Range() {
    const lo = parseFloat(document.getElementById("map-t2-min")?.value);
    const hi = parseFloat(document.getElementById("map-t2-max")?.value);
    if (!isNaN(lo)) this._vmin = lo;
    if (!isNaN(hi)) this._vmax = hi;
    document.getElementById("cb-min").textContent = this._vmin.toFixed(0);
    document.getElementById("cb-max").textContent = this._vmax.toFixed(0);
    this._renderColorbar();
    if (this.result) {
      const sel = this._mode === "voxel" ? this._voxelExplorer?._selected : null;
      this._renderMap(this.result, sel);
    }
  }
  resetT2Range() {
    if (!this.result) return;
    this._vmin = this.result.vmin;
    this._vmax = this.result.vmax;
    const minEl = document.getElementById("map-t2-min");
    const maxEl = document.getElementById("map-t2-max");
    if (minEl) minEl.value = Math.round(this._vmin);
    if (maxEl) maxEl.value = Math.round(this._vmax);
    document.getElementById("cb-min").textContent = this._vmin.toFixed(0);
    document.getElementById("cb-max").textContent = this._vmax.toFixed(0);
    this._renderColorbar();
    const sel = this._mode === "voxel" ? this._voxelExplorer?._selected : null;
    this._renderMap(this.result, sel);
  }
  setIgnoreThresh(v) {
    this._useAll = v;
    const z = parseInt(document.getElementById("map-slice-slider").value) || 0;
    this.setSlice(z);
  }

  // ── Navigation helpers ───────────────────────────────────────────────────
  _jumpToVoxel(vox) {
    if (!vox) { toast("No voxel found", "error"); return; }
    this.setMode("voxel");
    this._voxelExplorer?.selectVoxel(vox.x, vox.y, vox.z);
  }
  jumpToTargetT2() {
    const target = parseFloat(document.getElementById("map-target-t2")?.value);
    if (isNaN(target)) return;
    const sc = this._voxelExplorer?._scatter;
    if (!sc?.voxels?.length) { toast("Scatter not loaded yet", "error"); return; }
    const vox = sc.voxels.reduce((b, v) => Math.abs(v.t2 - target) < Math.abs(b.t2 - target) ? v : b);
    this._jumpToVoxel(vox);
  }
  jumpTo(type) {
    const sc = this._voxelExplorer?._scatter;
    if (!sc?.voxels?.length) { toast("Scatter not loaded yet", "error"); return; }
    const z = parseInt(document.getElementById("map-slice-slider").value) || 0;
    let vox;
    if (type === "global_median") {
      const med = sc.median;
      vox = sc.voxels.reduce((b, v) => Math.abs(v.t2 - med) < Math.abs(b.t2 - med) ? v : b);
    } else if (type === "slice_median") {
      const sv = sc.voxels.filter(v => v.z === z);
      if (!sv.length) { toast("No voxels on this slice", "error"); return; }
      const med = sv.reduce((s, v) => s + v.t2, 0) / sv.length;
      vox = sv.reduce((b, v) => Math.abs(v.t2 - med) < Math.abs(b.t2 - med) ? v : b);
    } else if (type === "highest_slice") {
      const sv = sc.voxels.filter(v => v.z === z);
      if (!sv.length) { toast("No voxels on this slice", "error"); return; }
      vox = sv.reduce((b, v) => v.t2 > b.t2 ? v : b);
    } else if (type === "highest_global") {
      vox = sc.voxels.reduce((b, v) => v.t2 > b.t2 ? v : b);
    }
    this._jumpToVoxel(vox);
  }

  // ── Forward transform: original voxel (oc, or) → display pixel (dc, dr)
  _origToDisplay(oc, or, origCols, origRows) {
    const { rotation: rot, flipH, flipV } = this._transform;
    const fc = flipH ? origCols - 1 - oc : oc;
    const fr = flipV ? origRows - 1 - or : or;
    if (rot === 0)   return [fc,              fr];
    if (rot === 90)  return [origRows-1-fr,   fc];
    if (rot === 180) return [origCols-1-fc,   origRows-1-fr];
    if (rot === 270) return [fr,              origCols-1-fc];
    return [fc, fr];
  }

  // ── Inverse transform: display pixel (dc, dr) → original voxel (oc, or)
  _displayToOrig(dc, dr, origCols, origRows) {
    const { rotation: rot, flipH, flipV } = this._transform;
    let uc, ur;
    if (rot === 0)   { uc = dc;             ur = dr; }
    else if (rot === 90)  { uc = dr;             ur = origRows-1-dc; }
    else if (rot === 180) { uc = origCols-1-dc;  ur = origRows-1-dr; }
    else                  { uc = origCols-1-dr;  ur = dc; }
    const oc = Math.min(origCols-1, Math.max(0, flipH ? origCols-1-uc : uc));
    const or = Math.min(origRows-1, Math.max(0, flipV ? origRows-1-ur : ur));
    return [oc, or];
  }

  _renderMap(result, sel = null) {
    const cv = document.getElementById("cv-map");
    const [origRows, origCols] = result.shape;  // [Y, X]
    const { rotation: rot } = this._transform;

    // Voxel-resolution display dims (may swap axes for 90/270)
    const dispCols = (rot === 90 || rot === 270) ? origRows : origCols;
    const dispRows = (rot === 90 || rot === 270) ? origCols : origRows;

    // ── Step 1: build image at voxel resolution in a temp canvas ─────────
    const tmp = document.createElement("canvas");
    tmp.width  = dispCols;
    tmp.height = dispRows;
    const tCtx  = tmp.getContext("2d");
    const idata = tCtx.createImageData(dispCols, dispRows);
    const px    = idata.data;

    const t2Bytes = Uint8Array.from(atob(result.map_b64), c => c.charCodeAt(0));
    const arr  = new Float32Array(t2Bytes.buffer);
    const anat = result.anat_b64
      ? Uint8Array.from(atob(result.anat_b64), c => c.charCodeAt(0))
      : null;
    const vmin = this._vmin, vmax = this._vmax, alpha = this._overlayAlpha;

    for (let dr = 0; dr < dispRows; dr++) {
      for (let dc = 0; dc < dispCols; dc++) {
        const [oc, or] = this._displayToOrig(dc, dr, origCols, origRows);
        const origIdx  = or * origCols + oc;
        const dispIdx  = (dr * dispCols + dc) * 4;
        const ag = anat ? anat[origIdx] : 30;
        const v  = arr[origIdx];
        if (isNaN(v) || !isFinite(v)) {
          px[dispIdx]=ag; px[dispIdx+1]=ag; px[dispIdx+2]=ag; px[dispIdx+3]=255;
        } else {
          const t = Math.max(0, Math.min(1, (v - vmin) / (vmax - vmin || 1)));
          const [r,g,b] = _parula(t);
          px[dispIdx]   = Math.round(ag * (1-alpha) + r * alpha);
          px[dispIdx+1] = Math.round(ag * (1-alpha) + g * alpha);
          px[dispIdx+2] = Math.round(ag * (1-alpha) + b * alpha);
          px[dispIdx+3] = 255;
        }
      }
    }
    tCtx.putImageData(idata, 0, 0);

    // ── Step 2: resize main canvas to display resolution (HiDPI) ─────────
    const dpr  = window.devicePixelRatio || 1;
    const cssW = cv.clientWidth  || dispCols;
    const cssH = Math.round(cssW * dispRows / dispCols);
    const bW   = Math.round(cssW * dpr);
    const bH   = Math.round(cssH * dpr);
    if (cv.width !== bW || cv.height !== bH) { cv.width = bW; cv.height = bH; }
    cv.style.width  = cssW + "px";
    cv.style.height = cssH + "px";

    const ctx  = cv.getContext("2d");
    ctx.imageSmoothingEnabled = false;

    // Apply zoom / pan viewport: draw only a sub-rect of the temp canvas
    const vp_srcW = dispCols / this._zoom;
    const vp_srcH = dispRows / this._zoom;
    const vp_srcX = Math.max(0, Math.min(dispCols - vp_srcW, this._panX));
    const vp_srcY = Math.max(0, Math.min(dispRows - vp_srcH, this._panY));
    this._viewport = { srcX: vp_srcX, srcY: vp_srcY, srcW: vp_srcW, srcH: vp_srcH };
    ctx.drawImage(tmp, vp_srcX, vp_srcY, vp_srcW, vp_srcH, 0, 0, bW, bH);

    // Scale factors accounting for zoom: voxel-display coord → canvas pixel
    const sx = bW / vp_srcW;
    const sy = bH / vp_srcH;

    // ── Draw crosshair ────────────────────────────────────────────────────
    if (sel && Number.isFinite(sel.x) && Number.isFinite(sel.y)) {
      const [dc, dr] = this._origToDisplay(sel.x, sel.y, origCols, origRows);
      const px_ = (dc - vp_srcX) * sx, py_ = (dr - vp_srcY) * sy;
      const arm  = 6 * dpr;
      ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 3 * dpr;
      ctx.beginPath(); ctx.moveTo(px_-arm, py_); ctx.lineTo(px_+arm, py_); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(px_, py_-arm); ctx.lineTo(px_, py_+arm); ctx.stroke();
      ctx.strokeStyle = "rgba(255,35,35,1.0)";  ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath(); ctx.moveTo(px_-arm, py_); ctx.lineTo(px_+arm, py_); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(px_, py_-arm); ctx.lineTo(px_, py_+arm); ctx.stroke();
    }

    // ── Orientation markers ───────────────────────────────────────────────
    if (result.orient) {
      let { right, left, top, bottom } = result.orient;
      const { flipH, flipV } = this._transform;
      if (flipH)    [left, right]   = [right, left];
      if (flipV)    [top, bottom]   = [bottom, top];
      if (rot === 90)  [right, bottom, left, top] = [top, right, bottom, left];
      if (rot === 180) { [right, left] = [left, right]; [top, bottom] = [bottom, top]; }
      if (rot === 270) [right, bottom, left, top] = [bottom, left, top, right];

      const fs  = Math.round(12 * dpr);
      const pad = Math.round(9  * dpr);
      ctx.font        = `bold ${fs}px -apple-system, sans-serif`;
      ctx.fillStyle   = "rgba(230,230,230,0.92)";
      ctx.shadowColor = "#000";
      ctx.shadowBlur  = Math.round(3 * dpr);
      ctx.textBaseline = "middle"; ctx.textAlign = "left";   ctx.fillText(left,   pad,      bH / 2);
      ctx.textAlign = "right";                               ctx.fillText(right,  bW - pad, bH / 2);
      ctx.textAlign = "center"; ctx.textBaseline = "top";   ctx.fillText(top,    bW / 2,   pad);
      ctx.textBaseline = "bottom";                           ctx.fillText(bottom, bW / 2,   bH - pad);
      ctx.shadowBlur = 0;
    }

    // ── Scale bar ─────────────────────────────────────────────────────────
    if (result.voxel_mm) {
      const horizMM  = (rot === 90 || rot === 270) ? result.voxel_mm[1] : result.voxel_mm[0];
      const pxPerMm  = sx / horizMM;   // display pixels per mm
      const targetMM = (bW * 0.18) / pxPerMm;
      const steps    = [2, 5, 10, 20, 50, 100];
      const barMM    = steps.reduce((b, v) => Math.abs(v - targetMM) < Math.abs(b - targetMM) ? v : b);
      const barPx    = barMM * pxPerMm;
      const bx = bW - Math.round(10 * dpr);
      const by = bH - Math.round(10 * dpr);

      ctx.shadowColor = "#000"; ctx.shadowBlur = Math.round(2 * dpr);
      ctx.strokeStyle = "rgba(230,230,230,0.9)";
      ctx.lineWidth   = Math.round(2 * dpr);
      ctx.beginPath(); ctx.moveTo(bx - barPx, by); ctx.lineTo(bx, by); ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle  = "rgba(230,230,230,0.9)";
      ctx.font       = `${Math.round(9 * dpr)}px -apple-system, sans-serif`;
      ctx.textAlign  = "right"; ctx.textBaseline = "bottom";
      ctx.fillText(`${barMM} mm`, bx, by - Math.round(3 * dpr));
    }
  }

  _renderColorbar() {
    const cv = document.getElementById("cv-colorbar");
    const W = cv.clientWidth || 200;
    cv.width = W; cv.height = 14;
    const ctx = cv.getContext("2d");
    for (let x = 0; x < W; x++) {
      const [r,g,b] = _parula(x / W);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x, 0, 1, 14);
    }
  }

  _renderDecay(result) {
    const acq   = result.acq_params  || [];
    const curve = result.decay_curve || [];
    if (!acq.length || !curve.length) return;
    const p25 = result.decay_p25 || [];
    const p75 = result.decay_p75 || [];
    const xlabel = result.label === "T2" ? "Echo Time (ms)" : "Flip Angle (°)";

    const traces = [];
    if (p25.length === acq.length && p75.length === acq.length) {
      traces.push(
        { x: acq, y: p25, mode: "lines", line: { width: 0 },
          hoverinfo: "skip", showlegend: false },
        { x: acq, y: p75, mode: "lines", line: { width: 0 },
          fill: "tonexty", fillcolor: "rgba(74,144,196,0.2)",
          name: "IQR", hoverinfo: "skip" },
      );
    }
    traces.push({
      x: acq, y: curve,
      mode: "lines+markers",
      name: "Median",
      line:   { color: "#234a6e", width: 2 },
      marker: { color: "#4a90c4", size: 6 },
    });

    Plotly.react("cv-decay", traces, {
      ...PLOTLY_LAYOUT,
      xaxis: { title: { text: xlabel, standoff: 14 }, color: "#6b7e94", gridcolor: "#e8e6e0", zeroline: false },
      yaxis: { title: { text: "Signal",standoff: 14 }, color: "#6b7e94", gridcolor: "#e8e6e0", zeroline: false },
    }, PLOTLY_CFG);
  }

  _renderHist() {
    const result = this.result;
    if (!result?.hist_counts?.length) return;
    const edges  = result.hist_edges;
    const counts = result.hist_counts;
    const mids   = edges.slice(0, -1).map((e, i) => (e + edges[i + 1]) / 2);
    Plotly.react("cv-hist", [{
      x: mids, y: counts,
      type: "bar",
      marker: { color: "#234a6e", opacity: 0.8 },
      hovertemplate: "%{x:.1f} ms: %{y}<extra></extra>",
    }], {
      ...PLOTLY_LAYOUT,
      bargap: 0.05,
      xaxis: { title: { text: `${result.label} (ms)`, standoff: 14 }, color: "#6b7e94", gridcolor: "#e8e6e0", zeroline: false },
      yaxis: { color: "#6b7e94", gridcolor: "#e8e6e0", zeroline: false },
    }, PLOTLY_CFG);
  }
}

/* ────────────────────────────────────────────────── Voxel Explorer ─── */
class VoxelExplorer {
  constructor(outputPanel) {
    this._out      = outputPanel;
    this._sid      = null;
    this._scatter  = null;   // {voxels, median, n}
    this._selected = null;   // {x, y, z}
    this._voxelData= null;

    // Map click — active only in voxel mode
    document.getElementById("cv-map").addEventListener("click", (e) => this._mapClick(e));
  }

  // ── Load all scatter data for this session
  async load(sid) {
    this._sid = sid;
    try {
      const r = await fetch(`${API}/api/fit/${sid}/scatter`);
      if (!r.ok) return;
      this._scatter = await r.json();
      const title = document.getElementById("scatter-title");
      if (title && this._scatter?.n) {
        const lbl = this._out.result?.label || "T2";
        title.textContent = `${lbl} Distribution  (n=${this._scatter.n})`;
      }
      this._renderScatter();
    } catch(e) { console.error("scatter load:", e); }
  }

  // ── Select a voxel: fetch its data, update all charts
  async selectVoxel(x, y, z) {
    if (!this._sid) return;
    this._selected = { x, y, z };
    try {
      const r = await fetch(`${API}/api/fit/${this._sid}/voxel?x=${x}&y=${y}&z=${z}`);
      if (!r.ok) return;
      this._voxelData = await r.json();
    } catch(e) { return; }

    const d = this._voxelData;

    // Update voxel info table
    document.getElementById("voxel-plot-title").textContent = "Voxel signal vs fit";
    const lblEl = document.getElementById("vx-param-label");
    if (lblEl) lblEl.textContent = d.modality === "T2" ? "T2 (ms)" : "T1 (ms)";
    document.getElementById("vx-pos").textContent    = `(${x}, ${y}, ${z})`;
    document.getElementById("vx-t2").textContent     = isFinite(d.t2) ? d.t2.toFixed(1) + " ms" : "—";
    document.getElementById("vx-r2fit").textContent  = isFinite(d.r2_fit) ? d.r2_fit.toFixed(3) : "—";
    document.getElementById("vx-rmse").textContent   = isFinite(d.rmse) ? d.rmse.toFixed(1) : "—";

    this._renderSignalFit();
    this._renderResiduals();
    this._renderScatter();

    // Update map crosshair — if different slice, fetch new slice first
    const currentZ = parseInt(document.getElementById("map-slice-slider").value) || 0;
    if (z !== currentZ) {
      document.getElementById("map-slice-slider").value = z;
      document.getElementById("map-slice-val").textContent = z;
      this._out.setSlice(z);   // setSlice fetches new map and draws crosshair
    } else if (this._out.result) {
      this._out._renderMap(this._out.result, this._selected);
    }
  }

  // ── Map canvas click → voxel selection
  _mapClick(e) {
    if (!this._sid) return;
    if (document.getElementById("out-voxel-mid")?.classList.contains("hidden")) return;
    const result = this._out.result;
    if (!result) return;
    const cv   = document.getElementById("cv-map");
    const rect = cv.getBoundingClientRect();
    // Use fractional position (0–1) so HiDPI canvas scaling doesn't matter
    const fracX = (e.clientX - rect.left) / rect.width;
    const fracY = (e.clientY - rect.top)  / rect.height;
    const [origRows, origCols] = result.shape;
    const rot = this._out._transform.rotation;
    const dispCols = (rot === 90 || rot === 270) ? origRows : origCols;
    const dispRows = (rot === 90 || rot === 270) ? origCols : origRows;
    // Account for zoom/pan viewport: canvas fraction → voxel-display coordinate
    const vp  = this._out._viewport;
    const dcx = Math.min(dispCols - 1, Math.max(0, Math.floor(
      vp ? vp.srcX + fracX * vp.srcW : fracX * dispCols
    )));
    const dcy = Math.min(dispRows - 1, Math.max(0, Math.floor(
      vp ? vp.srcY + fracY * vp.srcH : fracY * dispRows
    )));
    const [xi, yi] = this._out._displayToOrig(dcx, dcy, origCols, origRows);
    const z = parseInt(document.getElementById("map-slice-slider").value) || 0;
    this.selectVoxel(xi, yi, z);
  }

  // ── Signal vs Fit chart
  _renderSignalFit() {
    const d = this._voxelData;
    if (!d) return;
    const acq = d.acq_params || [], sig = d.signal || [], fit = d.fitted || [];
    if (!acq.length) return;
    const xlabel = d.modality === "T2" ? "TE (ms)" : "Flip Angle (°)";
    const traces = [
      { x: acq, y: sig, mode: "markers", name: "Measured",
        marker: { color: "#3a80c4", size: 8, line: { color: "#fff", width: 1.5 } },
        hovertemplate: `%{x:.1f}: %{y:.0f}<extra>Measured</extra>` },
    ];
    if (fit.length) {
      traces.push({ x: acq, y: fit, mode: "lines", name: "Fitted",
        line: { color: "#e8a020", width: 2.5 },
        hovertemplate: `%{x:.1f}: %{y:.0f}<extra>Fitted</extra>` });
    }
    Plotly.react("cv-vxsig", traces, {
      ...PLOTLY_LAYOUT,
      margin: { ...PLOTLY_LAYOUT.margin, l: 56, b: 50 },
      showlegend: true,
      legend: { x: 0.98, xanchor: "right", y: 0.98, bgcolor: "rgba(0,0,0,0)", font: { size: 9 } },
      xaxis: { title: { text: xlabel, standoff: 14 }, automargin: true, color: "#6b7e94", gridcolor: "#e8e6e0", zeroline: false },
      yaxis: { title: { text: "Signal", standoff: 14 }, automargin: true, color: "#6b7e94", gridcolor: "#e8e6e0", zeroline: false },
    }, PLOTLY_CFG);
  }

  // ── Residuals stem plot (null-separator trick)
  _renderResiduals() {
    const d = this._voxelData;
    if (!d) return;
    const acq = d.acq_params || [], res = d.residuals || [];
    if (!acq.length || !res.length) return;
    const xlabel = d.modality === "T2" ? "TE (ms)" : "Flip Angle (°)";
    // Build stem segments: for each point emit [x, x, x, null] and [0, val, null]
    const stemX = [], stemY = [];
    acq.forEach((a, i) => { stemX.push(a, a, null); stemY.push(0, res[i], null); });
    Plotly.react("cv-vxres", [
      { x: stemX, y: stemY, mode: "lines",
        line: { color: "rgba(190,50,50,0.7)", width: 1.5 }, hoverinfo: "skip" },
      { x: acq, y: res, mode: "markers",
        marker: { color: "rgba(190,50,50,0.85)", size: 7 },
        hovertemplate: `%{x:.1f}: %{y:.1f}<extra>Residual</extra>` },
    ], {
      ...PLOTLY_LAYOUT,
      margin: { ...PLOTLY_LAYOUT.margin, l: 56, t: 6, b: 50 },
      xaxis: { title: { text: xlabel, standoff: 14 }, automargin: true, color: "#6b7e94", gridcolor: "#e8e6e0", zeroline: false },
      yaxis: { title: { text: "Residual", standoff: 14 }, automargin: true, color: "#6b7e94", gridcolor: "#e8e6e0",
               zeroline: true, zerolinecolor: "#bbb", zerolinewidth: 1 },
    }, PLOTLY_CFG);
  }

  // ── T2 scatter plot (all ROI voxels, x=index, y=T2)
  _renderScatter() {
    const data = this._scatter;
    if (!data?.voxels?.length) return;
    const voxels = data.voxels;
    const lbl = this._out.result?.label || "T2";

    // Split into good-fit and poor-fit groups for coloring
    const good = voxels.filter(v => (v.r2_fit ?? 1) >= 0.5);
    const poor = voxels.filter(v => (v.r2_fit ?? 1) <  0.5);
    const mkGood = (pts) => ({
      x: pts.map((_, i) => voxels.indexOf(pts[i])),
      y: pts.map(v => v.t2),
      mode: "markers",
      marker: { color: "rgba(35,74,110,0.65)", size: 4 },
      customdata: pts,
      hovertemplate: `%{y:.1f} ms<extra></extra>`,
    });

    const traces = [
      { ...mkGood(good), name: "Good fit" },
      { ...mkGood(poor), name: "Poor fit", marker: { color: "rgba(210,95,80,0.7)", size: 4 } },
    ];

    // Highlight selected voxel
    if (this._selected) {
      const si = voxels.findIndex(v =>
        v.x === this._selected.x && v.y === this._selected.y && v.z === this._selected.z);
      if (si >= 0) {
        traces.push({ x: [si], y: [voxels[si].t2], mode: "markers",
          marker: { color: "rgba(210,40,40,0.9)", size: 10, symbol: "circle",
                    line: { color: "#fff", width: 1.5 } },
          hovertemplate: `%{y:.1f} ms<extra>Selected</extra>` });
      }
    }

    const layout = {
      ...PLOTLY_LAYOUT,
      showlegend: false,
      xaxis: { title: { text: "active voxels", standoff: 14 }, color: "#6b7e94",
               gridcolor: "#e8e6e0", zeroline: false },
      yaxis: { title: { text: `${lbl} (ms)`, standoff: 4 }, color: "#6b7e94",
               gridcolor: "#e8e6e0", zeroline: false },
    };

    // Add median annotation
    if (data.median != null) {
      layout.shapes = [{ type: "line", x0: 0, x1: 1, xref: "paper",
        y0: data.median, y1: data.median, yref: "y",
        line: { color: "rgba(70,130,90,0.6)", width: 1, dash: "dash" } }];
      layout.annotations = [{ x: 1, xref: "paper", xanchor: "right",
        y: data.median, yref: "y", yanchor: "bottom",
        text: `median ${data.median.toFixed(0)}`,
        showarrow: false, font: { size: 9, color: "rgba(70,130,90,0.9)" } }];
    }

    const div = document.getElementById("cv-scatter");
    Plotly.react("cv-scatter", traces, layout, PLOTLY_CFG);

    // Wire up click → selectVoxel (attach once; always reads this._scatter for current data)
    if (!div._plotlyClickBound) {
      div._plotlyClickBound = true;
      div.on("plotly_click", (evt) => {
        const pt = evt.points?.[0];
        if (!pt) return;
        const vox = pt.customdata ?? this._scatter?.voxels?.[Math.round(pt.x)];
        if (vox) this.selectVoxel(vox.x, vox.y, vox.z);
      });
    }
  }
}


/* ────────────────────────────────────────────────────── Parula colormap ─── */
// 8-stop approximation of MATLAB "parula"
function _parula(t) {
  const stops = [
    [53,42,135],[15,92,221],[0,144,218],[7,163,179],
    [68,172,101],[157,184,55],[228,197,35],[254,232,37]
  ];
  const n = stops.length - 1;
  const i = Math.min(n-1, Math.floor(t * n));
  const f = t * n - i;
  const a = stops[i], b = stops[i+1];
  return [
    Math.round(a[0] + (b[0]-a[0]) * f),
    Math.round(a[1] + (b[1]-a[1]) * f),
    Math.round(a[2] + (b[2]-a[2]) * f),
  ];
}

/* ────────────────────────────────────────────────────────── Main App ─── */
const App = (function() {
  let _sid  = null;
  let _modality = "T2";
  let _scanReady = false;
  const ortho         = new OrthoViewer();
  const output        = new OutputPanel();
  const voxelExplorer = new VoxelExplorer(output);
  output._voxelExplorer = voxelExplorer;

  /* ── Fit parameter table (new configure-fit layout) ───────────────── */
  function _buildParamTable(modality) {
    const tbody = document.getElementById("param-tbody");

    if (modality === "T2") {
      tbody.innerHTML = `
      <tr class="pt-row">
        <td class="pt-name">S<sub>0</sub> ratio</td>
        <td><input class="pt-inp" type="number" id="p-s0r-init" value="1.25" step="0.01"
             oninput="App._updateDerived()"/></td>
        <td><input class="pt-inp" type="number" id="p-s0r-lo" value="1.05" step="0.01"/></td>
        <td><input class="pt-inp" type="number" id="p-s0r-hi" value="10.0" step="0.1"/></td>
      </tr>
      <tr class="pt-row">
        <td class="pt-name">T2 <span class="pt-unit">(ms)</span></td>
        <td><input class="pt-inp" type="number" id="p-t2-init" value="20.0" step="1"
             oninput="App._updateDerived()"/></td>
        <td><input class="pt-inp" type="number" id="p-t2-lo" value="0.00001" step="0.00001"/></td>
        <td><input class="pt-inp" type="number" id="p-t2-hi" value="4000" step="10"
             oninput="App._updateDerived()"/></td>
      </tr>
      <tr class="pt-row pt-derived-row">
        <td class="pt-name">R2 <span class="pt-unit">(s⁻¹)</span></td>
        <td class="pt-derived-val" id="d-r2-init">50.0</td>
        <td class="pt-derived-val" id="d-r2-lo">0.25</td>
        <td class="pt-derived-val" id="d-r2-hi">1e+5</td>
      </tr>
      <tr class="pt-row">
        <td class="pt-name">Noise (C)</td>
        <td><input class="pt-inp" type="number" id="p-noise-init" value="1473" step="1"/></td>
        <td><span class="pt-dash">—</span></td>
        <td><span class="pt-dash">—</span></td>
      </tr>
      <tr class="pt-row">
        <td class="pt-name">Signal thresh <span class="pt-unit">(ms)</span></td>
        <td><span class="pt-dash">—</span></td>
        <td><input class="pt-inp" type="number" id="p-thr-lo" value="0.0" step="1"/></td>
        <td><input class="pt-inp" type="number" id="p-thr-hi" value="4000" step="10"/></td>
      </tr>
      <tr class="pt-row">
        <td class="pt-name">R² fit thresh</td>
        <td><input class="pt-inp" type="number" id="p-r2thr" value="0.50" step="0.01"
             min="0" max="1"/></td>
        <td><span class="pt-dash">—</span></td>
        <td><span class="pt-dash">—</span></td>
      </tr>`;
    } else {  // T1
      tbody.innerHTML = `
      <tr class="pt-row">
        <td class="pt-name">S<sub>0</sub></td>
        <td><input class="pt-inp" type="number" id="p-s0-init" value="3000" step="100"/></td>
        <td><span class="pt-dash">—</span></td>
        <td><span class="pt-dash">—</span></td>
      </tr>
      <tr class="pt-row">
        <td class="pt-name">T1 <span class="pt-unit">(ms)</span></td>
        <td><input class="pt-inp" type="number" id="p-t1-init" value="1000" step="10"
             oninput="App._updateDerived()"/></td>
        <td><input class="pt-inp" type="number" id="p-t1-lo" value="10" step="1"/></td>
        <td><input class="pt-inp" type="number" id="p-t1-hi" value="5000" step="10"
             oninput="App._updateDerived()"/></td>
      </tr>
      <tr class="pt-row pt-derived-row">
        <td class="pt-name">R1 <span class="pt-unit">(s⁻¹)</span></td>
        <td class="pt-derived-val" id="d-r1-init">1.000</td>
        <td class="pt-derived-val" id="d-r1-lo">0.200</td>
        <td class="pt-derived-val" id="d-r1-hi">100.0</td>
      </tr>
      <tr class="pt-row">
        <td class="pt-name">R² fit thresh</td>
        <td><input class="pt-inp" type="number" id="p-r2thr" value="0.50" step="0.01"
             min="0" max="1"/></td>
        <td><span class="pt-dash">—</span></td>
        <td><span class="pt-dash">—</span></td>
      </tr>`;
    }

    document.getElementById("tr-row").classList.toggle("hidden", modality !== "T1");

    const isT2 = modality === "T2";
    const tag = document.getElementById("fit-model-tag");
    if (tag) tag.textContent = `Model: ${isT2 ? "T2 Mono-Exponential" : "T1 VFA"}`;
    document.getElementById("model-name").textContent =
      isT2 ? "T2 Mono-Exponential" : "T1 VFA (Variable Flip Angle)";
    document.getElementById("model-eqn").innerHTML = isT2
      ? "S(TE) = C + S₀ · e<sup>−TE·R2</sup>"
      : "S(α) = S₀ · sin(α) · (1−E₁) / (1−cos(α)·E₁)";

    _updateDerived();
  }

  function _updateDerived() {
    const g = (id) => parseFloat(document.getElementById(id)?.value) || 0;
    if (_modality === "T2") {
      const t2i = g("p-t2-init") || 20;
      const t2h = g("p-t2-hi")   || 4000;
      const t2l = g("p-t2-lo")   || 1e-5;
      const fmt = (v) => v >= 1e4 ? v.toExponential(1) :
                         v < 0.01 ? v.toExponential(2) : +v.toPrecision(3) + "";
      const el = (id) => document.getElementById(id);
      if (el("d-r2-init")) el("d-r2-init").textContent = fmt(1000 / t2i);
      if (el("d-r2-lo"))   el("d-r2-lo").textContent   = fmt(1000 / t2h);
      if (el("d-r2-hi"))   el("d-r2-hi").textContent   = fmt(t2l > 0 ? 1000 / t2l : 1e8);
    } else {
      const t1i = g("p-t1-init") || 1000;
      const t1h = g("p-t1-hi")   || 5000;
      const t1l = g("p-t1-lo")   || 10;
      const el = (id) => document.getElementById(id);
      if (el("d-r1-init")) el("d-r1-init").textContent = (1000/t1i).toFixed(3);
      if (el("d-r1-lo"))   el("d-r1-lo").textContent   = (1000/t1h).toFixed(3);
      if (el("d-r1-hi"))   el("d-r1-hi").textContent   = (1000/t1l).toFixed(1);
    }
  }

  function _collectParams() {
    const g = (id, def) => {
      const el = document.getElementById(id);
      const v = el ? parseFloat(el.value) : NaN;
      return isNaN(v) ? def : v;
    };
    if (_modality === "T2") {
      return {
        s0_ratio_init: g("p-s0r-init", 1.25),
        s0_ratio_lo:   g("p-s0r-lo",   1.05),
        s0_ratio_hi:   g("p-s0r-hi",   10.0),
        t2_init:       g("p-t2-init",  20.0),
        t2_lo:         g("p-t2-lo",    1e-5),
        t2_hi:         g("p-t2-hi",    4000),
        noise_init:    g("p-noise-init", 1473),
        thresh_lo:     g("p-thr-lo",   0.0),
        thresh_hi:     g("p-thr-hi",   4000),
        r2_thresh:     g("p-r2thr",    0.5),
      };
    } else {
      return {
        t1_init:   g("p-t1-init", 1000),
        t1_lo:     g("p-t1-lo",   10),
        t1_hi:     g("p-t1-hi",   5000),
        r2_thresh: g("p-r2thr",   0.5),
      };
    }
  }

  /* ── Tool (modality) selector ──────────────────────────────────────── */
  function setTool(mod) {
    _modality = mod;
    document.getElementById("tool-t2").classList.toggle("active", mod==="T2");
    document.getElementById("tool-t1").classList.toggle("active", mod==="T1");
    document.getElementById("mb-t2").classList.toggle("active",   mod==="T2");
    document.getElementById("mb-t1").classList.toggle("active",   mod==="T1");
    const hint = mod === "T2"
      ? "Upload a Single 4D Enhanced DICOM (.dcm) — or a Folder of Per-Echo NIfTI files"
      : "Upload NIfTI volumes for each Flip Angle (.nii / .nii.gz)";
    document.getElementById("scan-hint").textContent = hint;
    _buildParamTable(mod);
  }

  /* ── Drop-zone helpers ─────────────────────────────────────────────── */
  function dzOver(e, id) { e.preventDefault(); document.getElementById(id).classList.add("dragover"); }
  function dzLeave(id)   { document.getElementById(id).classList.remove("dragover"); }
  function dzDrop(e, type) {
    e.preventDefault();
    dzLeave(type === "scan" ? "dz-scan" : "dz-seg");
    const files = Array.from(e.dataTransfer.files);
    if (type === "scan") _uploadScan(files);
    else                 _uploadSeg(files[0]);
  }
  function onScanFiles(e) { _uploadScan(Array.from(e.target.files)); }
  function onSegFile(e)   { _uploadSeg(e.target.files[0]); }

  /* ── Session creation + scan upload ───────────────────────────────── */
  async function _ensureSession() {
    if (_sid) return;
    const r = await fetch(`${API}/api/load/session?modality=${_modality}`, { method:"POST" });
    const d = await r.json();
    _sid = d.session_id;
  }

  async function _uploadScan(files) {
    try {
      await _ensureSession();
      const fd = new FormData();
      files.forEach(f => fd.append("files", f));
      toast("Uploading scan…");
      const r = await fetch(`${API}/api/load/${_sid}/scan`, { method:"POST", body:fd });
      if (!r.ok) { const d=await r.json(); throw new Error(d.detail||"Upload failed"); }
      const d = await r.json();
      _scanReady = true;
      const fl = document.getElementById("scan-file-list");
      fl.innerHTML = d.files.map(f=>`<div class="fl-item">📄 ${f}</div>`).join("");
      ortho.acqParams = d.acq_params;
      ortho.nVols = d.n_vols;
      document.getElementById("vol-label").textContent =
        d.modality === "T1" ? "flip angle" : "TE";
      toast(`Loaded ${d.n_vols} volumes · ${d.vox_str}`, "ok");
      await _doCheck();
    } catch(e) { toast(e.message, "error"); }
  }

  async function _uploadSeg(file) {
    try {
      if (!_sid) { toast("Upload scan first", "error"); return; }
      const fd = new FormData();
      fd.append("file", file);
      toast("Uploading Segmentation");
      const r = await fetch(`${API}/api/load/${_sid}/segmentation`, { method:"POST", body:fd });
      if (!r.ok) { const d=await r.json(); throw new Error(d.detail||"Seg upload failed"); }
      const d = await r.json();
      document.getElementById("seg-file-list").innerHTML =
        `<div class="fl-item">🎭 ${d.filename} (labels: ${d.labels.join(", ")})</div>`;
      toast("Segmentation Loaded", "Ok");
      await _doCheck();
    } catch(e) { toast(e.message, "Error"); }
  }

  async function _doCheck() {
    if (!_sid) return;
    const r = await fetch(`${API}/api/load/${_sid}/check`);
    const d = await r.json();
    const box = document.getElementById("align-box");
    box.textContent = d.message;
    const cls = d.level === "ok" ? " ok" : d.level === "warn" ? " warn" : d.ready ? " ok" : " err";
    box.className   = "align-box" + cls;
    document.getElementById("btn-next-preview").disabled = !_scanReady || !d.ready;
  }

  /* ── Demo data ─────────────────────────────────────────────────────── */
  async function loadDemo() {
    try {
      await _ensureSession();
      toast("Loading Demo Dataset");
      const r = await fetch(`${API}/api/load/${_sid}/demo?modality=${_modality}`, { method:"POST" });
      if (!r.ok) { const d=await r.json(); throw new Error(d.detail||"Demo failed"); }
      const d = await r.json();
      _scanReady = true;
      document.getElementById("scan-file-list").innerHTML =
        d.files.map(f=>`<div class="fl-item">📄 ${f}</div>`).join("");
      document.getElementById("seg-file-list").innerHTML =
        `<div class="fl-item">🎭 demo_seg.nii.gz (label: 1)</div>`;
      const box = document.getElementById("align-box");
      box.textContent = `Demo data loaded — ${d.shape[0]}×${d.shape[1]}×${d.shape[2]}, ${d.vox_str}.`;
      box.className = "align-box ok";
      ortho.acqParams = d.acq_params;
      ortho.nVols = d.n_vols;
      document.getElementById("btn-next-preview").disabled = false;
      toast("Demo Dataset Ready ", "OK");
    } catch(e) { toast(e.message, "Error"); }
  }

  /* ── Navigation ────────────────────────────────────────────────────── */
  async function goToPreview() {
    if (!_sid || !_scanReady) { toast("Load a Scan First", "Error"); return; }
    setStep(2);
    try {
      await ortho.load(_sid, ortho.nVols, ortho.acqParams,
                       _modality === "T1" ? "Flip Angle" : "TE");
    } catch(e) {
      console.error(e);
      toast("Preview Load Error: " + e.message, "Error");
    }
  }

  function goToLoad()    { setStep(1); }

  function goToFit() {
    setStep(3);
    _buildParamTable(_modality);
  }

  /* ── Fitting ───────────────────────────────────────────────────────── */
  async function runFit() {
    if (!_sid) { toast("No Session", "Error"); return; }
    const params = _collectParams();
    const tr = _modality === "T1" ? parseFloat(document.getElementById("tr-input").value) : null;

    document.getElementById("btn-run-fit").disabled = true;
    document.getElementById("fit-progress-wrap").classList.remove("hidden");
    const bar   = document.getElementById("fit-progress-bar");
    const label = document.getElementById("fit-progress-label");
    bar.style.width = "0%";
    label.textContent = "Starting…";

    // Start fit
    const body = { modality: _modality, params, tr_ms: tr };
    const r = await fetch(`${API}/api/fit/${_sid}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      toast("Fit Start Failed ", "Error");
      document.getElementById("btn-run-fit").disabled = false;
      return;
    }

    // SSE progress
    const es = new EventSource(`${API}/api/fit/${_sid}/progress`);
    es.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.status === "progress") {
        bar.style.width = msg.pct + "%";
        label.textContent = `Fitting… ${msg.done} / ${msg.total} voxels (${msg.pct}%)`;
      } else if (msg.status === "done") {
        es.close();
        bar.style.width = "100%";
        label.textContent = "Complete!";
        toast("Fitting Complete", "ok");
        document.getElementById("btn-run-fit").disabled = false;
        setTimeout(() => goToOutput(), 600);
      } else if (msg.status === "error") {
        es.close();
        toast("Fit error: " + (msg.message||""), "error");
        document.getElementById("btn-run-fit").disabled = false;
      }
    };
    es.onerror = () => {
      es.close();
      toast("SSE connection lost", "error");
      document.getElementById("btn-run-fit").disabled = false;
    };
  }

  /* ── Output ────────────────────────────────────────────────────────── */
  async function goToOutput() {
    setStep(4);
    // Reset to ROI mode whenever we load new results
    output.setMode("roi");
    try {
      const r = await fetch(`${API}/api/fit/${_sid}/result`);
      if (!r.ok) { toast("Result fetch failed", "error"); return; }
      const d = await r.json();
      output.load(d);
      // Pre-fetch scatter in background so voxel mode loads instantly
      voxelExplorer._sid = _sid;
      voxelExplorer._scatter = null;
      voxelExplorer._selected = null;
      voxelExplorer.load(_sid);
    } catch(e) { toast(e.message, "error"); }
  }

  function download(type) {
    if (!_sid) return;
    const urls = {
      map:    `/api/output/${_sid}/map.nii.gz`,
      stats:  `/api/output/${_sid}/stats.csv`,
      report: `/api/output/${_sid}/report.pdf`,
      voxels: `/api/output/${_sid}/voxels.npz`,
    };
    const a = document.createElement("a");
    a.href = urls[type];
    a.download = "";
    a.click();
  }

  /* ── Bruker study browser ──────────────────────────────────────────── */
  let _brukerScans   = [];   // full list returned by the server
  let _brukerFilter  = "all";
  let _brukerSelected = null;  // { scan, modality }

  async function onBrukerZip(file) {
    if (!file) return;
    const btn = document.querySelector(".bruker-upload-btn");
    const origText = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = "Scanning…"; }
    // Persistent loading toast (manually removed on completion)
    const loadEl = document.createElement("div");
    loadEl.className = "toast";
    loadEl.textContent = "Scanning Bruker study — this may take a moment…";
    document.getElementById("toast-area").append(loadEl);
    try {
      await _ensureSession();
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(`${API}/api/load/${_sid}/bruker-study`, { method: "POST", body: fd });
      if (!r.ok) { const d = await r.json(); throw new Error(d.detail || "Upload failed"); }
      const d = await r.json();
      _brukerScans    = d.scans;
      _brukerSelected = null;
      _brukerFilter   = "all";
      _renderBrukerStudy();
      document.getElementById("bruker-modal").classList.remove("hidden");
      toast(`Found ${d.n_scans} scan${d.n_scans !== 1 ? "s" : ""}`, "ok");
    } catch(e) {
      console.error("Bruker upload error:", e);
      toast(e.message, "error");
    } finally {
      loadEl.remove();
      if (btn) { btn.disabled = false; btn.textContent = origText; }
    }
    // Reset the file input so the same zip can be re-uploaded
    document.getElementById("inp-bruker").value = "";
  }

  function _renderBrukerStudy() {
    const tbody = document.getElementById("bruker-tbody");
    const filterMap = { all: null, T2: "T2", T1: "T1", anat: ["anat", "other", "unknown"] };
    const want = filterMap[_brukerFilter];

    // Update chip active state
    ["all","t2","t1","anat"].forEach(k => {
      document.getElementById(`bf-${k}`)?.classList.remove("chip-active");
    });
    document.getElementById(`bf-${_brukerFilter.toLowerCase()}`)?.classList.add("chip-active");

    tbody.innerHTML = "";
    for (const s of _brukerScans) {
      const visible = (
        !want ||
        (Array.isArray(want) ? want.includes(s.modality) : s.modality === want)
      );
      if (!visible) continue;

      // All scans are selectable; non-T2/T1 rows are visually dimmed but still clickable
      const preferredFit = s.modality === "T2" ? "T2" : s.modality === "T1" ? "T1" : null;
      const tr = document.createElement("tr");
      if (!preferredFit) tr.classList.add("bt-muted");
      if (_brukerSelected?.scan === s.scan) tr.classList.add("bt-selected");

      const badge = { T2: "bt-badge-t2", T1: "bt-badge-t1",
                      anat: "bt-badge-anat", other: "bt-badge-anat",
                      unknown: "bt-badge-unk" }[s.modality] || "bt-badge-unk";
      const modLabel = { T2: "T2 multi-echo", T1: "T1",
                         anat: "Anat", other: "Other",
                         unknown: "Unknown" }[s.modality] || s.modality;

      const teStr = s.tes?.length
        ? s.tes.slice(0, 5).map(t => t.toFixed(1)).join(", ") + (s.tes.length > 5 ? " …" : "")
        : "—";
      const echoStr = s.n_echo > 0
        ? `${s.n_echo} echo${s.n_echo > 1 ? "es" : ""}`
        : (s.flip_angle != null ? `FA ${s.flip_angle}°` : "—");
      const filesStr = [s.has_dicom ? "DICOM" : null, s.has_nifti ? "NIfTI" : null]
        .filter(Boolean).join(" · ") || "—";

      tr.innerHTML = `
        <td>${s.scan}</td>
        <td>${s.title || "—"}</td>
        <td><span class="bt-badge ${badge}">${modLabel}</span></td>
        <td>${echoStr}<br><span class="bt-te-list">${teStr}</span></td>
        <td>${filesStr}</td>
      `;

      {
        tr.addEventListener("click", () => {
          _brukerSelected = { scan: s.scan, modality: s.modality };
          document.getElementById("bruker-use-btn").disabled = false;
          const hint = preferredFit
            ? `Selected: scan ${s.scan} — ${s.title || s.method}`
            : `Selected: scan ${s.scan} — modality unknown, will attempt load`;
          document.getElementById("bruker-selection-hint").textContent = hint;
          // Highlight row
          tbody.querySelectorAll("tr").forEach(r => r.classList.remove("bt-selected"));
          tr.classList.add("bt-selected");
        });
      }
      tbody.appendChild(tr);
    }

    if (!tbody.children.length) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--muted)">
        No scans match this filter.</td></tr>`;
    }
  }

  function filterBruker(type) {
    _brukerFilter = type;
    _brukerSelected = null;
    document.getElementById("bruker-use-btn").disabled = true;
    document.getElementById("bruker-selection-hint").textContent = "Click a row to select a scan";
    _renderBrukerStudy();
  }

  async function selectBrukerScan() {
    if (!_brukerSelected || !_sid) return;
    const { scan } = _brukerSelected;
    try {
      toast(`Loading scan ${scan}…`);
      const r = await fetch(`${API}/api/load/${_sid}/bruker-select?scan=${scan}`, { method: "POST" });
      if (!r.ok) { const d = await r.json(); throw new Error(d.detail || "Load failed"); }
      const d = await r.json();

      // Close modal
      document.getElementById("bruker-modal").classList.add("hidden");

      // Auto-set modality
      if (d.modality === "T2" || d.modality === "T1") setTool(d.modality);

      // Same post-processing as _uploadScan
      _scanReady = true;
      document.getElementById("scan-file-list").innerHTML =
        d.files.map(f => `<div class="fl-item">📄 ${f}</div>`).join("");
      ortho.acqParams = d.acq_params;
      ortho.nVols     = d.n_vols;
      document.getElementById("vol-label").textContent =
        d.modality === "T1" ? "flip angle" : "TE";
      toast(`Loaded scan ${scan} · ${d.n_vols} ${d.label === "TE" ? "echoes" : "volumes"} · ${d.vox_str}`, "ok");
      await _doCheck();
    } catch(e) { toast(e.message, "error"); }
  }

  function closeBrukerModal(e) {
    if (e && e.target !== document.getElementById("bruker-modal")) return;
    document.getElementById("bruker-modal").classList.add("hidden");
  }

  /* ── Init ──────────────────────────────────────────────────────────── */
  setStep(1);
  setTool("T2");

  return {
    _sid, setTool,
    dzOver, dzLeave, dzDrop, onScanFiles, onSegFile,
    loadDemo,
    goToLoad, goToPreview, goToFit, goToOutput,
    runFit,
    download,
    _updateDerived,
    ortho, output,
    onBrukerZip, filterBruker, selectBrukerScan, closeBrukerModal,
    get _sid() { return _sid; },
  };
})();
