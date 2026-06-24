#!/usr/bin/env python3
"""
T2 mapping over a SEGMENTATION ROI (e.g. a Slicer-exported .nii label map).

Builds on the whole-volume version but:
  - loads a segmentation NIfTI and restricts the fit to that region
  - VERIFIES mask/image alignment by overlay before trusting it
  - reports ROI statistics (median T2, IQR, mean, std) like fit_qmri.m
  - draws the ROI-aggregate decay curve (median signal per echo + IQR band)
  - histograms the per-voxel T2 distribution inside the ROI

Model + fit settings are identical to the MATLAB exp_n port:
    S(TE) = C + S0 * exp(-TE * R2),  TE in seconds, R2 in s^-1, T2 = 1000/R2 ms
"""

import nibabel as nib
from pathlib import Path
import numpy as np
from scipy.optimize import curve_fit
import matplotlib.pyplot as plt

# ---------------------------------------------------------------------------
# 1. Load the echo series  (series 5 = the MSME T2 scan)
# ---------------------------------------------------------------------------
data_directory = Path("/Users/sbell/Documents/Research/Software Project/NifitiInputs")
TE_times_ms = np.array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120], dtype=float)
TE_times_s = TE_times_ms / 1000.0


def echo_number(path):
    return int(path.stem.split("_")[-1])


n_data = []
img_affine = None
for nifti in sorted(data_directory.glob("*nii*")):
    img = nib.load(nifti)
    if img_affine is None:
        img_affine = img.affine
    img_data = img.get_fdata()
    single = (img_data[..., 0] + img_data[..., 1]) / 2.0   # average the 2 repetitions
    n_data.append(single)

stacked_data = np.stack(n_data, axis=-1)                    # (X, Y, Z, nTE)
first_echo = stacked_data[..., 0]
print(f"Stacked data shape: {stacked_data.shape}")

# ---------------------------------------------------------------------------
# 2. Load the segmentation ROI
# ---------------------------------------------------------------------------
# USER: point this at your Slicer-exported label map for this scan.
seg_path = Path("/Users/sbell/Downloads/TransgenicMiceData/Segmentations/20260328_F2L/Segmentation_ub_F2L.nii")

seg_img = nib.load(seg_path)
seg = seg_img.get_fdata()

# --- If multi-label, pick the label value you want; otherwise > 0 is the ROI.
LABEL_VALUE = None            # e.g. set to 1 to select only label 1
roi = (seg == LABEL_VALUE) if LABEL_VALUE is not None else (seg > 0)

# ---------------------------------------------------------------------------
# 2a. VERIFY alignment -- DO NOT skip this. The mask is worthless if misaligned.
# ---------------------------------------------------------------------------
print(f"Image spatial shape: {stacked_data.shape[:3]}")
print(f"Mask shape:          {roi.shape}")
print(f"Affines match:       {np.allclose(seg_img.affine, img_affine)}")
print(f"ROI voxel count:     {int(roi.sum())}")

if roi.shape != stacked_data.shape[:3]:
    raise ValueError("Mask spatial shape does not match the images -- wrong file or "
                     "the segmentation was drawn on a different grid.")

# Overlay the ROI on the anatomy for a slice that actually contains ROI voxels.
roi_slices = np.where(roi.any(axis=(0, 1)))[0]
if roi_slices.size == 0:
    raise ValueError("ROI is empty after loading -- check LABEL_VALUE / the file.")
z_show = int(roi_slices[len(roi_slices) // 2])

plt.figure()
plt.imshow(first_echo[:, :, z_show], cmap="gray")
plt.imshow(np.ma.masked_where(~roi[:, :, z_show], roi[:, :, z_show]),
           cmap="autumn", alpha=0.4)
plt.title(f"ROI overlay, slice {z_show} -- the highlight MUST land on the right tissue")
plt.show()

# --- If the overlay is MISALIGNED (offset / rotated / flipped), the mask and
#     images are in different voxel orders. With nibabel sharing one affine this
#     is usually NOT needed -- but if you must correct it, find the right combo
#     empirically against the overlay above, e.g.:
#         roi = np.transpose(roi, (1, 0, 2))   # swap in-plane axes
#         roi = np.flip(roi, axis=0)           # flip rows
#         roi = np.flip(roi, axis=1)           # flip cols
#     (This replaces the permute/flip block in the MATLAB script. Do NOT apply
#      it blindly -- only if the overlay shows a mismatch.)

# ---------------------------------------------------------------------------
# 3. Model + fit settings (identical to the MATLAB exp_n port)
# ---------------------------------------------------------------------------
def model(TE_s, S0, R2, C):
    return C + S0 * np.exp(-TE_s * R2)


RATIO_S0, RATIO_S0_LB, RATIO_S0_UB = 1.25, 1.05, 10.0
T2_INIT_MS, T2_LB_MS, T2_UB_MS = 20.0, 0.00001, 4000.0
R2_INIT = 1000.0 * (1.0 / T2_INIT_MS)
R2_LB = 1000.0 * (1.0 / T2_UB_MS)
R2_UB = 1000.0 * (1.0 / T2_LB_MS)
NOISE_INIT = 1473.0
LOW_THRESH_MS, HIGH_THRESH_MS = 0.0, 4000.0
R2_FIT_THRESH = 0.5


def fit_voxel(y_sig):
    """Fit one decay curve. Returns (popt, t2_ms, r2); popt is None on failure."""
    s1 = y_sig[0]
    if s1 <= 0:
        return None, np.nan, np.nan
    s0_lb, s0_ub = s1 * RATIO_S0_LB, s1 * RATIO_S0_UB
    n_ub = s0_ub
    n_init = min(NOISE_INIT, n_ub * 0.99)
    p0 = [s1 * RATIO_S0, R2_INIT, n_init]
    lower = [s0_lb, R2_LB, 0.0]
    upper = [s0_ub, R2_UB, n_ub]
    try:
        popt, _ = curve_fit(model, TE_times_s, y_sig, p0=p0, bounds=(lower, upper))
    except (RuntimeError, ValueError):
        return None, np.nan, np.nan
    t2_ms = 1000.0 / popt[1]
    pred = model(TE_times_s, *popt)
    sse = np.sum((y_sig - pred) ** 2)
    sst = np.sum((y_sig - np.mean(y_sig)) ** 2)
    r2 = 1.0 - sse / sst if sst > 0 else np.nan
    return popt, t2_ms, r2


# ---------------------------------------------------------------------------
# 4. Fit ONLY the ROI voxels (loop the segmentation, not the whole volume)
# ---------------------------------------------------------------------------
shape3d = stacked_data.shape[:3]
t2map = np.full(shape3d, np.nan)             # all in-range ROI fits
t2map_good = np.full(shape3d, np.nan)        # after R^2 rejection
r2map = np.full(shape3d, np.nan)

for x, y, z in np.argwhere(roi):
    popt, t2_ms, r2 = fit_voxel(stacked_data[x, y, z, :])
    if popt is None:
        continue
    r2map[x, y, z] = r2
    if LOW_THRESH_MS < t2_ms < HIGH_THRESH_MS:
        t2map[x, y, z] = t2_ms
        if not np.isnan(r2) and r2 >= R2_FIT_THRESH:
            t2map_good[x, y, z] = t2_ms

# ---------------------------------------------------------------------------
# 5. ROI statistics  (median + IQR, like fit_qmri.m)
# ---------------------------------------------------------------------------
roi_t2_vals = t2map_good[roi]                # 1D array of T2s inside the ROI
roi_t2_vals = roi_t2_vals[~np.isnan(roi_t2_vals)]

if roi_t2_vals.size == 0:
    print("No voxels in the ROI produced a passing fit.")
else:
    median_t2 = np.median(roi_t2_vals)
    iqr_t2 = np.percentile(roi_t2_vals, 75) - np.percentile(roi_t2_vals, 25)
    print(f"\nROI T2  (median of per-voxel fits):")
    print(f"  n voxels : {roi_t2_vals.size}")
    print(f"  median   : {median_t2:.1f} ms")
    print(f"  IQR      : {iqr_t2:.1f} ms")
    print(f"  mean     : {np.mean(roi_t2_vals):.1f} ms")
    print(f"  std      : {np.std(roi_t2_vals):.1f} ms")

# ---------------------------------------------------------------------------
# 6. Save the ROI T2 map (geometry preserved)
# ---------------------------------------------------------------------------
nib.save(nib.Nifti1Image(t2map_good, img_affine), "roi_t2map_good.nii.gz")

# ---------------------------------------------------------------------------
# 7. Display the ROI T2 map on the chosen slice
# ---------------------------------------------------------------------------
roi_t2_display = np.where(roi, t2map_good, np.nan)
plt.figure()
plt.imshow(roi_t2_display[:, :, z_show], vmin=15, vmax=65)
plt.colorbar(label="T2 (ms)")
plt.title(f"ROI T2 map, slice {z_show}")
plt.show()

# ---------------------------------------------------------------------------
# 8. ROI-aggregate decay curve  (median signal per echo + IQR band + one fit)
# ---------------------------------------------------------------------------
roi_signals = stacked_data[roi]              # (N_voxels, nTE)
median_curve = np.median(roi_signals, axis=0)
q25_curve = np.percentile(roi_signals, 25, axis=0)
q75_curve = np.percentile(roi_signals, 75, axis=0)

agg_popt, agg_t2, agg_r2 = fit_voxel(median_curve)
te_fine_ms = np.linspace(TE_times_ms.min(), TE_times_ms.max(), 200)
te_fine_s = te_fine_ms / 1000.0

plt.figure()
plt.fill_between(TE_times_ms, q25_curve, q75_curve, alpha=0.25, label="ROI IQR")
plt.plot(TE_times_ms, median_curve, "o", label="ROI median signal")
if agg_popt is not None:
    plt.plot(te_fine_ms, model(te_fine_s, *agg_popt), "k-", label="Fit")
plt.xlabel("TE (ms)")
plt.ylabel("Signal")
plt.title(f"ROI aggregate decay -- T2 = {agg_t2:.1f} ms")
plt.legend()
plt.show()

# ---------------------------------------------------------------------------
# 9. Histogram of per-voxel T2 values inside the ROI
# ---------------------------------------------------------------------------
if roi_t2_vals.size > 0:
    plt.figure()
    plt.hist(roi_t2_vals, bins=60, range=(0, 120))
    plt.xlabel("T2 (ms)")
    plt.ylabel("Voxel count")
    plt.title("ROI T2 distribution")
    plt.show()