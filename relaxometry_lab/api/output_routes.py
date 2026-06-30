"""
Output routes — NIfTI map download, CSV stats, and multi-page PDF report.
"""
import io, csv
from pathlib import Path

import numpy as np
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response, StreamingResponse

from api.sessions import get_session

router = APIRouter()


# ─────────────────────────────────────────────── helpers ──────────────────────

def _require_fit(sid: str):
    s = get_session(sid)
    if not s:
        raise HTTPException(404, "Session not found")
    if not s.fitting_done or s.param_map is None:
        raise HTTPException(400, "Fitting not complete")
    return s


def _roi_stats(s) -> dict:
    # Use quality-filtered map (good_map = t2_good from explorer)
    pm = s.good_map if (hasattr(s, "good_map") and s.good_map is not None) else s.param_map
    label = "T2_ms" if s.modality == "T2" else "T1_ms"
    vals = pm[np.isfinite(pm)] if s.seg is None else pm[s.seg > 0][np.isfinite(pm[s.seg > 0])]
    if len(vals) == 0:
        return {}
    return {
        "label":  label,
        "n_vox":  int(len(vals)),
        "mean":   float(np.mean(vals)),
        "median": float(np.median(vals)),
        "std":    float(np.std(vals)),
        "p25":    float(np.percentile(vals, 25)),
        "p75":    float(np.percentile(vals, 75)),
        "min":    float(np.min(vals)),
        "max":    float(np.max(vals)),
    }


# ─────────────────────────────────────────────── endpoints ────────────────────

@router.get("/{sid}/map.nii.gz")
async def download_map(sid: str):
    import nibabel as nib, gzip
    s = _require_fit(sid)
    img = nib.Nifti1Image(s.param_map, s.affine if s.affine is not None else np.eye(4))
    buf = io.BytesIO()
    nib.save(img, buf)      # nibabel can write to BytesIO directly as .nii
    buf.seek(0)
    raw = buf.read()
    # gzip-compress
    gz_buf = io.BytesIO()
    with gzip.GzipFile(fileobj=gz_buf, mode="wb") as gz:
        gz.write(raw)
    fname = f"{s.modality.lower()}_map.nii.gz"
    return Response(
        content=gz_buf.getvalue(),
        media_type="application/gzip",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@router.get("/{sid}/stats.csv")
async def download_stats(sid: str):
    s = _require_fit(sid)
    st = _roi_stats(s)
    if not st:
        raise HTTPException(400, "No ROI statistics available")

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Statistic", "Value", "Unit"])
    w.writerow(["Modality",  s.modality, ""])
    w.writerow(["N_voxels",  st["n_vox"], ""])
    w.writerow(["Mean",      f"{st['mean']:.2f}",   "ms"])
    w.writerow(["Median",    f"{st['median']:.2f}",  "ms"])
    w.writerow(["Std",       f"{st['std']:.2f}",    "ms"])
    w.writerow(["P25",       f"{st['p25']:.2f}",    "ms"])
    w.writerow(["P75",       f"{st['p75']:.2f}",    "ms"])
    w.writerow(["Min",       f"{st['min']:.2f}",    "ms"])
    w.writerow(["Max",       f"{st['max']:.2f}",    "ms"])
    if s.acq_params is not None:
        acq_label = "TE_ms" if s.modality == "T2" else "FlipAngle_deg"
        w.writerow([acq_label, ";".join(f"{v:.1f}" for v in s.acq_params), ""])
    if s.tr_ms:
        w.writerow(["TR_ms", f"{s.tr_ms:.1f}", "ms"])

    return Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{s.modality.lower()}_stats.csv"'},
    )


@router.get("/{sid}/report.pdf")
async def download_report(sid: str):
    """
    Multi-page PDF report using matplotlib PdfPages:
      Page 1  — cover: summary stats + decay/VFA curve + histogram
      Pages 2+ — one page per axial slice showing the param map
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.colors as mcolors
    from matplotlib.backends.backend_pdf import PdfPages

    s = _require_fit(sid)
    # Use quality-filtered map (good_map = t2_good from explorer)
    pm = s.good_map if (hasattr(s, "good_map") and s.good_map is not None) else s.param_map
    X, Y, Z = pm.shape
    label = s.modality   # "T2" or "T1"
    unit  = "ms"
    st    = _roi_stats(s)

    finite_vals = pm[np.isfinite(pm)]
    vmin = float(np.nanpercentile(finite_vals, 1))  if len(finite_vals) else 0
    vmax = float(np.nanpercentile(finite_vals, 99)) if len(finite_vals) else 1

    buf = io.BytesIO()
    with PdfPages(buf) as pdf:

        # ── Page 1: summary ──────────────────────────────────────────────────
        fig, axes = plt.subplots(1, 3, figsize=(14, 5))
        fig.patch.set_facecolor("#f5f3ee")
        fig.suptitle(f"Relaxometry Lab — {label} Report", fontsize=14, fontweight="bold",
                     color="#234a6e")

        # Left: stats table
        ax0 = axes[0]
        ax0.axis("off")
        rows = [
            ["Modality", label],
            ["N voxels", str(st.get("n_vox", "—"))],
            ["Median",   f"{st.get('median', float('nan')):.1f} {unit}"],
            ["Mean",     f"{st.get('mean',   float('nan')):.1f} {unit}"],
            ["Std",      f"{st.get('std',    float('nan')):.1f} {unit}"],
            ["P25",      f"{st.get('p25',    float('nan')):.1f} {unit}"],
            ["P75",      f"{st.get('p75',    float('nan')):.1f} {unit}"],
        ]
        if s.tr_ms:
            rows.append(["TR", f"{s.tr_ms:.0f} ms"])
        tbl = ax0.table(cellText=rows, colLabels=["Parameter", "Value"],
                        loc="center", cellLoc="left")
        tbl.auto_set_font_size(False)
        tbl.set_fontsize(9)
        tbl.scale(1.1, 1.4)
        ax0.set_title("Statistics", color="#234a6e", fontsize=10)

        # Middle: decay / VFA curve
        ax1 = axes[1]
        ax1.set_facecolor("#fafaf8")
        if s.stacked is not None and s.acq_params is not None:
            mask3d = (s.seg > 0) if s.seg is not None else np.isfinite(pm)
            if mask3d.any():
                roi = s.stacked[mask3d, :]
                med_curve = np.nanmedian(roi, axis=0)
                ax1.plot(s.acq_params, med_curve, "o-", color="#234a6e", linewidth=2)
        xlabel = "Echo Time (ms)" if label == "T2" else "Flip Angle (°)"
        ax1.set_xlabel(xlabel, fontsize=9)
        ax1.set_ylabel("Signal", fontsize=9)
        ax1.set_title(f"Median {'Decay' if label=='T2' else 'VFA'} Curve",
                      color="#234a6e", fontsize=10)
        ax1.spines[["top","right"]].set_visible(False)

        # Right: histogram
        ax2 = axes[2]
        ax2.set_facecolor("#fafaf8")
        if len(finite_vals) > 0:
            ax2.hist(finite_vals, bins=80, color="#234a6e", alpha=0.8,
                     range=(vmin, vmax))
        ax2.set_xlabel(f"{label} (ms)", fontsize=9)
        ax2.set_ylabel("Count", fontsize=9)
        ax2.set_title(f"{label} Distribution", color="#234a6e", fontsize=10)
        ax2.spines[["top","right"]].set_visible(False)

        plt.tight_layout(rect=[0, 0, 1, 0.95])
        pdf.savefig(fig, facecolor=fig.get_facecolor())
        plt.close(fig)

        # ── Pages 2+: one per axial slice ────────────────────────────────────
        ncols = 5
        # Pack up to 20 slices per page
        slices_per_page = 20
        n_pages = int(np.ceil(Z / slices_per_page))

        cmap = plt.get_cmap("plasma")
        norm = mcolors.Normalize(vmin=vmin, vmax=vmax)

        for pg in range(n_pages):
            z0 = pg * slices_per_page
            z1 = min(z0 + slices_per_page, Z)
            batch = list(range(z0, z1))
            nrows = int(np.ceil(len(batch) / ncols))

            fig2, axes2 = plt.subplots(nrows, ncols,
                                       figsize=(3 * ncols, 3 * nrows + 0.6))
            fig2.patch.set_facecolor("#f5f3ee")
            fig2.suptitle(f"{label} Map — Slices {z0+1}–{z1}",
                          fontsize=11, fontweight="bold", color="#234a6e")
            axes2 = np.array(axes2).reshape(-1)

            for idx, z in enumerate(batch):
                ax = axes2[idx]
                sl = pm[:, :, z].T
                im = ax.imshow(sl, cmap=cmap, vmin=vmin, vmax=vmax,
                               origin="lower", aspect="equal")
                ax.set_title(f"z={z+1}", fontsize=7, color="#234a6e")
                ax.axis("off")

            for idx in range(len(batch), len(axes2)):
                axes2[idx].axis("off")

            # Shared colorbar
            cax = fig2.add_axes([0.92, 0.15, 0.015, 0.7])
            sm  = plt.cm.ScalarMappable(cmap=cmap, norm=norm)
            sm.set_array([])
            cb  = fig2.colorbar(sm, cax=cax)
            cb.set_label(f"{label} ({unit})", color="#234a6e", fontsize=8)

            plt.tight_layout(rect=[0, 0, 0.91, 0.95])
            pdf.savefig(fig2, facecolor=fig2.get_facecolor())
            plt.close(fig2)

    fname = f"{label.lower()}_report.pdf"
    return Response(
        content=buf.getvalue(),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )
