"""
Vectorized batch fitting engine — replaces the per-voxel scipy.optimize.curve_fit
loop that used to drive api/fit_routes.py's bulk volume fit with a variable-
projection (VARPRO) solve across the whole volume at once.

Both models here are linear in some parameters and nonlinear in exactly one
(R2 for T2, T1 for T1 VFA). VARPRO exploits that: for any *trial* value of the
nonlinear parameter, the linear parameters (S0, and C for T2) have a closed-form
least-squares solution — so the search reduces to 1-D minimization of the
projected residual over the nonlinear parameter, done independently but
simultaneously for every voxel via numpy broadcasting.

Compared to one scipy.optimize.curve_fit call per voxel (which dominates
runtime for realistic volumes — 100k+ individual bounded nonlinear solves,
each with Python/SciPy call overhead for a 3-parameter, <=12-point problem),
this does a small, fixed number of whole-volume vectorized passes: a coarse
log-spaced grid scan to bracket the global optimum per voxel, followed by
golden-section refinement within that bracket. No Jacobians, no per-voxel
Python-level work — the inner loop is over grid points (hundreds), not voxels
(often hundreds of thousands).

Bounded search means every masked voxel gets *some* in-range value — unlike
a closed-form linear (DESPOT1-style) fit, there's no hard rejection gate, so
coverage is always complete; per-voxel fit quality is reported separately via
R²/chi2 rather than by leaving low-confidence voxels blank.

Single-voxel recomputation (api/fit_routes.py's get_voxel endpoint) still uses
the original scipy-based _fit_t2_voxel/_fit_t1_voxel — that path only ever
fits one voxel at a time, so it was never the bottleneck.
"""
import numpy as np

_GOLDEN_INVPHI = (np.sqrt(5.0) - 1.0) / 2.0


def _golden_refine(objective, lo: np.ndarray, hi: np.ndarray, n_iter: int) -> np.ndarray:
    """Vectorized golden-section search minimizing `objective(x) -> sse (N,)`
    independently per voxel within [lo, hi] (both shape (N,))."""
    a, b = lo.copy(), hi.copy()
    for _ in range(n_iter):
        c = b - _GOLDEN_INVPHI * (b - a)
        d = a + _GOLDEN_INVPHI * (b - a)
        fc = objective(c)
        fd = objective(d)
        go_left = fc < fd
        b = np.where(go_left, d, b)
        a = np.where(go_left, a, c)
    return (a + b) / 2.0


# ─────────────────────────────────────────────── T2: S = C + S0*exp(-R2*TE) ───

def _project_t2(R2, Y: np.ndarray, TE_s: np.ndarray, Sy: np.ndarray):
    """Closed-form (S0, C) least-squares projection for trial R2 value(s).

    R2: python float (one value shared by every voxel — grid stage) or ndarray
        shape (N,) (one value per voxel — refinement stage).
    Y: (N, nEcho). TE_s: (nEcho,). Sy: (N,) row sums of Y, precomputed once.
    Returns S0, C, sse — each broadcast to shape (N,).
    """
    if np.isscalar(R2):
        b1 = np.exp(-R2 * TE_s)[None, :]                       # (1, nEcho)
    else:
        b1 = np.exp(-np.asarray(R2)[:, None] * TE_s[None, :])  # (N, nEcho)
    n = TE_s.shape[0]
    Sb1b1 = np.sum(b1 * b1, axis=1)
    Sb1   = np.sum(b1, axis=1)
    Sb1y  = np.sum(b1 * Y, axis=1)
    det   = Sb1b1 * n - Sb1 ** 2
    det   = np.where(np.abs(det) < 1e-30, 1e-30, det)
    S0 = (Sb1y * n - Sb1 * Sy) / det
    C  = (Sb1b1 * Sy - Sb1 * Sb1y) / det
    pred = S0[:, None] * b1 + C[:, None]
    sse  = np.sum((Y - pred) ** 2, axis=1)
    return S0, C, sse


def fit_t2_batch(Y: np.ndarray, TE_s: np.ndarray, sigma_global, cfg: dict,
                  n_grid: int = 220, n_refine: int = 25) -> dict:
    """
    Vectorized VARPRO fit of S(TE) = C + S0*exp(-R2*TE) across every row of Y.
    Y: (N, nEcho) raw signal, one row per voxel. TE_s: (nEcho,) echo times, seconds.
    Returns a dict of (N,) float64 arrays: t2, r2_fit, rmse, chi2, noise, s0, R2_rate.
    Invalid voxels (non-finite or non-positive first echo) get NaN everywhere,
    matching the old per-voxel fitter's "return None" behavior.
    """
    c = cfg or {}
    r_s0_lb = float(c.get("s0_ratio_lo", 1.05))
    r_s0_ub = float(c.get("s0_ratio_hi", 10.0))
    t2_lo   = float(c.get("t2_lo", 0.00001))
    t2_hi   = float(c.get("t2_hi", 4000.0))
    r2_lb   = 1000.0 / t2_hi if t2_hi > 0 else 0.25
    r2_ub   = 1000.0 / t2_lo if t2_lo > 0 else 1e8

    N, n = Y.shape
    s1 = Y[:, 0]
    valid = np.isfinite(s1) & (s1 > 0)

    out = {k: np.full(N, np.nan, dtype=np.float64)
           for k in ("t2", "r2_fit", "rmse", "chi2", "noise", "s0", "R2_rate")}
    if not np.any(valid):
        return out

    Yv  = Y[valid]
    s1v = s1[valid]
    Sy  = np.sum(Yv, axis=1)

    # ── stage 1: coarse log-spaced grid to bracket the global optimum per voxel ──
    grid = np.geomspace(r2_lb, r2_ub, n_grid)
    best_sse = np.full(Yv.shape[0], np.inf)
    best_idx = np.zeros(Yv.shape[0], dtype=np.int64)
    for gi in range(n_grid):
        _, _, sse = _project_t2(float(grid[gi]), Yv, TE_s, Sy)
        better = sse < best_sse
        best_sse = np.where(better, sse, best_sse)
        best_idx = np.where(better, gi, best_idx)

    idx_lo = np.clip(best_idx - 1, 0, n_grid - 1)
    idx_hi = np.clip(best_idx + 1, 0, n_grid - 1)
    lo, hi = grid[idx_lo], grid[idx_hi]

    # ── stage 2: golden-section refine within that bracket ──────────────────────
    def objective(r2):
        _, _, sse = _project_t2(r2, Yv, TE_s, Sy)
        return sse

    R2 = _golden_refine(objective, lo, hi, n_refine)
    S0, C, _ = _project_t2(R2, Yv, TE_s, Sy)

    # ── bounds clipping (matches the old per-voxel bounded fit's S0/C bounds) ───
    s0_lb, s0_ub = s1v * r_s0_lb, s1v * r_s0_ub
    S0c = np.clip(S0, s0_lb, s0_ub)
    Cc  = np.clip(C, 0.0, s0_ub)
    b1  = np.exp(-R2[:, None] * TE_s[None, :])
    pred  = S0c[:, None] * b1 + Cc[:, None]
    sse_c = np.sum((Yv - pred) ** 2, axis=1)

    t2   = 1000.0 / R2
    rmse = np.sqrt(sse_c / n)
    sst  = np.sum((Yv - Yv.mean(axis=1, keepdims=True)) ** 2, axis=1)
    r2_fit = np.where(sst > 0, 1.0 - sse_c / sst, np.nan)
    sigma2 = (sigma_global ** 2) if (sigma_global and sigma_global > 0) else np.maximum(Cc ** 2, 1e-9)
    chi2 = sse_c / sigma2

    idx = np.where(valid)[0]
    out["t2"][idx]      = t2
    out["r2_fit"][idx]  = r2_fit
    out["rmse"][idx]    = rmse
    out["chi2"][idx]    = chi2
    out["noise"][idx]   = Cc
    out["s0"][idx]      = S0c
    out["R2_rate"][idx] = R2
    return out


# ── T1 VFA: S(alpha) = S0*sin(alpha)*(1-E1)/(1-cos(alpha)*E1), E1=exp(-TR/T1) ─

def fit_t1_batch(Y: np.ndarray, alphas_deg: np.ndarray, tr_ms: float,
                  n_grid: int = 150, n_refine: int = 25) -> dict:
    """
    Vectorized VARPRO fit of the VFA T1 model across every row of Y.
    Y: (N, nAlpha). Returns dict of (N,) float64 arrays: t1, r2_fit, rmse, s0.
    """
    alphas = np.deg2rad(np.asarray(alphas_deg, dtype=np.float64))
    N, n = Y.shape
    s1 = np.nanmax(Y, axis=1)
    valid = np.isfinite(s1) & (s1 > 0)

    out = {k: np.full(N, np.nan, dtype=np.float64) for k in ("t1", "r2_fit", "rmse", "s0")}
    if not np.any(valid):
        return out

    Yv = Y[valid]
    s1v = s1[valid]

    def project(T1):
        if np.isscalar(T1):
            E1 = np.exp(-tr_ms / max(T1, 1.0))
            b1 = (np.sin(alphas) * (1 - E1) / (1 - np.cos(alphas) * E1))[None, :]
        else:
            T1c = np.maximum(np.asarray(T1), 1.0)
            E1 = np.exp(-tr_ms / T1c)[:, None]
            b1 = np.sin(alphas)[None, :] * (1 - E1) / (1 - np.cos(alphas)[None, :] * E1)
        Sb1b1 = np.sum(b1 * b1, axis=1)
        Sb1b1 = np.where(Sb1b1 < 1e-30, 1e-30, Sb1b1)
        Sb1y  = np.sum(b1 * Yv, axis=1)
        S0 = Sb1y / Sb1b1
        pred = S0[:, None] * b1
        sse = np.sum((Yv - pred) ** 2, axis=1)
        return S0, sse

    grid = np.geomspace(10.0, 5000.0, n_grid)
    best_sse = np.full(Yv.shape[0], np.inf)
    best_idx = np.zeros(Yv.shape[0], dtype=np.int64)
    for gi in range(n_grid):
        _, sse = project(float(grid[gi]))
        better = sse < best_sse
        best_sse = np.where(better, sse, best_sse)
        best_idx = np.where(better, gi, best_idx)

    idx_lo = np.clip(best_idx - 1, 0, n_grid - 1)
    idx_hi = np.clip(best_idx + 1, 0, n_grid - 1)
    lo, hi = grid[idx_lo], grid[idx_hi]

    def objective(t1):
        _, sse = project(t1)
        return sse

    T1 = _golden_refine(objective, lo, hi, n_refine)
    S0, _ = project(T1)

    s0_ub = s1v * 20.0
    S0c = np.clip(S0, 0.0, s0_ub)
    T1c = np.maximum(T1, 1.0)
    E1 = np.exp(-tr_ms / T1c)[:, None]
    b1 = np.sin(alphas)[None, :] * (1 - E1) / (1 - np.cos(alphas)[None, :] * E1)
    pred = S0c[:, None] * b1
    sse_c = np.sum((Yv - pred) ** 2, axis=1)

    rmse = np.sqrt(sse_c / n)
    sst  = np.sum((Yv - Yv.mean(axis=1, keepdims=True)) ** 2, axis=1)
    r2_fit = np.where(sst > 0, 1.0 - sse_c / sst, np.nan)

    idx = np.where(valid)[0]
    out["t1"][idx]     = T1
    out["r2_fit"][idx] = r2_fit
    out["rmse"][idx]   = rmse
    out["s0"][idx]     = S0c
    return out
