"""
Fit routes — T2 mono-exp and T1 VFA fitting with SSE progress, plus result retrieval.

T2 model and voxel fitter match t2_voxel_explorer.py exactly:
  - Model:    S(TE_s) = C + S0 * exp(-TE_s * R2)   (TE in seconds, R2 in s⁻¹)
  - T2 (ms):  1000 / R2
  - S0 bounds: adaptive per voxel (×1.05 to ×10 of first echo signal)
  - t2_good:  quality-filtered map requiring fit-R² ≥ 0.5
  - sigma:    MAD from background voxels (seg == 0), min 50 samples
"""
import asyncio, base64, json
from typing import Optional

import numpy as np
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from api.sessions import get_session

router = APIRouter()


# ─────────────────────────────── FitCfg (mirrors t2_voxel_explorer.py) ───────

class _FitCfg:
    RATIO_S0     = 1.25       # p0 multiplier for S0
    RATIO_S0_LB  = 1.05       # lower bound multiplier
    RATIO_S0_UB  = 10.0       # upper bound multiplier
    T2_INIT_MS   = 20.0
    T2_LB_MS     = 0.00001
    T2_UB_MS     = 4000.0
    R2_INIT      = 1000.0 / T2_INIT_MS   # 50 s⁻¹
    R2_LB        = 1000.0 / T2_UB_MS     # 0.25 s⁻¹
    R2_UB        = 1000.0 / T2_LB_MS     # 1e8 s⁻¹
    NOISE_INIT   = 1473.0
    LOW_THRESH_MS  = 0.0
    HIGH_THRESH_MS = 4000.0
    R2_FIT_THRESH  = 0.5      # fit-quality R² threshold for t2_good

FC = _FitCfg()


# ─────────────────────────────────────────────── T2 fitting ───────────────────

def _t2_model(TE_s, S0, R2, C):
    """S(TE_s) = C + S0 * exp(-TE_s * R2)  — matches model() in t2_voxel_explorer.py."""
    return C + S0 * np.exp(-TE_s * R2)


def _fit_t2_voxel(y_sig, TE_s, sigma_global=None, cfg=None):
    """
    Fit one T2 decay curve. Returns a result dict or None on failure.
    Matches fit_voxel() in t2_voxel_explorer.py exactly.
    Accepts optional cfg dict with user-supplied parameter overrides.
    """
    from scipy.optimize import curve_fit

    c = cfg or {}
    r_s0_init = float(c.get("s0_ratio_init", FC.RATIO_S0))
    r_s0_lb   = float(c.get("s0_ratio_lo",   FC.RATIO_S0_LB))
    r_s0_ub   = float(c.get("s0_ratio_hi",   FC.RATIO_S0_UB))
    t2_init   = float(c.get("t2_init",        FC.T2_INIT_MS))
    t2_lo     = float(c.get("t2_lo",          FC.T2_LB_MS))
    t2_hi     = float(c.get("t2_hi",          FC.T2_UB_MS))
    n_init_v  = float(c.get("noise_init",     FC.NOISE_INIT))

    r2_init = 1000.0 / t2_init if t2_init > 0 else FC.R2_INIT
    r2_lb   = 1000.0 / t2_hi   if t2_hi   > 0 else FC.R2_LB
    r2_ub   = 1000.0 / t2_lo   if t2_lo   > 0 else FC.R2_UB

    y_sig = np.asarray(y_sig, dtype=float)
    s1 = y_sig[0]
    if not np.isfinite(s1) or s1 <= 0:
        return None

    s0_lb  = s1 * r_s0_lb
    s0_ub  = s1 * r_s0_ub
    n_ub   = s0_ub
    n_init = min(n_init_v, n_ub * 0.99)

    p0    = [s1 * r_s0_init, r2_init, n_init]
    lower = [s0_lb, r2_lb, 0.0]
    upper = [s0_ub, r2_ub, n_ub]

    try:
        popt, _ = curve_fit(_t2_model, TE_s, y_sig, p0=p0,
                            bounds=(lower, upper), maxfev=5000)
    except (RuntimeError, ValueError):
        return None

    S0, R2_rate, C = popt
    t2   = 1000.0 / R2_rate          # ms
    pred  = _t2_model(TE_s, *popt)
    resid = y_sig - pred
    sse   = float(np.sum(resid ** 2))
    sst   = float(np.sum((y_sig - np.mean(y_sig)) ** 2))
    r2_fit = 1.0 - sse / sst if sst > 0 else np.nan   # fit quality R²
    rmse   = float(np.sqrt(sse / len(y_sig)))
    sigma2 = (sigma_global ** 2) if (sigma_global and sigma_global > 0) \
             else max(C * C, 1e-9)
    chi2   = sse / sigma2

    return dict(t2=t2, r2_fit=r2_fit, rmse=rmse, chi2=chi2,
                noise=float(C), s0=float(S0), R2_rate=float(R2_rate), pred=pred)


def _estimate_sigma_mad(stacked: np.ndarray, seg) -> Optional[float]:
    """
    MAD-based noise estimate from background voxels.
    Matches _estimate_sigma() in t2_voxel_explorer.py.
    """
    first = stacked[..., 0]
    bg = first[seg == 0] if seg is not None else first.ravel()
    bg = bg[np.isfinite(bg)]
    if bg.size < 50:
        return None
    med = np.median(bg)
    mad = np.median(np.abs(bg - med))
    return float(1.4826 * mad) if mad > 0 else float(np.std(bg))


# ─────────────────────────────────────────────── T1 VFA fitting ───────────────

def _fit_t1_voxel(signal, alphas_deg, tr_ms):
    """Fit S(α) = S0·sin(α)·(1−E1)/(1−cos(α)·E1), E1=exp(−TR/T1). Returns dict or None."""
    from scipy.optimize import curve_fit

    alphas = np.deg2rad(alphas_deg)
    signal = np.asarray(signal, dtype=float)
    s1 = signal.max()
    if not np.isfinite(s1) or s1 <= 0:
        return None

    def model(alpha, S0, T1):
        E1 = np.exp(-tr_ms / np.maximum(T1, 1.0))
        return S0 * np.sin(alpha) * (1 - E1) / (1 - np.cos(alpha) * E1)

    try:
        popt, _ = curve_fit(model, alphas, signal,
                            p0=[s1, 1000.0],
                            bounds=([0, 10.0], [s1 * 20, 5000.0]),
                            maxfev=5000)
    except (RuntimeError, ValueError):
        return None

    S0, T1 = popt
    pred  = model(alphas, *popt)
    resid = signal - pred
    sse   = float(np.sum(resid ** 2))
    sst   = float(np.sum((signal - np.mean(signal)) ** 2))
    r2_fit = 1.0 - sse / sst if sst > 0 else np.nan
    rmse   = float(np.sqrt(sse / len(signal)))
    return dict(t1=float(T1), r2_fit=r2_fit, rmse=rmse, s0=float(S0), pred=pred)


# ─────────────────────────────────────────────── async fit runner ─────────────

async def _run_fit(s, req):
    q = s._progress_q
    stacked = s.stacked
    X, Y, Z, nVol = stacked.shape
    modality = req.modality

    mask = (s.seg > 0) if s.seg is not None else (stacked[..., 0] > 0)
    xs, ys, zs = np.where(mask)
    total = len(xs)
    if total == 0:
        await q.put({"status": "error", "message": "Mask contains no voxels"})
        return

    # Sigma from background (MAD, matching explorer)
    s.sigma_global = _estimate_sigma_mad(stacked, s.seg)
    s.fit_config   = {"modality": modality, "tr_ms": s.tr_ms}
    s.fitting_done = False

    # Result maps
    param_map  = np.full((X, Y, Z), np.nan, dtype=np.float32)   # T2 or T1 (ms)
    good_map   = np.full((X, Y, Z), np.nan, dtype=np.float32)   # quality-filtered
    r2fit_map  = np.full((X, Y, Z), np.nan, dtype=np.float32)   # fit R²
    chi2_map   = np.full((X, Y, Z), np.nan, dtype=np.float32)
    noise_map  = np.full((X, Y, Z), np.nan, dtype=np.float32)
    rmse_map   = np.full((X, Y, Z), np.nan, dtype=np.float32)

    sigma = s.sigma_global
    batch = max(1, total // 200)

    # User-supplied parameter overrides (from frontend param table)
    up = req.params
    thresh_lo = float(up.get("thresh_lo",  FC.LOW_THRESH_MS))
    thresh_hi = float(up.get("thresh_hi",  FC.HIGH_THRESH_MS))
    r2_thresh = float(up.get("r2_thresh",  FC.R2_FIT_THRESH))

    if modality == "T2":
        TE_s = s.acq_params / 1000.0          # ms → seconds (critical)

        for i, (xi, yi, zi) in enumerate(zip(xs, ys, zs)):
            sig = stacked[xi, yi, zi, :].astype(float)
            res = _fit_t2_voxel(sig, TE_s, sigma, cfg=up)

            if res is not None:
                t2 = res["t2"]
                rmse_map[xi, yi, zi]  = res["rmse"]
                r2fit_map[xi, yi, zi] = res["r2_fit"]
                chi2_map[xi, yi, zi]  = res["chi2"]
                noise_map[xi, yi, zi] = res["noise"]
                if thresh_lo < t2 < thresh_hi:
                    param_map[xi, yi, zi] = t2
                    if np.isfinite(res["r2_fit"]) and res["r2_fit"] >= r2_thresh:
                        good_map[xi, yi, zi] = t2

            if i % batch == 0 or i == total - 1:
                pct = int(100 * (i + 1) / total)
                await q.put({"status": "progress", "pct": pct,
                             "done": i + 1, "total": total})
                await asyncio.sleep(0)

    else:  # T1 VFA
        tr = req.tr_ms or s.tr_ms or 15.0
        s.tr_ms = tr

        for i, (xi, yi, zi) in enumerate(zip(xs, ys, zs)):
            sig = stacked[xi, yi, zi, :].astype(float)
            res = _fit_t1_voxel(sig, s.acq_params, tr)

            if res is not None:
                t1 = res["t1"]
                rmse_map[xi, yi, zi]  = res["rmse"]
                r2fit_map[xi, yi, zi] = res["r2_fit"]
                if 10.0 < t1 < 5000.0:
                    param_map[xi, yi, zi] = t1
                    if np.isfinite(res["r2_fit"]) and res["r2_fit"] >= r2_thresh:
                        good_map[xi, yi, zi] = t1

            if i % batch == 0 or i == total - 1:
                pct = int(100 * (i + 1) / total)
                await q.put({"status": "progress", "pct": pct,
                             "done": i + 1, "total": total})
                await asyncio.sleep(0)

    s.param_map    = param_map     # all valid T2/T1 within threshold
    s.good_map     = good_map      # quality-filtered (fit-R² ≥ 0.5)
    s.r2_map       = r2fit_map     # fit quality R²
    s.chi2_map     = chi2_map
    s.noise_map    = noise_map
    s.rmse_map     = rmse_map
    s.fitting_done = True
    s.modality     = modality

    await q.put({"status": "done"})


# ─────────────────────────────────────────────── pydantic model ───────────────

class FitRequest(BaseModel):
    modality: str = "T2"
    tr_ms: Optional[float] = None
    params: dict = {}


# ─────────────────────────────────────────────── endpoints ────────────────────

@router.post("/{sid}/run")
async def run_fit(sid: str, req: FitRequest):
    s = get_session(sid)
    if not s:
        raise HTTPException(404, "Session not found")
    if s.stacked is None:
        raise HTTPException(400, "No scan loaded")
    s._progress_q = asyncio.Queue()
    asyncio.create_task(_run_fit(s, req))
    return {"started": True}


@router.get("/{sid}/progress")
async def fit_progress(sid: str):
    """SSE stream: data: {status, pct?, done?, total?, message?}"""
    s = get_session(sid)
    if not s:
        raise HTTPException(404, "Session not found")

    async def _generate():
        if s._progress_q is None:
            yield f"data: {json.dumps({'status':'error','message':'No fit running'})}\n\n"
            return
        while True:
            try:
                msg = await asyncio.wait_for(s._progress_q.get(), timeout=30.0)
            except asyncio.TimeoutError:
                yield f"data: {json.dumps({'status':'heartbeat'})}\n\n"
                continue
            yield f"data: {json.dumps(msg)}\n\n"
            if msg.get("status") in ("done", "error"):
                break

    return StreamingResponse(_generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


@router.get("/{sid}/result")
async def fit_result(sid: str, slice_idx: int = -1, use_all: bool = False):
    s = get_session(sid)
    if not s or not s.fitting_done:
        raise HTTPException(404, "Fit not done")

    # use_all=True → show param_map (all within threshold); False → quality-filtered good_map
    if use_all and s.param_map is not None:
        pm = s.param_map
    else:
        pm = s.good_map if hasattr(s, "good_map") and s.good_map is not None else s.param_map
    X, Y, Z = pm.shape
    z = int(np.clip(slice_idx if slice_idx >= 0 else Z // 2, 0, Z - 1))

    sl      = pm[:, :, z].T.astype(np.float32)        # (Y, X) row-major
    sl_b64  = base64.b64encode(sl.tobytes()).decode()

    rmse_sl  = s.rmse_map[:, :, z].T.astype(np.float32)
    rmse_b64 = base64.b64encode(rmse_sl.tobytes()).decode()

    finite_vals = pm[np.isfinite(pm)]
    label = "T2" if s.modality == "T2" else "T1"
    stats = {}
    if len(finite_vals) > 0:
        stats = {
            "median": float(np.nanmedian(finite_vals)),
            "mean":   float(np.nanmean(finite_vals)),
            "std":    float(np.nanstd(finite_vals)),
            "p25":    float(np.nanpercentile(finite_vals, 25)),
            "p75":    float(np.nanpercentile(finite_vals, 75)),
            "n_vox":  int(np.sum(np.isfinite(finite_vals))),
        }

    hist_counts, hist_edges = [], []
    if len(finite_vals) > 0:
        lo2, hi2 = np.nanpercentile(finite_vals, 2), np.nanpercentile(finite_vals, 98)
        counts, edges = np.histogram(finite_vals, bins=100, range=(lo2, hi2))
        hist_counts = counts.tolist()
        hist_edges  = edges.tolist()

    # Median decay/VFA curve over ROI voxels (matches _draw_fit in explorer)
    decay_curve = []
    decay_p25, decay_p75 = [], []
    if s.stacked is not None:
        roi_mask = (s.seg > 0) if s.seg is not None else np.isfinite(pm)
        roi_vox  = s.stacked[roi_mask, :]
        if roi_vox.size > 0:
            decay_curve = np.nanmedian(roi_vox, axis=0).tolist()
            decay_p25   = np.nanpercentile(roi_vox, 25, axis=0).tolist()
            decay_p75   = np.nanpercentile(roi_vox, 75, axis=0).tolist()

    vmin = float(np.nanpercentile(finite_vals, 2))  if len(finite_vals) else 0.0
    vmax = float(np.nanpercentile(finite_vals, 98)) if len(finite_vals) else 1.0

    # Anatomy reference slice (first echo/volume, normalised to uint8 for overlay)
    anat_b64 = None
    if s.stacked is not None and s.stacked.ndim == 4:
        anat_sl = s.stacked[:, :, z, 0].T.astype(np.float32)   # (Y, X)
        p1  = float(np.nanpercentile(anat_sl, 1))
        p99 = float(np.nanpercentile(anat_sl, 99))
        anat_norm = np.clip((anat_sl - p1) / (p99 - p1 + 1e-9), 0, 1)
        anat_u8 = (anat_norm * 255).astype(np.uint8)
        anat_b64 = base64.b64encode(anat_u8.tobytes()).decode()

    # Orientation labels from affine (axis codes for columns/rows)
    def _opp(c): return {'R':'L','L':'R','A':'P','P':'A','S':'I','I':'S'}.get(c,'?')
    orient = {"right":"?","left":"?","top":"?","bottom":"?"}
    voxel_mm = [1.0, 1.0]
    if s.affine is not None:
        aff = s.affine
        # Column direction (left→right in display) = first voxel axis
        col_dir = aff[:3, 0]
        row_dir = aff[:3, 1]
        _dirs = ['R','A','S']
        def _code(v):
            idx = int(np.argmax(np.abs(v)))
            return _dirs[idx] if v[idx] > 0 else _opp(_dirs[idx])
        col_code = _code(col_dir)
        row_code = _code(row_dir)
        # Row increases downward on screen → bottom = row_code direction
        orient = {
            "right":  col_code,
            "left":   _opp(col_code),
            "bottom": row_code,
            "top":    _opp(row_code),
        }
        voxel_mm = [float(np.linalg.norm(aff[:3, 0])),
                    float(np.linalg.norm(aff[:3, 1]))]

    return {
        "label":       label,
        "unit":        "ms",
        "shape":       [Y, X],
        "z":           z,
        "n_slices":    Z,
        "map_b64":     sl_b64,
        "rmse_b64":    rmse_b64,
        "vmin":        vmin,
        "vmax":        vmax,
        "stats":       stats,
        "hist_counts": hist_counts,
        "hist_edges":  hist_edges,
        "acq_params":   s.acq_params.tolist(),
        "decay_curve":  decay_curve,
        "decay_p25":    decay_p25,
        "decay_p75":    decay_p75,
        "sigma_global": s.sigma_global,
        "anat_b64":     anat_b64,
        "orient":       orient,
        "voxel_mm":     voxel_mm,
    }


# ─────────────────────────────── per-voxel exploration ────────────────────────

@router.get("/{sid}/voxel")
async def get_voxel(sid: str, x: int = 0, y: int = 0, z: int = 0):
    """Return raw signal + recomputed fit for a single voxel."""
    s = get_session(sid)
    if not s or not s.fitting_done or s.stacked is None:
        raise HTTPException(404, "Fit not done")

    X_dim, Y_dim, Z_dim = s.stacked.shape[:3]
    xi = int(np.clip(x, 0, X_dim - 1))
    yi = int(np.clip(y, 0, Y_dim - 1))
    zi = int(np.clip(z, 0, Z_dim - 1))

    signal   = s.stacked[xi, yi, zi, :].astype(float).tolist()
    t2_val   = float(s.param_map[xi, yi, zi]) if s.param_map is not None else np.nan
    r2_val   = float(s.r2_map[xi, yi, zi])   if s.r2_map   is not None else np.nan
    rmse_val = float(s.rmse_map[xi, yi, zi]) if s.rmse_map is not None else np.nan

    fitted, residuals = [], []
    if s.modality == "T2" and s.acq_params is not None:
        TE_s = s.acq_params / 1000.0
        res  = _fit_t2_voxel(np.array(signal), TE_s, s.sigma_global)
        if res and res.get("pred") is not None:
            fitted    = res["pred"].tolist()
            residuals = (np.array(signal) - res["pred"]).tolist()
            t2_val    = res["t2"]
            r2_val    = res["r2_fit"]
            rmse_val  = res["rmse"]
    elif s.modality == "T1" and s.acq_params is not None and s.tr_ms:
        res = _fit_t1_voxel(np.array(signal), s.acq_params, s.tr_ms)
        if res and res.get("pred") is not None:
            fitted    = res["pred"].tolist()
            residuals = (np.array(signal) - res["pred"]).tolist()

    return {
        "x": xi, "y": yi, "z": zi,
        "signal":     signal,
        "fitted":     fitted,
        "residuals":  residuals,
        "acq_params": s.acq_params.tolist() if s.acq_params is not None else [],
        "t2":         float(t2_val),
        "r2_fit":     float(r2_val),
        "rmse":       float(rmse_val),
        "modality":   s.modality,
    }


@router.get("/{sid}/scatter")
async def get_scatter(sid: str):
    """Return all quality-filtered voxels with T2/T1 values for scatter plot."""
    s = get_session(sid)
    if not s or not s.fitting_done:
        raise HTTPException(404, "Fit not done")

    pm = s.good_map if (s.good_map is not None) else s.param_map
    if pm is None:
        return {"voxels": [], "median": None, "n": 0}

    mask = (s.seg > 0) if s.seg is not None else np.ones(pm.shape[:3], dtype=bool)
    xs, ys, zs = np.where(mask & np.isfinite(pm))

    voxels = []
    for i, (xi, yi, zi) in enumerate(zip(xs.tolist(), ys.tolist(), zs.tolist())):
        r2f = float(s.r2_map[xi, yi, zi]) if s.r2_map is not None else 1.0
        voxels.append({
            "idx":    i,
            "x":      int(xi),
            "y":      int(yi),
            "z":      int(zi),
            "t2":     float(pm[xi, yi, zi]),
            "r2_fit": r2f,
        })

    vals   = [v["t2"] for v in voxels]
    median = float(np.median(vals)) if vals else None
    return {"voxels": voxels, "median": median, "n": len(voxels)}
