"""
Output routes — NIfTI map download, CSV stats, NPZ archive, and a self-contained
HTML analysis report (styled after the "T2 Mapping Analysis Report" doc-page
template: title page, TOC, per-ROI tables, SVG charts, and embedded map images).
"""
import base64, csv, datetime, html as html_mod, io, os
from typing import Optional

import numpy as np
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from api.sessions import get_session
from api.fit_routes import FC, _fit_t1_voxel, _fit_t2_voxel
from api.load_routes import _bruker_param

router = APIRouter()


# ─────────────────────────────────────────────── helpers ──────────────────────

def _require_fit(sid: str):
    s = get_session(sid)
    if not s:
        raise HTTPException(404, "Session not found")
    if not s.fitting_done or s.param_map is None:
        raise HTTPException(400, "Fitting not complete")
    return s


def _roi_stats_mask(s, mask: np.ndarray) -> dict:
    """Quality-filtered param-map stats restricted to an arbitrary boolean mask."""
    pm = s.good_map if (hasattr(s, "good_map") and s.good_map is not None) else s.param_map
    vals = pm[mask][np.isfinite(pm[mask])]
    if len(vals) == 0:
        return {}
    return {
        "label":  "T2_ms" if s.modality == "T2" else "T1_ms",
        "n_vox":  int(len(vals)),
        "mean":   float(np.mean(vals)),
        "median": float(np.median(vals)),
        "std":    float(np.std(vals)),
        "p25":    float(np.percentile(vals, 25)),
        "p75":    float(np.percentile(vals, 75)),
        "min":    float(np.min(vals)),
        "max":    float(np.max(vals)),
    }


def _roi_stats(s) -> dict:
    mask = (s.seg > 0) if s.seg is not None else np.ones(s.param_map.shape, dtype=bool)
    return _roi_stats_mask(s, mask)


# ─────────────────────────────────────────────── endpoints ────────────────────

@router.get("/{sid}/map.nii.gz")
async def download_map(sid: str):
    import nibabel as nib, gzip, tempfile
    s = _require_fit(sid)
    img = nib.Nifti1Image(s.param_map, s.affine if s.affine is not None else np.eye(4))
    # nib.save() needs a real filesystem path, not a BytesIO — it calls
    # pathlib.Path(filename) internally, which raises TypeError on a buffer.
    with tempfile.NamedTemporaryFile(suffix=".nii") as tmp:
        nib.save(img, tmp.name)
        tmp.seek(0)
        raw = tmp.read()
    gz_buf = io.BytesIO()
    with gzip.GzipFile(fileobj=gz_buf, mode="wb") as gz:
        gz.write(raw)
    fname = f"{s.modality.lower()}_map.nii.gz"
    return Response(content=gz_buf.getvalue(), media_type="application/gzip",
                    headers={"Content-Disposition": f'attachment; filename="{fname}"'})


@router.get("/{sid}/stats.csv")
async def download_stats(sid: str):
    s = _require_fit(sid)
    st = _roi_stats(s)
    if not st:
        raise HTTPException(400, "No ROI statistics available")
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Statistic", "Value", "Unit"])
    w.writerow(["Modality", s.modality, ""])
    w.writerow(["N_voxels", st["n_vox"], ""])
    w.writerow(["Mean",     f"{st['mean']:.2f}",   "ms"])
    w.writerow(["Median",   f"{st['median']:.2f}",  "ms"])
    w.writerow(["Std",      f"{st['std']:.2f}",    "ms"])
    w.writerow(["P25",      f"{st['p25']:.2f}",    "ms"])
    w.writerow(["P75",      f"{st['p75']:.2f}",    "ms"])
    w.writerow(["Min",      f"{st['min']:.2f}",    "ms"])
    w.writerow(["Max",      f"{st['max']:.2f}",    "ms"])
    if s.acq_params is not None:
        acq_label = "TE_ms" if s.modality == "T2" else "FlipAngle_deg"
        w.writerow([acq_label, ";".join(f"{v:.1f}" for v in s.acq_params), ""])
    if s.tr_ms:
        w.writerow(["TR_ms", f"{s.tr_ms:.1f}", "ms"])
    return Response(content=buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{s.modality.lower()}_stats.csv"'})


@router.get("/{sid}/voxels.npz")
async def download_voxels(sid: str):
    s = _require_fit(sid)
    label = "T2_ms" if s.modality == "T2" else "T1_ms"
    arrays = {}
    if s.stacked is not None:
        arrays["data"] = s.stacked.astype(np.float32)
    if s.acq_params is not None:
        arrays["TE"] = s.acq_params.astype(np.float32)
    if s.tr_ms is not None:
        arrays["TR_ms"] = np.float32(s.tr_ms)
    arrays["mask"] = (s.seg > 0).astype(np.uint8) if s.seg is not None \
                     else np.ones(s.param_map.shape, dtype=np.uint8)
    arrays[label]      = s.param_map.astype(np.float32)
    arrays["r2_fit"]   = s.r2_map.astype(np.float32)  if s.r2_map  is not None else np.full(s.param_map.shape, np.nan, np.float32)
    arrays["rmse"]     = s.rmse_map.astype(np.float32) if s.rmse_map is not None else np.full(s.param_map.shape, np.nan, np.float32)
    arrays["good_fit"] = np.isfinite(s.good_map).astype(np.uint8) if s.good_map is not None \
                         else np.isfinite(s.param_map).astype(np.uint8)
    if s.affine is not None:
        arrays["affine"] = s.affine.astype(np.float64)
    arrays["modality"] = np.bytes_(s.modality)
    buf = io.BytesIO()
    np.savez_compressed(buf, **arrays)
    fname = f"{s.modality.lower()}_data.npz"
    return Response(content=buf.getvalue(), media_type="application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{fname}"'})


# ─────────────────────────────── report data helpers ───────────────────────────

def _esc(x) -> str:
    return html_mod.escape(str(x))


def _fmt_thousands(n) -> str:
    return f"{n:,.0f}".replace(",", " ")


def _pct_str(n: int, total: int) -> str:
    return f"{n:,}  ({100 * n / total:.1f}%)" if total else "—"


def _med_str(fit: dict, decimals: int = 1) -> str:
    return f"{fit['median']:.{decimals}f}" if fit else "—"


def _iqr_str(fit: dict, decimals: int = 1) -> str:
    return f"{fit['p75'] - fit['p25']:.{decimals}f}" if fit else "—"


def _signal_stats_mask(s, mask: np.ndarray) -> Optional[dict]:
    if s.stacked is None or not mask.any():
        return None
    vals = s.stacked[..., 0][mask]
    vals = vals[np.isfinite(vals)]
    if vals.size == 0:
        return None
    return {"mean": float(np.mean(vals)), "median": float(np.median(vals)), "n": int(vals.size)}


def _map_median_iqr(map_: Optional[np.ndarray], mask: np.ndarray) -> Optional[dict]:
    if map_ is None:
        return None
    vals = map_[mask]
    vals = vals[np.isfinite(vals)]
    if vals.size == 0:
        return None
    return {"median": float(np.median(vals)),
            "iqr":    float(np.percentile(vals, 75) - np.percentile(vals, 25))}


def _exclusion_mask(s, mask: np.ndarray) -> Optional[dict]:
    total = int(mask.sum())
    if total == 0:
        return None
    n_good        = int(np.isfinite(s.good_map[mask]).sum())  if s.good_map  is not None else 0
    n_fit_failed  = total - int(np.isfinite(s.param_map[mask]).sum())
    return {"total": total, "n_good": n_good, "n_excluded": total - n_good, "n_fit_failed": n_fit_failed}


def _acq_str(acq: Optional[np.ndarray]) -> str:
    if acq is None or len(acq) == 0:
        return "—"
    vals = [f"{v:.0f}" for v in acq]
    if len(vals) > 6:
        diffs = np.diff(acq)
        if np.allclose(diffs, diffs[0], atol=0.05):
            return f"{vals[0]}, {vals[1]}, {vals[2]}, … {vals[-1]}  (Δ{diffs[0]:.0f})"
    return ", ".join(vals)


def _duration_str(tr_ms: Optional[float], n_slices: int) -> str:
    if not tr_ms:
        return "—"
    total_s = tr_ms * n_slices / 1000.0
    h, rem = divmod(int(total_s), 3600)
    m, sec = divmod(rem, 60)
    return f"{h}h{m:02d}m{sec:02d}s ({total_s:.0f} s)"


def _bruker_scan_meta(s) -> dict:
    """Best-effort scan title / series number / scan date from the Bruker acqp/method files."""
    meta = {"scan_title": "—", "series_num": "—", "scan_date": "—", "method": "—"}
    bsd = getattr(s, "bruker_study_dir", None)
    if not bsd or not os.path.isdir(bsd):
        return meta
    try:
        for d in sorted(os.listdir(bsd)):
            scan_dir = os.path.join(bsd, d)
            acqp_path = os.path.join(scan_dir, "acqp")
            if not os.path.isfile(acqp_path):
                continue
            acqp_txt = open(acqp_path, errors="ignore").read()
            name_toks = _bruker_param(acqp_txt, "ACQ_scan_name")
            if name_toks:
                meta["scan_title"] = " ".join(name_toks)
            time_toks = _bruker_param(acqp_txt, "ACQ_abs_time")
            if time_toks:
                try:
                    meta["scan_date"] = datetime.datetime.fromtimestamp(
                        int(float(time_toks[0]))).strftime("%d %b %Y")
                except (ValueError, OSError):
                    pass
            method_path = os.path.join(scan_dir, "method")
            if os.path.isfile(method_path):
                method_txt = open(method_path, errors="ignore").read()
                m_toks = _bruker_param(method_txt, "Method")
                if m_toks:
                    meta["method"] = m_toks[0]
            meta["series_num"] = d
            break
    except OSError:
        pass
    return meta


def _hist_mask(s, mask: np.ndarray, nbins: int = 14) -> Optional[dict]:
    if s.good_map is None:
        return None
    vals = s.good_map[mask]
    vals = vals[np.isfinite(vals)]
    if vals.size == 0:
        return None
    lo, hi = float(np.nanpercentile(vals, 2)), float(np.nanpercentile(vals, 98))
    if hi <= lo:
        hi = lo + 1.0
    counts, edges = np.histogram(vals, bins=nbins, range=(lo, hi))
    return {"edges": edges.tolist(), "counts": counts.tolist(), "median": float(np.median(vals))}


_GROUP_PALETTE = [("#7c2d84", "#f3e8f5"), ("#1f5a7a", "#e4eef4"),
                  ("#166534", "#e3f5ea"), ("#92400e", "#fdf1e3")]


def _build_report_data(
    s,
    repro_label: int = 1,
    muscle_label: int = 2,
    repro_name: str = "Reproductive tract",
    muscle_name: str = "Skeletal muscle",
    mouse_id: Optional[str] = None,
    study_group: Optional[str] = None,
    study_id: Optional[str] = None,
    institution: Optional[str] = "University of Illinois Urbana-Champaign",
    facility: Optional[str] = None,
    scanner: Optional[str] = None,
    software: Optional[str] = None,
    pipeline_version: str = "relaxometry_lab v1.0",
) -> tuple:
    """
    Computes the real-data tables/metrics for the report plus a `ctx` dict of
    raw arrays/coordinates (masks, representative voxels, overlay range) that
    the HTML/SVG/image renderer needs but that aren't themselves table rows.
    """
    lbl, unit = s.modality, "ms"
    X, Y, Z = s.param_map.shape
    n_vols = s.stacked.shape[3] if s.stacked is not None else 0
    vox_mm = (np.sqrt(np.sum(s.affine[:3, :3] ** 2, axis=0))
              if s.affine is not None else np.array([1.0, 1.0, 1.0]))

    has_seg     = s.seg is not None
    repro_mask  = (s.seg == repro_label)  if has_seg else np.ones((X, Y, Z), dtype=bool)
    muscle_mask = (s.seg == muscle_label) if has_seg else np.zeros((X, Y, Z), dtype=bool)
    noise_mask  = (s.seg == 0)            if has_seg else np.zeros((X, Y, Z), dtype=bool)

    repro_fit  = _roi_stats_mask(s, repro_mask)
    muscle_fit = _roi_stats_mask(s, muscle_mask)
    repro_sig  = _signal_stats_mask(s, repro_mask)
    muscle_sig = _signal_stats_mask(s, muscle_mask)
    sigma      = s.sigma_global

    def snr(sig_stats, key):
        return f"{sig_stats[key] / sigma:.1f}" if (sig_stats and sigma) else "—"

    # ── 1. Scan & session metadata ─────────────────────────────────────────
    meta = _bruker_scan_meta(s)
    sequence_str = f"Bruker:{meta['method']}" if meta["method"] != "—" else \
        f"{lbl} ({(getattr(s, 'input_type', None) or '—').upper()})"

    session_rows = [
        {"label": "Series number",              "value": meta["series_num"], "unit": ""},
        {"label": "Scan title / description",   "value": meta["scan_title"], "unit": ""},
        {"label": "Sequence / method",           "value": sequence_str,      "unit": ""},
        {"label": "Slice thickness",             "value": f"{vox_mm[2]:.3f}", "unit": "mm"},
        {"label": "In-plane pixel spacing",      "value": f"{vox_mm[0]:.3f} × {vox_mm[1]:.3f}", "unit": "mm"},
        {"label": "Number of slices",            "value": str(Z), "unit": ""},
        {"label": "Number of frames (echoes)",   "value": str(n_vols), "unit": ""},
        {"label": "Repetition time (TR)",        "value": f"{s.tr_ms:.0f}" if s.tr_ms else "—", "unit": "ms"},
        {"label": "Number of echoes",            "value": str(n_vols), "unit": ""},
        {"label": "Echo times (TE)" if lbl == "T2" else "Flip angles",
         "value": _acq_str(s.acq_params), "unit": "ms" if lbl == "T2" else "deg"},
        {"label": "Acquisition duration",        "value": _duration_str(s.tr_ms, Z), "unit": ""},
        {"label": "Scan date / time",            "value": meta["scan_date"], "unit": ""},
        {"label": "Mouse ID",                    "value": mouse_id or "—", "unit": ""},
        {"label": "Study group",                 "value": study_group or "—", "unit": ""},
        {"label": "Institution",                 "value": institution or "—", "unit": ""},
        {"label": "Software version",            "value": software or "—", "unit": ""},
    ]

    # ── 2. Data quality & SNR ───────────────────────────────────────────────
    signal_rows = [
        {"metric": "Voxel count",
         "repro": _fmt_thousands(int(repro_mask.sum()))  if has_seg else "—",
         "muscle": _fmt_thousands(int(muscle_mask.sum())) if has_seg else "—",
         "noise": _fmt_thousands(int(noise_mask.sum()))   if has_seg else "—", "unit": ""},
        {"metric": "Mean signal",
         "repro": _fmt_thousands(repro_sig["mean"])   if repro_sig  else "—",
         "muscle": _fmt_thousands(muscle_sig["mean"]) if muscle_sig else "—",
         "noise": "—", "unit": "a.u."},
        {"metric": "Median signal",
         "repro": _fmt_thousands(repro_sig["median"])   if repro_sig  else "—",
         "muscle": _fmt_thousands(muscle_sig["median"]) if muscle_sig else "—",
         "noise": "—", "unit": "a.u."},
        {"metric": "Noise estimate (σ)", "repro": "—", "muscle": "—",
         "noise": f"{sigma:.2f}" if sigma else "—", "unit": "a.u."},
    ]
    snr_rows = [
        {"metric": "SNR (mean-based)",   "repro": snr(repro_sig, "mean"),   "muscle": snr(muscle_sig, "mean"),   "unit": "ratio"},
        {"metric": "SNR (median-based)", "repro": snr(repro_sig, "median"), "muscle": snr(muscle_sig, "median"), "unit": "ratio"},
    ]

    # ── 3. Fit quality ──────────────────────────────────────────────────────
    repro_chi2  = _map_median_iqr(s.chi2_map, repro_mask)
    muscle_chi2 = _map_median_iqr(s.chi2_map, muscle_mask)
    repro_excl  = _exclusion_mask(s, repro_mask)
    muscle_excl = _exclusion_mask(s, muscle_mask)
    fit_quality_rows = [
        {"metric": "χ² median (SSE/σ², not dof-normalized)",
         "repro": f"{repro_chi2['median']:.2f}" if repro_chi2 else "—",
         "muscle": f"{muscle_chi2['median']:.2f}" if muscle_chi2 else "—", "unit": ""},
        {"metric": "χ² IQR",
         "repro": f"{repro_chi2['iqr']:.2f}" if repro_chi2 else "—",
         "muscle": f"{muscle_chi2['iqr']:.2f}" if muscle_chi2 else "—", "unit": ""},
        {"metric": "Voxels excluded (failed fit or R² < threshold)",
         "repro": _pct_str(repro_excl["n_excluded"], repro_excl["total"]) if repro_excl else "—",
         "muscle": _pct_str(muscle_excl["n_excluded"], muscle_excl["total"]) if muscle_excl else "—", "unit": ""},
        {"metric": "Voxels where curve_fit failed to converge",
         "repro": _pct_str(repro_excl["n_fit_failed"], repro_excl["total"]) if repro_excl else "—",
         "muscle": _pct_str(muscle_excl["n_fit_failed"], muscle_excl["total"]) if muscle_excl else "—", "unit": ""},
    ]

    # ── 4. Quantitative T2/T1 results ───────────────────────────────────────
    outlier_thr = 200.0

    def outliers(mask):
        if s.good_map is None:
            return None
        vals = s.good_map[mask]
        vals = vals[np.isfinite(vals)]
        if vals.size == 0:
            return None
        return {"n": int(vals.size), "n_out": int(np.sum(vals > outlier_thr))}

    repro_out, muscle_out = outliers(repro_mask), outliers(muscle_mask)
    t2_summary_rows = [
        {"metric": f"Median {lbl}", "repro": _med_str(repro_fit), "muscle": _med_str(muscle_fit),
         "unit": unit, "highlight": True},
        {"metric": f"IQR {lbl}", "repro": _iqr_str(repro_fit), "muscle": _iqr_str(muscle_fit), "unit": unit},
        {"metric": "25th–75th percentile",
         "repro": f"{repro_fit['p25']:.1f} – {repro_fit['p75']:.1f}" if repro_fit else "—",
         "muscle": f"{muscle_fit['p25']:.1f} – {muscle_fit['p75']:.1f}" if muscle_fit else "—", "unit": unit},
        {"metric": f"Outliers ({lbl} > {outlier_thr:.0f} {unit})",
         "repro": _pct_str(repro_out["n_out"], repro_out["n"]) if repro_out else "—",
         "muscle": _pct_str(muscle_out["n_out"], muscle_out["n"]) if muscle_out else "—", "unit": "voxels"},
    ]

    # ── 5. Processing parameters ────────────────────────────────────────────
    fc = s.fit_config or {}
    model_str = ("S(TE) = C + S₀·exp(−TE·R₂),  T2 (ms) = 1000 / R₂" if lbl == "T2" else
                 "S(α) = S₀·sin(α)·(1−E1)/(1−cos(α)·E1),  E1 = exp(−TR/T1)")
    fit_config_rows = [
        {"param": "Fit type", "value": f"Mono-exponential {lbl} (per-voxel nonlinear least squares)"},
        {"param": "Signal model", "value": model_str},
        {"param": "Optimizer", "value": "scipy.optimize.curve_fit — Levenberg–Marquardt (maxfev 5000)"},
        {"param": "Noise term σ (background, MAD)",
         "value": f"{sigma:.3f}  (from seg==0 background voxels)" if sigma else "—", "highlight": True},
        {"param": "R² quality threshold", "value": f"{fc.get('r2_thresh', FC.R2_FIT_THRESH):.2f}"},
        {"param": f"{lbl} accepted range",
         "value": f"{fc.get('thresh_lo', FC.LOW_THRESH_MS):.1f} – {fc.get('thresh_hi', FC.HIGH_THRESH_MS):.1f} ms"},
        {"param": "Masks used", "value": "Yes" if has_seg else "No — fit all non-zero voxels", "highlight": has_seg},
        {"param": "Denoising applied",
         "value": f"Yes — Gaussian spatial filter, σ={fc.get('denoise_sigma'):.2f} voxels" if fc.get("denoise") else "No",
         "highlight": bool(fc.get("denoise"))},
    ]
    bounds_rows = (
        [
            {"param": "S₀ (amplitude)", "initial": f"{FC.RATIO_S0:.2f} × S(TE₁)",
             "lower": f"{FC.RATIO_S0_LB:.2f} × S(TE₁)", "upper": f"{FC.RATIO_S0_UB:.0f} × S(TE₁)", "unit": "a.u."},
            {"param": "T2", "initial": f"{FC.T2_INIT_MS:.0f}", "lower": f"{FC.T2_LB_MS:g}",
             "upper": f"{FC.T2_UB_MS:.0f}", "unit": unit},
        ] if lbl == "T2" else
        [
            {"param": "S₀ (amplitude)", "initial": "max(signal)", "lower": "0", "upper": "20 × max(signal)", "unit": "a.u."},
            {"param": "T1", "initial": "1000", "lower": "10", "upper": "5000", "unit": unit},
        ]
    )
    files_rows = [{"role": "Source series", "file": "; ".join(s.file_names) if s.file_names else "—"}]
    if has_seg:
        seg_file = s.seg_filename or "(uploaded, filename not retained)"
        files_rows += [
            {"role": "Segmentation mask (multi-label)", "file": seg_file},
            {"role": f"ROI label {repro_label} → {repro_name}", "file": seg_file},
            {"role": f"ROI label {muscle_label} → {muscle_name}", "file": seg_file},
        ]
    else:
        files_rows.append({"role": "Segmentation mask", "file": "None — fit ran on all non-zero voxels"})

    key_metrics = {
        "reproMedianT2": _med_str(repro_fit), "reproIQR": _iqr_str(repro_fit),
        "reproN": _fmt_thousands(repro_fit["n_vox"]) if repro_fit else "0",
        "muscleMedianT2": _med_str(muscle_fit), "muscleIQR": _iqr_str(muscle_fit),
        "muscleN": _fmt_thousands(muscle_fit["n_vox"]) if muscle_fit else "0",
    }
    combined_mask = (repro_mask | muscle_mask) if has_seg else np.isfinite(s.param_map)
    combined_vals = s.good_map[combined_mask] if s.good_map is not None else np.array([])
    combined_vals = combined_vals[np.isfinite(combined_vals)]
    if combined_vals.size:
        overlay_min = float(np.floor(np.nanpercentile(combined_vals, 1) / 10) * 10)
        overlay_max = float(np.ceil(np.nanpercentile(combined_vals, 99) / 10) * 10)
    else:
        overlay_min, overlay_max = 0.0, 150.0

    # ── 6. Cohort-level summary (from saved comparison scans) ──────────────
    saved = getattr(s, "saved_scans", [])
    cohort_rows = []
    group_colors: dict = {}
    for sc in saved:
        st_ = sc.get("stats") or {}
        g = sc.get("group") or "—"
        if g not in group_colors:
            group_colors[g] = _GROUP_PALETTE[len(group_colors) % len(_GROUP_PALETTE)]
        text_color, bg_color = group_colors[g]
        cohort_rows.append({
            "id": sc.get("label", "—"),
            "group": g,
            "groupTextColor": text_color,
            "groupBg": bg_color,
            "medT2": f"{st_['median']:.1f}" if st_ else "—",
            "iqrT2": f"{st_['p75'] - st_['p25']:.1f}" if st_ else "—",
            "snr": f"{sc['snr_median']:.1f}" if sc.get("snr_median") is not None else "—",
            "chi2": f"{sc['chi2_median']:.2f}" if sc.get("chi2_median") is not None else "—",
        })

    def cohort_median(getter):
        vals = [v for v in (getter(sc) for sc in saved) if v is not None and np.isfinite(v)]
        return float(np.median(vals)) if vals else None

    c_med  = cohort_median(lambda sc: (sc.get("stats") or {}).get("median"))
    c_iqr  = cohort_median(lambda sc: ((sc.get("stats") or {}).get("p75", np.nan) -
                                        (sc.get("stats") or {}).get("p25", np.nan)))
    c_snr  = cohort_median(lambda sc: sc.get("snr_median"))
    c_chi2 = cohort_median(lambda sc: sc.get("chi2_median"))
    cohort_summary = {
        "medT2": f"{c_med:.1f}" if c_med is not None else "—",
        "iqrT2": f"{c_iqr:.1f}" if c_iqr is not None else "—",
        "snr":   f"{c_snr:.1f}" if c_snr is not None else "—",
        "chi2":  f"{c_chi2:.2f}" if c_chi2 is not None else "—",
        "note": (f"n = {len(saved)} saved scan(s) from this session's comparison panel. "
                 "Denoising is not implemented in this pipeline."
                 if saved else
                 "No comparison scans saved yet — use Save Scan in the comparison panel to add cohort entries."),
    }

    # ── representative voxels (shared across Fit Quality + Quant. Results) ──
    mask3d = (s.seg > 0) if has_seg else np.isfinite(s.param_map)
    typical_xyz = worst_xyz = None
    if s.r2_map is not None:
        fitted_mask = mask3d & np.isfinite(s.r2_map) & np.isfinite(s.param_map)
        coords = np.array(np.where(fitted_mask)).T
        if len(coords) > 0:
            r2_at = s.r2_map[fitted_mask]
            med_r2 = float(np.median(r2_at))
            typical_xyz = tuple(int(v) for v in coords[int(np.argmin(np.abs(r2_at - med_r2)))])
            worst_xyz   = tuple(int(v) for v in coords[int(np.argmin(r2_at))])

    subject = {
        "id": mouse_id or (s.file_names[0].split(".")[0] if s.file_names else "—"),
        "groupDisplay": study_group or "—",
        "scanDate": meta["scan_date"],
        "studyId": study_id or "—",
        "sequence": sequence_str,
        "pipelineVersion": pipeline_version,
        "institution": institution or "—",
        "facility": facility or "—",
        "scanner": scanner or "—",
        "software": software or "—",
        "generatedDate": datetime.datetime.now().strftime("%d %b %Y"),
    }

    data = {
        "subject": subject,
        "roiNames": {"repro": repro_name, "muscle": muscle_name},
        "session": session_rows,
        "signal": signal_rows,
        "snr": snr_rows,
        "fitQuality": fit_quality_rows,
        "t2Summary": t2_summary_rows,
        "fitConfig": fit_config_rows,
        "bounds": bounds_rows,
        "files": files_rows,
        "keyMetrics": key_metrics,
        "overlayRange": {"min": overlay_min, "max": overlay_max},
        "cohort": cohort_rows,
        "cohortSummary": cohort_summary,
    }
    ctx = {
        "lbl": lbl, "unit": unit, "Z": Z, "has_seg": has_seg,
        "repro_mask": repro_mask, "muscle_mask": muscle_mask,
        "typical_xyz": typical_xyz, "worst_xyz": worst_xyz,
        "mid_z": Z // 2,
        "overlay_min": overlay_min, "overlay_max": overlay_max,
        "hist_repro": _hist_mask(s, repro_mask),
        "hist_muscle": _hist_mask(s, muscle_mask),
    }
    return data, ctx


# ─────────────────────────────── SVG chart + PNG map builders ─────────────────

_SVG_X0, _SVG_X1, _SVG_Y0, _SVG_Y1 = 46, 346, 166, 14


def _voxel_fit_svg(s, xyz: Optional[tuple], curve_color: str, fig_no: int, title_prefix: str) -> str:
    if xyz is None or s.stacked is None or s.acq_params is None:
        return f'<div class="chart-empty">Figure {fig_no}. {_esc(title_prefix)} voxel — no data available.</div>'
    xi, yi, zi = xyz
    src = s.stacked_denoised if getattr(s, "stacked_denoised", None) is not None else s.stacked
    sig = src[xi, yi, zi, :].astype(float)
    te  = np.asarray(s.acq_params, dtype=float)

    if s.modality == "T2":
        res = _fit_t2_voxel(sig, te / 1000.0, s.sigma_global)
        if res is None:
            return f'<div class="chart-empty">Figure {fig_no}. Fit failed for this voxel.</div>'
        te_fine = np.linspace(te.min(), te.max(), 120)
        model_fine = res["noise"] + res["s0"] * np.exp(-te_fine / 1000.0 * res["R2_rate"])
        stat_label = f"T2 = {res['t2']:.1f} ms"
        qual_label = f"χ² = {res['chi2']:.2f}"
        xlabel = "Echo time TE (ms)"
    else:
        res = _fit_t1_voxel(sig, te, s.tr_ms or 15.0)
        if res is None:
            return f'<div class="chart-empty">Figure {fig_no}. Fit failed for this voxel.</div>'
        te_fine = np.linspace(te.min(), te.max(), 120)
        E1 = np.exp(-(s.tr_ms or 15.0) / max(res["t1"], 1.0))
        alphas = np.deg2rad(te_fine)
        model_fine = res["s0"] * np.sin(alphas) * (1 - E1) / (1 - np.cos(alphas) * E1)
        stat_label = f"T1 = {res['t1']:.1f} ms"
        qual_label = f"R² = {res['r2_fit']:.3f}"
        xlabel = "Flip angle (°)"

    v_all = np.concatenate([sig, model_fine])
    v_min, v_max = float(np.min(v_all)) * 0.92, float(np.max(v_all)) * 1.08
    te_min, te_max = float(te.min()), float(te.max())
    v_span  = max(v_max - v_min, 1e-9)
    te_span = max(te_max - te_min, 1e-9)

    def sx(t): return _SVG_X0 + (t - te_min) / te_span * (_SVG_X1 - _SVG_X0)
    def sy(v): return _SVG_Y0 - (v - v_min) / v_span * (_SVG_Y0 - _SVG_Y1)

    poly = " ".join(f"{sx(t):.1f},{sy(v):.1f}" for t, v in zip(te_fine, model_fine))
    circles = "".join(
        f'<circle cx="{sx(t):.1f}" cy="{sy(v):.1f}" r="3.2" fill="#fff" stroke="#3a3d42" stroke-width="1.2"/>'
        for t, v in zip(te, sig)
    )
    y_ticks = np.linspace(v_min, v_max, 5)
    x_ticks = np.linspace(te_min, te_max, 6)
    gridlines = "".join(
        f'<line x1="{_SVG_X0}" x2="{_SVG_X1}" y1="{sy(v):.1f}" y2="{sy(v):.1f}" stroke="#e6e8ea" stroke-width="1"/>'
        for v in y_ticks)
    y_labels = "".join(
        f'<text x="{_SVG_X0 - 4}" y="{sy(v):.1f}" text-anchor="end" dominant-baseline="middle" fill="#8a8e94" font-size="8">{v:.0f}</text>'
        for v in y_ticks)
    x_labels = "".join(
        f'<text x="{sx(t):.1f}" y="178" text-anchor="middle" fill="#8a8e94" font-size="8">{t:.0f}</text>'
        for t in x_ticks)

    return f'''<svg viewBox="0 0 360 200" class="fit-chart">
      {gridlines}
      <line x1="{_SVG_X0}" y1="{_SVG_Y1}" x2="{_SVG_X0}" y2="{_SVG_Y0}" stroke="#9aa0a6" stroke-width="1"/>
      <line x1="{_SVG_X0}" y1="{_SVG_Y0}" x2="{_SVG_X1}" y2="{_SVG_Y0}" stroke="#9aa0a6" stroke-width="1"/>
      {y_labels}
      {x_labels}
      <text x="196" y="196" text-anchor="middle" fill="#6b6f76" font-size="8.5">{_esc(xlabel)}</text>
      <text x="12" y="90" text-anchor="middle" fill="#6b6f76" font-size="8.5" transform="rotate(-90 12 90)">Signal (a.u.)</text>
      <polyline points="{poly}" fill="none" stroke="{curve_color}" stroke-width="2"/>
      {circles}
    </svg>
    <div class="chart-caption"><span class="fig-no">Figure {fig_no}.</span> {_esc(title_prefix)} voxel ({xi},{yi},{zi}) — {_esc(stat_label)}, {_esc(qual_label)}.</div>'''


def _hist_svg(hist: Optional[dict], bar_color: str, roi_label: str, fig_no: int) -> str:
    if not hist or not hist.get("counts"):
        return f'<div class="chart-empty">Figure {fig_no}. No quality-passed voxels for {_esc(roi_label)}.</div>'
    counts, edges, median = hist["counts"], hist["edges"], hist["median"]
    n = len(counts)
    maxc = max(counts) or 1
    bw = (_SVG_X1 - _SVG_X0) / n
    bars = "".join(
        f'<rect x="{_SVG_X0 + i * bw + 1:.1f}" y="{_SVG_Y0 - (c / maxc) * (_SVG_Y0 - _SVG_Y1):.1f}" '
        f'width="{bw - 2:.1f}" height="{(c / maxc) * (_SVG_Y0 - _SVG_Y1):.1f}" fill="{bar_color}" opacity="0.82"/>'
        for i, c in enumerate(counts))
    dmin, dmax = edges[0], edges[-1]
    span = max(dmax - dmin, 1e-9)

    def hx(v): return _SVG_X0 + (v - dmin) / span * (_SVG_X1 - _SVG_X0)

    xticks = "".join(
        f'<text x="{hx(e):.1f}" y="178" text-anchor="middle" fill="#8a8e94" font-size="8">{e:.0f}</text>'
        for e in edges[::2])
    med_x = hx(median)
    return f'''<svg viewBox="0 0 360 200" class="fit-chart">
      <line x1="{_SVG_X0}" y1="{_SVG_Y1}" x2="{_SVG_X0}" y2="{_SVG_Y0}" stroke="#9aa0a6" stroke-width="1"/>
      <line x1="{_SVG_X0}" y1="{_SVG_Y0}" x2="{_SVG_X1}" y2="{_SVG_Y0}" stroke="#9aa0a6" stroke-width="1"/>
      {bars}
      <line x1="{med_x:.1f}" x2="{med_x:.1f}" y1="{_SVG_Y1}" y2="{_SVG_Y0}" stroke="#1f2124" stroke-width="1.2" stroke-dasharray="4 2"/>
      <text x="{med_x:.1f}" y="11" text-anchor="middle" fill="#1f2124" font-size="8">median {median:.0f} ms</text>
      {xticks}
      <text x="196" y="196" text-anchor="middle" fill="#6b6f76" font-size="8.5">T2 (ms)</text>
    </svg>
    <div class="chart-caption"><span class="fig-no">Figure {fig_no}.</span> T2 histogram — {_esc(roi_label)}.</div>'''


def _fig_to_b64(fig) -> str:
    import matplotlib.pyplot as plt
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=150, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return base64.b64encode(buf.getvalue()).decode()


def _chi2_map_img(s, mid_z: int) -> Optional[str]:
    if s.chi2_map is None:
        return None
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    sl = s.chi2_map[:, :, mid_z]
    if not np.isfinite(sl).any():
        return None
    vmax = float(np.nanpercentile(sl[np.isfinite(sl)], 95))
    fig, ax = plt.subplots(figsize=(5.0, 4.0))
    im = ax.imshow(np.ma.masked_invalid(sl.T), cmap="hot_r", vmin=0, vmax=max(vmax, 1e-6),
                    origin="lower", aspect="equal")
    ax.axis("off")
    cb = fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
    cb.set_label("χ² (SSE/σ²)", fontsize=9)
    cb.ax.tick_params(labelsize=8)
    return _fig_to_b64(fig)


def _overlay_img(s, z: int, vmin: float, vmax: float) -> Optional[str]:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.colors as mcolors
    pm = s.good_map if s.good_map is not None else s.param_map
    fig, ax = plt.subplots(figsize=(3.2, 3.2))
    if s.stacked is not None:
        fe = s.stacked[:, :, z, 0]
        fmax = float(np.nanpercentile(fe[fe > 0], 99)) if (fe > 0).any() else 1.0
        ax.imshow(fe.T, cmap="gray", vmin=0, vmax=max(fmax, 1e-6), origin="lower", aspect="equal")
    pm_sl = pm[:, :, z]
    norm = mcolors.Normalize(vmin=vmin, vmax=vmax)
    cmap = plt.get_cmap("plasma")
    rgba = cmap(norm(np.nan_to_num(pm_sl, nan=0)))
    rgba[..., 3] = np.where(np.isfinite(pm_sl), 0.78, 0.0)
    ax.imshow(np.transpose(rgba, (1, 0, 2)), origin="lower", aspect="equal")
    ax.axis("off")
    ax.set_title(f"Slice {z + 1}/{s.param_map.shape[2]}", fontsize=9, style="italic")
    return _fig_to_b64(fig)


# ─────────────────────────────────────────────── HTML assembly ────────────────

_REPORT_CSS = """
@page { size: letter; margin: 0; }
:root { --accent:#26415f; --roi-repro:#0f766e; --roi-muscle:#b45309; }
* { box-sizing:border-box; }
body.report { margin:0; background:#e9eaec; font-family:'Helvetica Neue',Arial,sans-serif; color:#1f2124; }
.report-page { max-width:850px; margin:0 auto; background:#fff; padding:0.7in; }
.report-header, .report-footer {
  display:flex; justify-content:space-between; align-items:center;
  font:500 9.5px 'Helvetica Neue',Arial,sans-serif; color:#8a8e94; letter-spacing:.04em; text-transform:uppercase;
}
.report-header { border-bottom:0.75px solid #d3d6da; padding-bottom:5px; margin-bottom:28px; }
.report-footer { border-top:0.75px solid #d3d6da; padding-top:5px; margin-top:40px;
  font:500 9px 'IBM Plex Mono',monospace; text-transform:none; }
.title-block { min-height:6in; display:flex; flex-direction:column; margin-bottom:40px;
  page-break-after:always; }
.eyebrow { font:600 12px 'Helvetica Neue',Arial,sans-serif; letter-spacing:.22em; text-transform:uppercase; color:var(--accent); }
.eyebrow-rule { height:3px; width:64px; background:var(--accent); margin:14px 0 26px; }
h1.report-title { margin:0; font:300 42px/1.05 'Helvetica Neue',Arial,sans-serif; color:#161719; letter-spacing:-.015em; }
h1.report-title strong { font-weight:600; }
.report-lede { margin:20px 0 0; max-width:32rem; font:400 14.5px/1.6 'Helvetica Neue',Arial,sans-serif; color:#4a4e55; }
.meta-grid { margin-top:40px; display:grid; grid-template-columns:1fr 1fr 1fr; gap:1px; background:#d3d6da; border:1px solid #d3d6da; }
.meta-cell { background:#fbfbfc; padding:14px 16px; }
.meta-label { font:600 9.5px 'Helvetica Neue',Arial,sans-serif; letter-spacing:.1em; text-transform:uppercase; color:#8a8e94; }
.meta-value { margin-top:5px; font:500 15px 'IBM Plex Mono',monospace; color:#1f2124; }
.title-footer { margin-top:auto; padding-top:36px; display:flex; justify-content:space-between; align-items:flex-end; }
.title-footer-left { font:400 12px/1.5 'Helvetica Neue',Arial,sans-serif; color:#6b6f76; }
.title-footer-left b { color:#3a3d42; }
.title-footer-right { font:500 10px 'IBM Plex Mono',monospace; color:#a0a4aa; text-align:right; }
.toc { page-break-after:always; }
.toc h2 { margin:0 0 22px; font:600 22px 'Helvetica Neue',Arial,sans-serif; color:#1a1b1d;
  border-bottom:2px solid var(--accent); padding-bottom:6px; }
.toc-row { display:flex; align-items:baseline; margin:0 0 10px; font:400 13.5px 'Helvetica Neue',Arial,sans-serif; color:#2a2c30; }
.toc-row.sub { margin-left:24px; color:#54585f; font-size:12.5px; }
.toc-row b { font-weight:600; }
.toc-dots { flex:1; border-bottom:1.5px dotted #b9bdc3; margin:0 8px 4px; }
section.report-section { margin-bottom:34px; }
.sec-head { display:flex; align-items:baseline; gap:12px; border-bottom:2px solid var(--accent); padding-bottom:6px; margin:0 0 10px; }
.sec-head .num { font:700 20px 'Helvetica Neue',Arial,sans-serif; color:var(--accent); }
.sec-head h2 { margin:0; font:600 19px 'Helvetica Neue',Arial,sans-serif; color:#1a1b1d; }
h3.subhead { font:600 14px 'Helvetica Neue',Arial,sans-serif; color:var(--accent); margin:22px 0 4px; }
.report-p { font:400 12.5px/1.6 'Helvetica Neue',Arial,sans-serif; color:#54585f; margin:8px 0 12px; }
.table-caption { font:italic 11px 'Helvetica Neue',Arial,sans-serif; color:#8a8e94; margin:10px 0 5px; }
table.doc-table { width:100%; border-collapse:collapse; margin-bottom:8px; }
table.doc-table th { border:1px solid #c2c6cb; padding:6px 10px; font:600 10px 'Helvetica Neue',Arial,sans-serif;
  letter-spacing:.05em; text-transform:uppercase; background:#eef0f2; color:#3a3d42; text-align:left; }
table.doc-table th.num, table.doc-table td.num { text-align:right; }
table.doc-table td { border:1px solid #d3d6da; padding:5px 10px; font:400 11.5px 'IBM Plex Mono',monospace; color:#1f2124; }
table.doc-table td.label { font:500 11.5px 'Helvetica Neue',Arial,sans-serif; color:#3a3d42; }
table.doc-table td.unit { font:400 11px 'IBM Plex Mono',monospace; color:#6b6f76; }
table.doc-table tbody tr:nth-child(even) { background:#fafbfc; }
.legend { display:flex; gap:16px; margin:12px 0 4px; font:500 11px 'Helvetica Neue',Arial,sans-serif; color:#54585f; }
.legend span.dot { width:11px; height:11px; border-radius:2px; display:inline-block; margin-right:6px; }
.chart-grid { display:grid; grid-template-columns:1fr 1fr; gap:18px; margin:16px 0; }
.chart-box { border:1px solid #d3d6da; background:#fcfcfd; padding:8px 8px 4px; }
.fit-chart { width:100%; height:auto; display:block; font-family:'IBM Plex Mono',monospace; }
.chart-caption, figcaption.map-caption { font:400 11px/1.4 'Helvetica Neue',Arial,sans-serif; color:#8a8e94; margin-top:6px; }
.chart-caption .fig-no, figcaption.map-caption .fig-no { font-style:italic; }
.chart-empty { border:1px dashed #c2c6cb; color:#8a8e94; padding:40px 10px; text-align:center; font-size:12px; }
.stat-cards { display:grid; grid-template-columns:1fr 1fr; gap:14px; margin:16px 0 4px; }
.stat-card { border:1px solid #d3d6da; padding:12px 14px; background:#fcfcfd; }
.stat-card.repro { border-top:3px solid var(--roi-repro); }
.stat-card.muscle { border-top:3px solid var(--roi-muscle); }
.stat-card .label { font:600 9.5px 'Helvetica Neue',Arial,sans-serif; letter-spacing:.09em; text-transform:uppercase; color:#8a8e94; }
.stat-card .value { margin-top:6px; font:300 30px 'IBM Plex Mono',monospace; color:#1f2124; }
.stat-card .value span { font-size:14px; color:#6b6f76; }
.stat-card .sub { margin-top:2px; font:400 11px 'IBM Plex Mono',monospace; color:#8a8e94; }
.map-grid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px; }
.map-grid img, .map-single img { width:100%; height:auto; display:block; border:1px solid #d3d6da; }
.overlay-scale { display:flex; align-items:center; gap:10px; margin-top:10px; }
.overlay-scale .bar { flex:1; height:9px; border:1px solid #cfd2d6;
  background:linear-gradient(90deg,#2c1a4d,#2a6f97,#1f9e6f,#c9c53a,#d9773f,#b3202a); }
.overlay-scale span { font:400 9.5px 'IBM Plex Mono',monospace; color:#8a8e94; }
.group-pill { font:600 9px 'IBM Plex Mono',monospace; padding:1px 6px; border-radius:3px; }
.note { font:400 10.5px/1.5 'Helvetica Neue',Arial,sans-serif; color:#8a8e94; margin:14px 0 0; }
@media print {
  body.report { background:#fff; }
  .report-page { max-width:none; padding:0.6in; }
  section.report-section { page-break-inside:avoid; }
}
"""


def _render_report_html(s, data: dict, ctx: dict,
                         repro_color: str, muscle_color: str, accent_color: str) -> str:
    lbl = ctx["lbl"]
    roi = data["roiNames"]
    subj = data["subject"]

    def lvu_rows(rows):
        return "".join(
            f'<tr><td class="label">{_esc(r["label"])}</td><td>{_esc(r["value"])}</td>'
            f'<td class="unit">{_esc(r["unit"])}</td></tr>' for r in rows)

    def rmc_rows(rows, metric_key="metric"):
        out = []
        for r in rows:
            out.append(
                f'<tr><td class="label">{_esc(r[metric_key])}</td>'
                f'<td class="num">{_esc(r["repro"])}</td>'
                f'<td class="num">{_esc(r["muscle"])}</td>'
                f'<td class="unit">{_esc(r["unit"])}</td></tr>')
        return "".join(out)

    def t2_summary_rows(rows):
        out = []
        for r in rows:
            rc = repro_color if r.get("highlight") else "#1f2124"
            mc = muscle_color if r.get("highlight") else "#1f2124"
            out.append(
                f'<tr><td class="label">{_esc(r["metric"])}</td>'
                f'<td class="num" style="color:{rc};font-weight:600;">{_esc(r["repro"])}</td>'
                f'<td class="num" style="color:{mc};font-weight:600;">{_esc(r["muscle"])}</td>'
                f'<td class="unit">{_esc(r["unit"])}</td></tr>')
        return "".join(out)

    def fit_config_rows(rows):
        out = []
        for r in rows:
            color = repro_color if r.get("highlight") else "#1f2124"
            out.append(
                f'<tr><td class="label">{_esc(r["param"])}</td>'
                f'<td style="color:{color};font-weight:600;">{_esc(r["value"])}</td></tr>')
        return "".join(out)

    def bounds_rows(rows):
        return "".join(
            f'<tr><td class="label">{_esc(r["param"])}</td>'
            f'<td class="num">{_esc(r["initial"])}</td>'
            f'<td class="num">{_esc(r["lower"])}</td>'
            f'<td class="num">{_esc(r["upper"])}</td>'
            f'<td class="unit">{_esc(r["unit"])}</td></tr>' for r in rows)

    def file_rows(rows):
        return "".join(
            f'<tr><td class="label">{_esc(r["role"])}</td><td>{_esc(r["file"])}</td></tr>' for r in rows)

    def cohort_rows(rows):
        out = []
        for r in rows:
            out.append(
                f'<tr><td style="font-weight:600;">{_esc(r["id"])}</td>'
                f'<td><span class="group-pill" style="color:{r["groupTextColor"]};background:{r["groupBg"]};">'
                f'{_esc(r["group"])}</span></td>'
                f'<td class="num">{_esc(r["medT2"])}</td>'
                f'<td class="num" style="color:#6b6f76;">{_esc(r["iqrT2"])}</td>'
                f'<td class="num">{_esc(r["snr"])}</td>'
                f'<td class="num">{_esc(r["chi2"])}</td></tr>')
        return "".join(out)

    typical_svg = _voxel_fit_svg(s, ctx["typical_xyz"], repro_color, 1, "Typical")
    worst_svg   = _voxel_fit_svg(s, ctx["worst_xyz"], muscle_color, 2, "Worst-case")
    hist_repro_svg  = _hist_svg(ctx["hist_repro"],  repro_color,  roi["repro"],  3)
    hist_muscle_svg = _hist_svg(ctx["hist_muscle"], muscle_color, roi["muscle"], 4)

    chi2_png = _chi2_map_img(s, ctx["mid_z"])
    Z = ctx["Z"]
    slice_idxs = sorted({max(0, int(Z * 0.25)), Z // 2, min(Z - 1, int(Z * 0.75))})
    overlay_imgs = [(_overlay_img(s, z, ctx["overlay_min"], ctx["overlay_max"]), z) for z in slice_idxs]

    cohort = data["cohort"]
    cohort_summary = data["cohortSummary"]
    saved_note = cohort_summary["note"]

    cohort_section = ""
    if cohort:
        cohort_section = f'''
    <tbody>
      {cohort_rows(cohort)}
      <tr style="background:#f2f4f6;">
        <td style="font-weight:700;">Cohort median</td><td></td>
        <td class="num" style="font-weight:600;">{_esc(cohort_summary["medT2"])}</td>
        <td class="num" style="font-weight:600;color:#6b6f76;">{_esc(cohort_summary["iqrT2"])}</td>
        <td class="num" style="font-weight:600;">{_esc(cohort_summary["snr"])}</td>
        <td class="num" style="font-weight:600;">{_esc(cohort_summary["chi2"])}</td>
      </tr>
    </tbody>'''
    else:
        cohort_section = '<tbody><tr><td colspan="6" style="text-align:center;color:#8a8e94;">No comparison scans saved yet.</td></tr></tbody>'

    overlay_figs = "".join(
        f'<img src="data:image/png;base64,{png}" alt="Overlay slice {z+1}"/>'
        for png, z in overlay_imgs if png
    ) or '<div class="chart-empty">No slices available for overlay.</div>'

    chi2_fig = (f'<img src="data:image/png;base64,{chi2_png}" alt="Goodness-of-fit map"/>'
                if chi2_png else '<div class="chart-empty">No χ² map available.</div>')

    root_style = f'--accent:{accent_color};--roi-repro:{repro_color};--roi-muscle:{muscle_color};'

    return f"""<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>{_esc(roi['repro'])} &amp; {_esc(roi['muscle'])} — {lbl} Mapping Analysis Report</title>
<style>{_REPORT_CSS}</style>
</head>
<body class="report">
<div class="report-page" style="{root_style}">

  <div class="report-header">
    <span>{lbl} Mapping Analysis Report</span>
    <span>{_esc(roi['repro'])} &amp; {_esc(roi['muscle'])} relaxometry</span>
  </div>

  <div class="title-block">
    <div class="eyebrow">Quantitative MRI &middot; {lbl} Relaxometry</div>
    <div class="eyebrow-rule"></div>
    <h1 class="report-title">{lbl} Mapping<br><strong>Analysis Report</strong></h1>
    <p class="report-lede">Voxel-wise {lbl} relaxometry of the {_esc(roi['repro'].lower())} and {_esc(roi['muscle'].lower())}
      from a multi-echo acquisition, with signal-to-noise assessment, per-ROI fit-quality diagnostics, and cohort-level comparison.</p>

    <div class="meta-grid">
      <div class="meta-cell"><div class="meta-label">Subject</div><div class="meta-value">{_esc(subj['id'])}</div></div>
      <div class="meta-cell"><div class="meta-label">Study group</div><div class="meta-value">{_esc(subj['groupDisplay'])}</div></div>
      <div class="meta-cell"><div class="meta-label">Scan date</div><div class="meta-value">{_esc(subj['scanDate'])}</div></div>
      <div class="meta-cell"><div class="meta-label">Study ID</div><div class="meta-value">{_esc(subj['studyId'])}</div></div>
      <div class="meta-cell"><div class="meta-label">Sequence</div><div class="meta-value">{_esc(subj['sequence'])}</div></div>
      <div class="meta-cell"><div class="meta-label">Pipeline</div><div class="meta-value">{_esc(subj['pipelineVersion'])}</div></div>
    </div>

    <div class="title-footer">
      <div class="title-footer-left"><b>{_esc(subj['facility'])}</b><br>{_esc(subj['institution'])}<br>{_esc(subj['scanner'])} &middot; {_esc(subj['software'])}</div>
      <div class="title-footer-right">CONFIDENTIAL<br>Research use only</div>
    </div>
  </div>

  <div class="toc">
    <h2>Table of Contents</h2>
    <div class="toc-row"><b>1.&nbsp;&nbsp;Scan &amp; Session Metadata</b><span class="toc-dots"></span></div>
    <div class="toc-row"><b>2.&nbsp;&nbsp;Data Quality &amp; SNR</b><span class="toc-dots"></span></div>
    <div class="toc-row sub">2.1&nbsp;&nbsp;Tissue &amp; Noise ROI Signal<span class="toc-dots"></span></div>
    <div class="toc-row sub">2.2&nbsp;&nbsp;Signal-to-Noise Ratios<span class="toc-dots"></span></div>
    <div class="toc-row"><b>3.&nbsp;&nbsp;Fit Quality</b><span class="toc-dots"></span></div>
    <div class="toc-row sub">3.1&nbsp;&nbsp;Goodness-of-Fit Statistics<span class="toc-dots"></span></div>
    <div class="toc-row sub">3.2&nbsp;&nbsp;Representative Voxel Fits<span class="toc-dots"></span></div>
    <div class="toc-row"><b>4.&nbsp;&nbsp;Quantitative {lbl} Results</b><span class="toc-dots"></span></div>
    <div class="toc-row sub">4.1&nbsp;&nbsp;{lbl} Relaxometry Summary<span class="toc-dots"></span></div>
    <div class="toc-row sub">4.2&nbsp;&nbsp;{lbl} Distributions<span class="toc-dots"></span></div>
    <div class="toc-row sub">4.3&nbsp;&nbsp;Anatomical {lbl} Overlay<span class="toc-dots"></span></div>
    <div class="toc-row"><b>5.&nbsp;&nbsp;Processing Parameters</b><span class="toc-dots"></span></div>
    <div class="toc-row"><b>6.&nbsp;&nbsp;Cohort-Level Summary</b><span class="toc-dots"></span></div>
  </div>

  <section class="report-section" id="sec1">
    <div class="sec-head"><span class="num">1</span><h2>Scan &amp; Session Metadata</h2></div>
    <p class="report-p">Acquisition and session parameters read from the series header, Bruker study files, and session state.</p>
    <div class="table-caption">Table 1. Selected acquisition and session parameters.</div>
    <table class="doc-table">
      <thead><tr><th style="width:42%;">Parameter</th><th>Value</th><th style="width:14%;">Unit</th></tr></thead>
      <tbody>{lvu_rows(data['session'])}</tbody>
    </table>
  </section>

  <section class="report-section" id="sec2">
    <div class="sec-head"><span class="num">2</span><h2>Data Quality &amp; SNR</h2></div>
    <div class="legend">
      <span><span class="dot" style="background:var(--roi-repro);"></span>{_esc(roi['repro'])}</span>
      <span><span class="dot" style="background:var(--roi-muscle);"></span>{_esc(roi['muscle'])}</span>
      <span><span class="dot" style="background:#9aa0a6;"></span>Noise ROI</span>
    </div>
    <h3 class="subhead">2.1&nbsp; Tissue &amp; Noise ROI Signal</h3>
    <div class="table-caption">Table 2. Signal statistics from the first-echo image within each ROI.</div>
    <table class="doc-table">
      <thead><tr><th>Metric</th><th class="num">Repro tract</th><th class="num">Muscle</th><th class="num">Noise ROI</th><th style="width:12%;">Unit</th></tr></thead>
      <tbody>{"".join(f'<tr><td class="label">{_esc(r["metric"])}</td><td class="num">{_esc(r["repro"])}</td><td class="num">{_esc(r["muscle"])}</td><td class="num">{_esc(r["noise"])}</td><td class="unit">{_esc(r["unit"])}</td></tr>' for r in data['signal'])}</tbody>
    </table>
    <h3 class="subhead">2.2&nbsp; Signal-to-Noise Ratios</h3>
    <div class="table-caption">Table 3. SNR per ROI (tissue signal / noise-ROI σ).</div>
    <table class="doc-table">
      <thead><tr><th>Metric</th><th class="num">Repro tract</th><th class="num">Muscle</th><th style="width:12%;">Unit</th></tr></thead>
      <tbody>{rmc_rows(data['snr'])}</tbody>
    </table>
  </section>

  <section class="report-section" id="sec3">
    <div class="sec-head"><span class="num">3</span><h2>Fit Quality</h2></div>
    <h3 class="subhead">3.1&nbsp; Goodness-of-Fit Statistics</h3>
    <div class="table-caption">Table 4. χ² distribution and voxel-exclusion summary per ROI.</div>
    <table class="doc-table">
      <thead><tr><th>Statistic</th><th class="num">Repro tract</th><th class="num">Muscle</th><th style="width:12%;">Unit</th></tr></thead>
      <tbody>{rmc_rows(data['fitQuality'])}</tbody>
    </table>
    <div class="chart-box" style="margin:20px 0 0;">
      <div class="map-single">{chi2_fig}</div>
    </div>
    <figcaption class="map-caption"><span class="fig-no">Figure 0.</span> Goodness-of-fit map — voxel-wise χ² for the central slice.</figcaption>

    <h3 class="subhead">3.2&nbsp; Representative Voxel Fits</h3>
    <p class="report-p">Measured echo-train signal (points) with the fitted model (line) for a typical and a worst-case voxel, chosen by fit R² across the ROI.</p>
    <div class="chart-grid">
      <div><div class="chart-box">{typical_svg}</div></div>
      <div><div class="chart-box">{worst_svg}</div></div>
    </div>
  </section>

  <section class="report-section" id="sec4">
    <div class="sec-head"><span class="num">4</span><h2>Quantitative {lbl} Results</h2></div>
    <div class="stat-cards">
      <div class="stat-card repro">
        <div class="label">{_esc(roi['repro'])} &middot; Median {lbl}</div>
        <div class="value">{_esc(data['keyMetrics']['reproMedianT2'])}<span> ms</span></div>
        <div class="sub">IQR {_esc(data['keyMetrics']['reproIQR'])} ms &middot; n = {_esc(data['keyMetrics']['reproN'])}</div>
      </div>
      <div class="stat-card muscle">
        <div class="label">{_esc(roi['muscle'])} &middot; Median {lbl}</div>
        <div class="value">{_esc(data['keyMetrics']['muscleMedianT2'])}<span> ms</span></div>
        <div class="sub">IQR {_esc(data['keyMetrics']['muscleIQR'])} ms &middot; n = {_esc(data['keyMetrics']['muscleN'])}</div>
      </div>
    </div>

    <h3 class="subhead">4.1&nbsp; {lbl} Relaxometry Summary</h3>
    <div class="table-caption">Table 5. Per-ROI {lbl} relaxation-time statistics after outlier screening.</div>
    <table class="doc-table">
      <thead><tr><th>Statistic</th><th class="num">Repro tract</th><th class="num">Muscle</th><th style="width:12%;">Unit</th></tr></thead>
      <tbody>{t2_summary_rows(data['t2Summary'])}</tbody>
    </table>

    <h3 class="subhead">4.2&nbsp; {lbl} Distributions</h3>
    <div class="chart-grid">
      <div><div class="chart-box">{hist_repro_svg}</div></div>
      <div><div class="chart-box">{hist_muscle_svg}</div></div>
    </div>

    <h3 class="subhead">4.3&nbsp; Anatomical {lbl} Overlay</h3>
    <p class="report-p">Color-coded {lbl} map overlaid on the anatomical image at representative slices (rostral → caudal).</p>
    <div class="map-grid">{overlay_figs}</div>
    <div class="overlay-scale">
      <span>{ctx['overlay_min']:.0f} ms</span><div class="bar"></div><span>{ctx['overlay_max']:.0f} ms</span>
    </div>
    <figcaption class="map-caption"><span class="fig-no">Figure 5.</span> Anatomical {lbl} overlay maps, windowed {ctx['overlay_min']:.0f}–{ctx['overlay_max']:.0f} ms.</figcaption>
  </section>

  <section class="report-section" id="sec5">
    <div class="sec-head"><span class="num">5</span><h2>Processing Parameters</h2></div>
    <div class="table-caption">Table 6. Fitting configuration.</div>
    <table class="doc-table">
      <thead><tr><th style="width:38%;">Parameter</th><th>Value</th></tr></thead>
      <tbody>{fit_config_rows(data['fitConfig'])}</tbody>
    </table>
    <div class="table-caption">Table 7. Initial estimates and parameter bounds.</div>
    <table class="doc-table">
      <thead><tr><th>Parameter</th><th class="num">Initial</th><th class="num">Lower</th><th class="num">Upper</th><th style="width:12%;">Unit</th></tr></thead>
      <tbody>{bounds_rows(data['bounds'])}</tbody>
    </table>
    <div class="table-caption">Table 8. Mask, segmentation and source files.</div>
    <table class="doc-table">
      <thead><tr><th style="width:38%;">Role</th><th>File name</th></tr></thead>
      <tbody>{file_rows(data['files'])}</tbody>
    </table>
  </section>

  <section class="report-section" id="sec6">
    <div class="sec-head"><span class="num">6</span><h2>Cohort-Level Summary</h2></div>
    <p class="report-p">Per-subject summary across scans saved in this session's comparison panel. {lbl} and IQR are reported for the reproductive tract ROI; SNR and χ² are median-based over that ROI.</p>
    <div class="table-caption">Table 9. Cohort summary by saved scan.</div>
    <table class="doc-table">
      <thead><tr><th>Scan</th><th>Group</th><th class="num">Med {lbl}</th><th class="num">IQR {lbl}</th><th class="num">SNR</th><th class="num">χ²</th></tr></thead>
      {cohort_section}
    </table>
    <p class="note">{_esc(saved_note)}</p>
  </section>

  <div class="report-footer">
    <span>{_esc(subj['id'])} &middot; {_esc(subj['studyId'])}</span>
    <span>{_esc(subj['institution'])}</span>
    <span>Generated {_esc(subj['generatedDate'])}</span>
  </div>

</div>
</body>
</html>"""


# ─────────────────────────────────────────────── report endpoint ──────────────

@router.get("/{sid}/report.html")
async def report_html(
    sid: str,
    repro_label: int = 1,
    muscle_label: int = 2,
    repro_name: str = "Reproductive tract",
    muscle_name: str = "Skeletal muscle",
    mouse_id: Optional[str] = None,
    study_group: Optional[str] = None,
    study_id: Optional[str] = None,
    institution: Optional[str] = "University of Illinois Urbana-Champaign",
    facility: Optional[str] = None,
    scanner: Optional[str] = None,
    software: Optional[str] = None,
    pipeline_version: str = "relaxometry_lab v1.0",
    repro_color: str = "#0f766e",
    muscle_color: str = "#b45309",
    accent_color: str = "#26415f",
):
    """
    Self-contained, real-data HTML analysis report styled after the
    "T2 Mapping Analysis Report" design: title page, TOC, per-ROI tables,
    SVG fit/histogram charts, and embedded goodness-of-fit / overlay map
    images. No external template runtime is required to view it — open
    directly in a browser, or use the browser's Print → Save as PDF.
    """
    _, html_doc = _generate_report(
        sid, repro_label, muscle_label, repro_name, muscle_name,
        mouse_id, study_group, study_id, institution, facility, scanner, software,
        pipeline_version, repro_color, muscle_color, accent_color,
    )
    return Response(content=html_doc, media_type="text/html")


def _generate_report(
    sid: str, repro_label: int, muscle_label: int, repro_name: str, muscle_name: str,
    mouse_id: Optional[str], study_group: Optional[str], study_id: Optional[str],
    institution: Optional[str], facility: Optional[str], scanner: Optional[str],
    software: Optional[str], pipeline_version: str,
    repro_color: str, muscle_color: str, accent_color: str,
) -> tuple:
    s = _require_fit(sid)
    data, ctx = _build_report_data(
        s, repro_label=repro_label, muscle_label=muscle_label,
        repro_name=repro_name, muscle_name=muscle_name,
        mouse_id=mouse_id, study_group=study_group, study_id=study_id,
        institution=institution, facility=facility, scanner=scanner,
        software=software, pipeline_version=pipeline_version,
    )
    html_doc = _render_report_html(s, data, ctx, repro_color, muscle_color, accent_color)
    return s, html_doc


def _find_pdf_browser() -> Optional[str]:
    """Locate an installed Chrome/Chromium/Edge binary to drive headless --print-to-pdf."""
    import platform, shutil
    system = platform.system()
    candidates = []
    if system == "Darwin":
        candidates += [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
    elif system == "Windows":
        candidates += [
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        ]
    else:
        candidates += ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]

    for c in candidates:
        if os.path.isabs(c):
            if os.path.isfile(c):
                return c
        elif shutil.which(c):
            return shutil.which(c)
    return None


@router.get("/{sid}/report.pdf")
async def report_pdf(
    sid: str,
    repro_label: int = 1,
    muscle_label: int = 2,
    repro_name: str = "Reproductive tract",
    muscle_name: str = "Skeletal muscle",
    mouse_id: Optional[str] = None,
    study_group: Optional[str] = None,
    study_id: Optional[str] = None,
    institution: Optional[str] = "University of Illinois Urbana-Champaign",
    facility: Optional[str] = None,
    scanner: Optional[str] = None,
    software: Optional[str] = None,
    pipeline_version: str = "relaxometry_lab v1.0",
    repro_color: str = "#0f766e",
    muscle_color: str = "#b45309",
    accent_color: str = "#26415f",
):
    """
    Same report as /report.html, rendered to PDF by driving a locally
    installed Chrome/Chromium/Edge headlessly (--print-to-pdf). Avoids
    pulling in a separate HTML-to-PDF dependency (WeasyPrint needs system
    Pango/gdk-pixbuf libs; Playwright needs its own browser download).
    """
    import subprocess, tempfile

    browser = _find_pdf_browser()
    if not browser:
        raise HTTPException(
            500,
            "No Chrome/Chromium/Edge installation found to render the PDF. "
            "Install Google Chrome, or use /report.html and print to PDF from your browser."
        )

    s, html_doc = _generate_report(
        sid, repro_label, muscle_label, repro_name, muscle_name,
        mouse_id, study_group, study_id, institution, facility, scanner, software,
        pipeline_version, repro_color, muscle_color, accent_color,
    )

    with tempfile.TemporaryDirectory() as td:
        html_path = os.path.join(td, "report.html")
        pdf_path  = os.path.join(td, "report.pdf")
        with open(html_path, "w", encoding="utf-8") as f:
            f.write(html_doc)

        cmd = [
            browser, "--headless=new", "--disable-gpu", "--no-sandbox",
            "--no-pdf-header-footer", f"--print-to-pdf={pdf_path}",
            f"file://{html_path}",
        ]
        try:
            proc = subprocess.run(cmd, capture_output=True, timeout=30)
        except subprocess.TimeoutExpired:
            raise HTTPException(500, "PDF rendering timed out")

        if not os.path.isfile(pdf_path) or os.path.getsize(pdf_path) == 0:
            detail = proc.stderr.decode(errors="ignore")[-500:] if proc else ""
            raise HTTPException(500, f"PDF rendering failed. {detail}")

        with open(pdf_path, "rb") as f:
            pdf_bytes = f.read()

    fname = f"{s.modality.lower()}_report.pdf"
    return Response(content=pdf_bytes, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="{fname}"'})
