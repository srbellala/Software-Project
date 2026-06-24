#!/usr/bin/env python3
"""
bruker_import.py  --  importer for Bruker/ParaVision study folders.

What it does
------------
1. Walks a Bruker study folder and finds every imaging scan (the numbered
   subfolders), skipping adjustment/calibration folders (Adj*, FreqAdjustment...).
2. For each scan, locates the exported DICOM and NIfTI files inside pdata/<reco>/.
3. Builds a sitk.Image for each scan (prefers DICOM, falls back to NIfTI).
4. Classifies the modality (T1 / T2 / ...) by reading the Bruker `method` file,
   cross-checked against echo-time and flip-angle counts.
5. Presents the result: a printed summary table of every scan's sitk.Image
   geometry + modality, a saved slice-montage PNG per scan, and an optional
   interactive scroll-through viewer.

Usage
-----
    python bruker_import.py /path/to/20251114_073856_MS025_LPSStudy2_23_1_3
    python bruker_import.py <study_dir> --source nifti      # use NIfTI exports
    python bruker_import.py <study_dir> --view 1            # scroll through scan 1
    python bruker_import.py <study_dir> --no-montages       # skip PNG output

Dependencies:  pip install SimpleITK numpy matplotlib
"""

import os
import re
import glob
import argparse

import numpy as np
import SimpleITK as sitk
import matplotlib.pyplot as plt

try:
    import pydicom            # better at Bruker multiframe nested tags
    _HAVE_PYDICOM = True
except ImportError:
    _HAVE_PYDICOM = False


# --------------------------------------------------------------------------- #
# Bruker parameter-file parsing (method / acqp / visu_pars are JCAMP-DX text)
# --------------------------------------------------------------------------- #
def _read_text(path):
    try:
        with open(path, "r", errors="ignore") as fh:
            return fh.read()
    except OSError:
        return ""


def get_param(text, key):
    """
    Return the value of a JCAMP-DX parameter `##$key=...`.
    Handles three forms:
        ##$Method=<Bruker:MSME>          -> "Bruker:MSME"
        ##$PVM_RepetitionTime=2000       -> "2000"
        ##$EffectiveTE=( 8 )             -> values on following line(s)
                6.5 13 19.5 26 ...
    Returns a list of string tokens (always a list; scalars are length-1).
    """
    m = re.search(rf"^##\$\s*{re.escape(key)}\s*=(.*)$", text, re.MULTILINE)
    if not m:
        return []
    rhs = m.group(1).strip()

    # string form  <...>
    if rhs.startswith("<") and rhs.endswith(">"):
        return [rhs[1:-1]]

    # array form  ( N )  -> collect tokens from the lines that follow
    if rhs.startswith("("):
        start = m.end()
        tail = text[start:]
        tokens = []
        for line in tail.splitlines():
            if line.startswith("##") or line.startswith("$$"):
                break
            tokens.extend(line.split())
        return tokens

    # scalar
    return rhs.split()


def get_floats(text, key):
    out = []
    for tok in get_param(text, key):
        try:
            out.append(float(tok))
        except ValueError:
            pass
    return out


# --------------------------------------------------------------------------- #
# Modality classification
# --------------------------------------------------------------------------- #
def classify_modality(scan_dir):
    """
    Best-guess modality from the Bruker `method` file, with the evidence used.
    Returns (modality, method_name, evidence_string).
    """
    text = _read_text(os.path.join(scan_dir, "method"))
    method_tokens = get_param(text, "Method")
    method_name = method_tokens[0] if method_tokens else "?"
    m = method_name.upper()

    echoes = get_floats(text, "EffectiveTE") or get_floats(text, "PVM_EchoTime")
    n_echo = len({round(e, 3) for e in echoes})
    flip = get_floats(text, "PVM_ExcPulseAngle") or get_floats(text, "ExcPulse1")
    flip_val = flip[0] if flip else None

    evidence = f"method={method_name}, n_echo={n_echo or 0}"
    if flip_val is not None:
        evidence += f", flip={flip_val:g}"

    # Rules: name first, then verify with parameters. Conservative on purpose --
    # a single FLASH scan can't be confirmed as VFA without its siblings.
    if "MSME" in m or "MGE" in m or n_echo >= 3:
        modality = "T2 (multi-echo)"
    elif "VTR" in m or "RAREVTR" in m:
        modality = "T1 (variable TR)"
    elif m.startswith("IR") or "_IR" in m:
        modality = "T1 (inversion recovery)"
    elif "FLASH" in m:
        modality = "T1? (FLASH / VFA candidate)"
    elif "RARE" in m:
        modality = "anatomical / T2w (RARE)"
    elif "FIELDMAP" in m or "B0" in m:
        modality = "field map"
    elif method_name == "?":
        modality = "unknown (no method file)"
    else:
        modality = f"unknown ({method_name})"

    return modality, method_name, evidence


def scan_title(scan_dir, dicom_files):
    """
    The descriptive scan title, like Horos shows (e.g.
    'T2map_MSME_p28_2rep_4RF(E10)'). Prefers the DICOM SeriesDescription
    (0008,103e); falls back to the Bruker method 'Method' name.
    """
    if _HAVE_PYDICOM and dicom_files:
        try:
            ds = pydicom.dcmread(dicom_files[0], stop_before_pixels=True)
            desc = getattr(ds, "SeriesDescription", None) or \
                getattr(ds, "ProtocolName", None)
            if desc:
                return str(desc).strip()
        except Exception:
            pass
    # SimpleITK fallback for the SeriesDescription tag
    if dicom_files:
        try:
            r = sitk.ImageFileReader()
            r.SetFileName(dicom_files[0])
            r.ReadImageInformation()
            if r.HasMetaDataKey("0008|103e"):
                return r.GetMetaData("0008|103e").strip()
        except Exception:
            pass
    text = _read_text(os.path.join(scan_dir, "method"))
    tok = get_param(text, "Method")
    return tok[0] if tok else "?"


def series_id(scan_dir, dicom_files, scan_num):
    """
    Series ID used for sorting (the '10,001' / '20,001' values in Horos).
    Reads SeriesNumber (0020,0011); falls back to the scan folder number.
    """
    if _HAVE_PYDICOM and dicom_files:
        try:
            ds = pydicom.dcmread(dicom_files[0], stop_before_pixels=True)
            if getattr(ds, "SeriesNumber", None) not in (None, ""):
                return int(ds.SeriesNumber)
        except Exception:
            pass
    if dicom_files:
        try:
            r = sitk.ImageFileReader()
            r.SetFileName(dicom_files[0])
            r.ReadImageInformation()
            if r.HasMetaDataKey("0020|0011"):
                return int(float(r.GetMetaData("0020|0011")))
        except Exception:
            pass
    return scan_num


# --------------------------------------------------------------------------- #
# Scan discovery + image loading
# --------------------------------------------------------------------------- #
SKIP_PREFIXES = ("adj", "freqadjustment", "adjresult", "adjprotocols",
                 "adjrefpow")


def find_scans(study_dir):
    """Numbered subfolders are scans; everything else (Adj*, etc.) is skipped."""
    scans = []
    for name in sorted(os.listdir(study_dir), key=lambda s: (not s.isdigit(), s)):
        full = os.path.join(study_dir, name)
        if not os.path.isdir(full):
            continue
        if not name.isdigit():
            continue  # only numeric folders are imaging scans
        scans.append((int(name), full))
    return scans


def locate_exports(scan_dir):
    """Find DICOM and NIfTI files inside pdata/<reco>/ for this scan."""
    dicom_files, nifti_files = [], []
    for reco in sorted(glob.glob(os.path.join(scan_dir, "pdata", "*"))):
        dicom_files += glob.glob(os.path.join(reco, "dicom", "*.dcm"))
        for ext in ("*.nii", "*.nii.gz"):
            nifti_files += glob.glob(os.path.join(reco, "nifti", ext))
    return sorted(dicom_files), sorted(nifti_files)


def load_image(dicom_files, nifti_files, source_pref="dicom"):
    """
    Build a sitk.Image, preferring `source_pref`. Returns (image, source_used).
    A single multiframe DICOM is the whole volume; many slice files get stacked.
    """
    order = ["dicom", "nifti"] if source_pref == "dicom" else ["nifti", "dicom"]
    for src in order:
        files = dicom_files if src == "dicom" else nifti_files
        if not files:
            continue
        try:
            if src == "dicom" and len(files) > 1:
                reader = sitk.ImageSeriesReader()
                reader.SetFileNames(files)          # stack single-frame slices
                return reader.Execute(), "dicom (series)"
            return sitk.ReadImage(files[0]), src    # multiframe dcm or 1 nifti
        except RuntimeError:
            continue
    return None, "none"


# --------------------------------------------------------------------------- #
# Presentation
# --------------------------------------------------------------------------- #
def dicom_slice_thickness(dicom_files):
    """
    SliceThickness (0018,0050) as recorded in the DICOM header.
    For Bruker multiframe it lives in PixelMeasuresSequence, so pydicom is
    used when available; falls back to SimpleITK's top-level tag.
    """
    if not dicom_files:
        return None
    path = dicom_files[0]
    if _HAVE_PYDICOM:
        try:
            ds = pydicom.dcmread(path, stop_before_pixels=True)
            if getattr(ds, "SliceThickness", None) not in (None, ""):
                return float(ds.SliceThickness)
            for seq_name in ("SharedFunctionalGroupsSequence",
                             "PerFrameFunctionalGroupsSequence"):
                seq = getattr(ds, seq_name, None)
                if seq:
                    pms = getattr(seq[0], "PixelMeasuresSequence", None)
                    if pms and getattr(pms[0], "SliceThickness", None) is not None:
                        return float(pms[0].SliceThickness)
        except Exception:
            pass
    try:                                    # SimpleITK fallback (top-level tag)
        r = sitk.ImageFileReader()
        r.SetFileName(path)
        r.ReadImageInformation()
        if r.HasMetaDataKey("0018|0050"):
            return float(r.GetMetaData("0018|0050"))
    except Exception:
        pass
    return None


def nifti_slice_thickness(nifti_files):
    """pixdim[3] from the NIfTI header (the z voxel size = slice thickness)."""
    if not nifti_files:
        return None
    try:
        r = sitk.ImageFileReader()
        r.SetFileName(nifti_files[0])
        r.ReadImageInformation()
        if r.HasMetaDataKey("pixdim[3]"):
            return float(r.GetMetaData("pixdim[3]"))
        if r.GetDimension() >= 3:
            return float(r.GetSpacing()[2])
    except Exception:
        pass
    return None


def _fmt_thk(dcm_thk, nii_thk):
    d = f"{dcm_thk:.3f}" if dcm_thk is not None else "-"
    n = f"{nii_thk:.3f}" if nii_thk is not None else "-"
    return f"{d} / {n}"


def geom_xyz(img):
    """Return (X, Y, Z) strings combining size and spacing per axis."""
    if img is None:
        return "-", "-", "-"
    sz = img.GetSize()
    sp = img.GetSpacing()
    out = []
    for n in range(3):
        if n < len(sz):
            out.append(f"{sz[n]}@{sp[n]:.3f}")
        else:
            out.append("-")
    return out[0], out[1], out[2]


def print_summary(rows):
    cols = ["ID", "Scan", "Title", "Source",
            "X (vox@mm)", "Y (vox@mm)", "Z (vox@mm)",
            "SliceThk dcm/nii", "Evidence"]
    widths = [7, 4, 30, 13, 13, 13, 13, 17, 26]
    line = "  ".join(c.ljust(w) for c, w in zip(cols, widths))
    print("\n" + line)
    print("  ".join("-" * w for w in widths))
    for r in rows:
        cells = [str(r["id"]), str(r["scan"]), r["title"], r["source"],
                 r["x"], r["y"], r["z"], r["thk"], r["evidence"]]
        print("  ".join(c[:w].ljust(w) for c, w in zip(cells, widths)))
    print("\n(vox@mm = voxel count @ spacing in mm; sorted by ID)\n")


def _to_volumes(img):
    """
    Return a list of 3D arrays (z, y, x). A 4D image (e.g. 2 flip angles /
    echoes) yields one volume per frame, so every view can be shown.
    NOTE: GetArrayFromImage reverses axes, so a sitk (x,y,z,t) image comes
    back as numpy (t, z, y, x) -- the frame dimension is axis 0.
    """
    arr = sitk.GetArrayFromImage(img)
    if arr.ndim == 2:
        return [arr[np.newaxis, ...]]
    if arr.ndim == 3:
        return [arr]
    if arr.ndim == 4:
        return [arr[t] for t in range(arr.shape[0])]
    return [arr.reshape(-1, *arr.shape[-2:])]   # fallback: flatten extras


def _montage_one(vol, title="", n=None, cols=None):
    """Montage of a single 3D volume. n=None shows all slices."""
    nz = vol.shape[0]
    idxs = np.arange(nz) if n is None else \
        np.linspace(0, nz - 1, min(n, nz)).astype(int)

    lo, hi = np.percentile(vol, [1, 99])
    cols = cols or int(np.ceil(np.sqrt(len(idxs))))
    rows_ = int(np.ceil(len(idxs) / cols))

    fig, axes = plt.subplots(rows_, cols, figsize=(1.8 * cols, 1.8 * rows_))
    axes = np.atleast_1d(axes).ravel()
    for ax, z in zip(axes, idxs):
        ax.imshow(vol[z], cmap="gray", vmin=lo, vmax=hi)
        ax.set_title(f"z={z}", fontsize=7)
        ax.axis("off")
    for ax in axes[len(idxs):]:
        ax.axis("off")
    if title:
        fig.suptitle(f"{title}  ({nz} slices)", fontsize=11)
    fig.tight_layout()
    return fig


def make_montages(img, title="", n=None, cols=None):
    """
    Return a list of (suffix, Figure). A 4D scan gives one montage per frame
    so all of its views are shown; a 3D scan gives a single montage.
    """
    vols = _to_volumes(img)
    out = []
    for i, vol in enumerate(vols):
        if len(vols) > 1:
            t = f"{title}  [view {i + 1}/{len(vols)}]"
            suffix = f"_v{i:02d}"
        else:
            t, suffix = title, ""
        out.append((suffix, _montage_one(vol, title=t, n=n, cols=cols)))
    return out


def scroll_view(img, title):
    """Interactive: scroll wheel or arrow keys to move through slices."""
    arr = sitk.GetArrayFromImage(img)
    if arr.ndim == 4:
        arr = arr[..., 0]
    lo, hi = np.percentile(arr, [1, 99])
    state = {"z": arr.shape[0] // 2}
    fig, ax = plt.subplots()
    im = ax.imshow(arr[state["z"]], cmap="gray", vmin=lo, vmax=hi)
    ax.axis("off")

    def redraw():
        im.set_data(arr[state["z"]])
        ax.set_title(f"{title}   slice {state['z']+1}/{arr.shape[0]}")
        fig.canvas.draw_idle()

    def on_scroll(ev):
        step = 1 if ev.button == "up" else -1
        state["z"] = int(np.clip(state["z"] + step, 0, arr.shape[0] - 1))
        redraw()

    def on_key(ev):
        step = {"up": 1, "right": 1, "down": -1, "left": -1}.get(ev.key, 0)
        if step:
            state["z"] = int(np.clip(state["z"] + step, 0, arr.shape[0] - 1))
            redraw()

    fig.canvas.mpl_connect("scroll_event", on_scroll)
    fig.canvas.mpl_connect("key_press_event", on_key)
    redraw()
    plt.show()


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main():
    ap = argparse.ArgumentParser(description="Import a Bruker study folder.")
    ap.add_argument("study_dir", help="path to the Bruker study (session) folder")
    ap.add_argument("--source", choices=["dicom", "nifti"], default="dicom",
                    help="preferred image source (default: dicom)")
    ap.add_argument("--view", type=int, metavar="SCAN",
                    help="open a scrollable viewer for this scan number")
    ap.add_argument("--show", action="store_true",
                    help="display each scan's full-slice montage on screen")
    ap.add_argument("--montage-cols", type=int, default=None,
                    help="columns in the montage grid (default: auto)")
    ap.add_argument("--montage-slices", type=int, default=12,
                    help="number of slices to show (default: 12; use 0 for ALL)")
    ap.add_argument("--no-montages", action="store_true",
                    help="do not write montage PNGs")
    ap.add_argument("--out", default="bruker_import_out",
                    help="output directory for montages")
    args = ap.parse_args()

    # 0 means "all slices"; make_montage treats None as all
    if args.montage_slices == 0:
        args.montage_slices = None

    if not os.path.isdir(args.study_dir):
        raise SystemExit(f"Not a folder: {args.study_dir}")

    scans = find_scans(args.study_dir)
    if not scans:
        raise SystemExit("No numbered scan folders found.")

    if not args.no_montages:
        os.makedirs(args.out, exist_ok=True)

    images, rows, figs = {}, [], []
    for num, scan_dir in scans:
        modality, _, evidence = classify_modality(scan_dir)
        dcm, nii = locate_exports(scan_dir)
        img, src = load_image(dcm, nii, args.source)
        images[num] = img
        title = scan_title(scan_dir, dcm)
        sid = series_id(scan_dir, dcm, num)
        x, y, z = geom_xyz(img)
        rows.append({
            "id": sid,
            "scan": num,
            "title": title,
            "source": src,
            "x": x, "y": y, "z": z,
            "thk": _fmt_thk(dicom_slice_thickness(dcm),
                            nifti_slice_thickness(nii)),
            "evidence": evidence,
        })
        if img is not None:
            mtitle = f"Scan {num} - {title}"
            montages = make_montages(img, title=mtitle,
                                     n=args.montage_slices,
                                     cols=args.montage_cols)
            for suffix, fig in montages:
                if not args.no_montages:
                    fig.savefig(
                        os.path.join(args.out, f"scan_{num:02d}{suffix}.png"),
                        dpi=110)
                if args.show:
                    figs.append(fig)
                else:
                    plt.close(fig)

    rows.sort(key=lambda r: r["id"])      # sort by series ID, least to greatest
    print_summary(rows)
    if not args.no_montages:
        print(f"Montages written to: {os.path.abspath(args.out)}\n")

    if args.view is not None:
        img = images.get(args.view)
        if img is None:
            raise SystemExit(f"Scan {args.view} has no loadable image.")
        scroll_view(img, f"Scan {args.view}")
    elif args.show and figs:
        plt.show()   # display all montages at once


if __name__ == "__main__":
    main()