#!/usr/bin/env python3
"""
ortho_viewer.py  --  Slicer-style three-plane viewer built on bruker_import.

Reuses the Bruker importer to find / classify / load scans, then opens a
matplotlib window with linked axial, coronal, and sagittal panels:

  * a shared crosshair (one voxel index) links all three planes
  * scroll wheel moves through slices in whichever panel the cursor is over
  * click in any panel re-centers the crosshair on that point
  * Level / Window sliders control contrast (radiology convention)

Aspect ratios are taken from the image spacing, so anisotropic volumes
(e.g. 0.125 x 0.125 x 0.5 mm) are drawn without distortion.

Usage:
    python ortho_viewer.py /path/to/<study_folder>          # pick from a menu
    python ortho_viewer.py <study_folder> --scan 6           # skip the menu
    python ortho_viewer.py <study_folder> --scan 3 --frame 1 # a 4D scan's 2nd view

Requires bruker_import.py in the same folder.
Dependencies: pip install SimpleITK numpy matplotlib pydicom
"""

import argparse

import numpy as np
import matplotlib.pyplot as plt
from matplotlib.widgets import Slider

from bruker_import import (find_scans, classify_modality, locate_exports,
                           load_image, _to_volumes)

try:
    import pydicom
    _HAVE_PYDICOM = True
except ImportError:
    _HAVE_PYDICOM = False


def deinterleave_echoes(img, dicom_files):
    """
    For a multi-echo multiframe DICOM stacked as (frames, y, x), split the
    frame axis into (slice, echo) using the per-frame echo times.

    Returns (echo_vol, echo_times):
        echo_vol    : numpy (n_slice, n_echo, y, x), or None if not multi-echo
        echo_times  : list of TE in ms (length n_echo), or None
    Echo is assumed to vary fastest within each slice (confirmed for Bruker
    MSME via the per-frame EffectiveEchoTime ordering).
    """
    if not (_HAVE_PYDICOM and dicom_files):
        return None, None
    try:
        ds = pydicom.dcmread(dicom_files[0], stop_before_pixels=True)
        pfg = getattr(ds, "PerFrameFunctionalGroupsSequence", None)
        if not pfg:
            return None, None
        tes = []
        for fr in pfg:
            try:
                tes.append(float(fr.MREchoSequence[0].EffectiveEchoTime))
            except Exception:
                tes.append(None)
        uniq = sorted({round(t, 3) for t in tes if t is not None})
        n_echo = len(uniq)
        if n_echo < 2:
            return None, None
    except Exception:
        return None, None

    arr = sitk_array(img)              # (frames, y, x)
    n_frames = arr.shape[0]
    if n_frames % n_echo != 0:
        return None, None              # ordering not clean; leave as-is
    n_slice = n_frames // n_echo
    # Bruker MSME here orders slice fastest, echo outer:
    #   frame = echo * n_slice + slice
    # so reshape to (n_echo, n_slice, y, x), then move echo to axis 1 to keep
    # the viewer's (slice, echo, y, x) convention.
    echo_first = arr.reshape(n_echo, n_slice, arr.shape[1], arr.shape[2])
    echo_vol = np.transpose(echo_first, (1, 0, 2, 3))   # -> (slice, echo, y, x)
    return echo_vol, uniq


def sitk_array(img):
    import SimpleITK as sitk
    a = sitk.GetArrayFromImage(img)
    if a.ndim == 4:                    # (t,z,y,x): collapse a stray frame dim
        a = a[0]
    return a


class OrthoViewer:
    """Three linked orthogonal planes for one volume.

    If echo_vol is given (shape (z, echo, y, x)), an echo slider is added and
    contrast is fixed across echoes so T2 decay is visible as you step through.
    Otherwise vol (shape (z, y, x)) is shown as a single volume.
    """

    def __init__(self, vol=None, spacing=(1.0, 1.0, 1.0), title="",
                 echo_vol=None, echo_times=None):
        self.echo_vol = echo_vol
        self.echo_times = echo_times
        if echo_vol is not None:
            self.n_echo = echo_vol.shape[1]
            self.echo = 0
            vol = echo_vol[:, self.echo, :, :]
            contrast_source = echo_vol[:, 0, :, :]   # window from 1st (brightest)
        else:
            self.n_echo = 0
            contrast_source = vol

        # vol: numpy (z, y, x);  spacing: sitk (sx, sy, sz) in mm
        self.vol = vol
        self.nz, self.ny, self.nx = vol.shape
        self.sx, self.sy, self.sz = (tuple(spacing) + (1.0, 1.0, 1.0))[:3]

        # crosshair voxel index (i, j, k) -> vol[k, j, i]
        self.i, self.j, self.k = self.nx // 2, self.ny // 2, self.nz // 2

        # window / level seeded from robust percentiles of the source echo
        lo, hi = np.percentile(contrast_source, [1, 99])
        self.dmin = float(contrast_source.min())
        self.dmax = float(contrast_source.max())
        if self.dmax <= self.dmin:
            self.dmax = self.dmin + 1.0
        self.level = float((lo + hi) / 2)
        self.window = float(max(hi - lo, 1.0))

        self.fig = plt.figure(figsize=(13, 5.2))
        self.fig.suptitle(title)
        self.ax_ax = self.fig.add_subplot(1, 3, 1)
        self.ax_co = self.fig.add_subplot(1, 3, 2)
        self.ax_sa = self.fig.add_subplot(1, 3, 3)
        self.fig.subplots_adjust(bottom=0.26, wspace=0.05)

        vmin, vmax = self._clim()
        self.im_ax = self.ax_ax.imshow(self._axial(), cmap="gray",
                                       vmin=vmin, vmax=vmax,
                                       aspect=self.sy / self.sx)
        self.im_co = self.ax_co.imshow(self._coronal(), cmap="gray",
                                       vmin=vmin, vmax=vmax,
                                       aspect=self.sz / self.sx)
        self.im_sa = self.ax_sa.imshow(self._sagittal(), cmap="gray",
                                       vmin=vmin, vmax=vmax,
                                       aspect=self.sz / self.sy)
        for ax in (self.ax_ax, self.ax_co, self.ax_sa):
            ax.set_xticks([])
            ax.set_yticks([])

        ch = dict(color="yellow", lw=0.7, alpha=0.7)
        self.ax_v = self.ax_ax.axvline(self.i, **ch)
        self.ax_h = self.ax_ax.axhline(self.j, **ch)
        self.co_v = self.ax_co.axvline(self.i, **ch)
        self.co_h = self.ax_co.axhline(self.k, **ch)
        self.sa_v = self.ax_sa.axvline(self.j, **ch)
        self.sa_h = self.ax_sa.axhline(self.k, **ch)

        # contrast sliders
        ax_lvl = self.fig.add_axes([0.15, 0.13, 0.7, 0.03])
        ax_win = self.fig.add_axes([0.15, 0.08, 0.7, 0.03])
        self.s_level = Slider(ax_lvl, "Level", self.dmin, self.dmax,
                              valinit=self.level)
        self.s_window = Slider(ax_win, "Window", 1.0, self.dmax - self.dmin,
                               valinit=min(self.window, self.dmax - self.dmin))
        self.s_level.on_changed(self._on_contrast)
        self.s_window.on_changed(self._on_contrast)

        # echo slider (only for multi-echo volumes)
        self.s_echo = None
        if self.n_echo > 1:
            ax_echo = self.fig.add_axes([0.15, 0.02, 0.7, 0.03])
            self.s_echo = Slider(ax_echo, "Echo", 1, self.n_echo,
                                 valinit=1, valstep=1)
            self.s_echo.on_changed(self._on_echo)

        self.fig.canvas.mpl_connect("scroll_event", self._on_scroll)
        self.fig.canvas.mpl_connect("button_press_event", self._on_click)
        self._titles()

    # --- slice extractors -------------------------------------------------- #
    def _axial(self):
        return self.vol[self.k, :, :]

    def _coronal(self):
        return self.vol[:, self.j, :]

    def _sagittal(self):
        return self.vol[:, :, self.i]

    def _on_echo(self, _):
        self.echo = int(self.s_echo.val) - 1
        self.vol = self.echo_vol[:, self.echo, :, :]
        self._refresh()

    def _clim(self):
        return self.level - self.window / 2, self.level + self.window / 2

    # --- callbacks --------------------------------------------------------- #
    def _on_contrast(self, _):
        self.level = self.s_level.val
        self.window = max(self.s_window.val, 1.0)
        vmin, vmax = self._clim()
        for im in (self.im_ax, self.im_co, self.im_sa):
            im.set_clim(vmin, vmax)
        self.fig.canvas.draw_idle()

    def _on_scroll(self, ev):
        step = 1 if ev.button == "up" else -1
        if ev.inaxes is self.ax_ax:
            self.k = int(np.clip(self.k + step, 0, self.nz - 1))
        elif ev.inaxes is self.ax_co:
            self.j = int(np.clip(self.j + step, 0, self.ny - 1))
        elif ev.inaxes is self.ax_sa:
            self.i = int(np.clip(self.i + step, 0, self.nx - 1))
        else:
            return
        self._refresh()

    def _on_click(self, ev):
        if ev.inaxes is None or ev.xdata is None or ev.ydata is None:
            return
        x, y = int(round(ev.xdata)), int(round(ev.ydata))
        if ev.inaxes is self.ax_ax:          # x->i, y->j
            self.i = int(np.clip(x, 0, self.nx - 1))
            self.j = int(np.clip(y, 0, self.ny - 1))
        elif ev.inaxes is self.ax_co:        # x->i, y->k
            self.i = int(np.clip(x, 0, self.nx - 1))
            self.k = int(np.clip(y, 0, self.nz - 1))
        elif ev.inaxes is self.ax_sa:        # x->j, y->k
            self.j = int(np.clip(x, 0, self.ny - 1))
            self.k = int(np.clip(y, 0, self.nz - 1))
        else:
            return
        self._refresh()

    # --- redraw ------------------------------------------------------------ #
    def _refresh(self):
        self.im_ax.set_data(self._axial())
        self.im_co.set_data(self._coronal())
        self.im_sa.set_data(self._sagittal())
        self.ax_v.set_xdata([self.i, self.i])
        self.ax_h.set_ydata([self.j, self.j])
        self.co_v.set_xdata([self.i, self.i])
        self.co_h.set_ydata([self.k, self.k])
        self.sa_v.set_xdata([self.j, self.j])
        self.sa_h.set_ydata([self.k, self.k])
        self._titles()
        self.fig.canvas.draw_idle()

    def _titles(self):
        self.ax_ax.set_title(f"Axial   k={self.k + 1}/{self.nz}")
        self.ax_co.set_title(f"Coronal   j={self.j + 1}/{self.ny}")
        self.ax_sa.set_title(f"Sagittal   i={self.i + 1}/{self.nx}")
        if self.n_echo > 1:
            te = ""
            if self.echo_times is not None and self.echo < len(self.echo_times):
                te = f"  (TE = {self.echo_times[self.echo]:g} ms)"
            base = self.fig._suptitle.get_text().split("   echo")[0]
            self.fig.suptitle(f"{base}   echo {self.echo + 1}/{self.n_echo}{te}")

    def show(self):
        plt.show()


# --------------------------------------------------------------------------- #
# Scan menu
# --------------------------------------------------------------------------- #
def build_entries(scans):
    """Return [(num, scan_dir, modality, dcm_files, nii_files), ...]."""
    entries = []
    for num, scan_dir in scans:
        modality, _, _ = classify_modality(scan_dir)
        dcm, nii = locate_exports(scan_dir)
        entries.append((num, scan_dir, modality, dcm, nii))
    return entries


def choose_scan(entries):
    print("\nAvailable scans:")
    for num, _, modality, dcm, nii in entries:
        src = "dicom" if dcm else ("nifti" if nii else "no image")
        print(f"  [{num:>2}]  {modality:<32}  ({src})")
    valid = {e[0] for e in entries}
    while True:
        sel = input("\nScan number to view (q to quit): ").strip().lower()
        if sel in ("q", "quit", ""):
            return None
        if sel.isdigit() and int(sel) in valid:
            return next(e for e in entries if e[0] == int(sel))
        print("  not a valid scan number.")


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main():
    ap = argparse.ArgumentParser(description="Three-plane viewer for a Bruker study.")
    ap.add_argument("study_dir", help="path to the Bruker study (session) folder")
    ap.add_argument("--scan", type=int, help="view this scan number (skip menu)")
    ap.add_argument("--frame", type=int, default=0,
                    help="frame index for 4D scans (default: 0)")
    ap.add_argument("--source", choices=["dicom", "nifti"], default="dicom",
                    help="preferred image source (default: dicom)")
    args = ap.parse_args()

    scans = find_scans(args.study_dir)
    if not scans:
        raise SystemExit("No numbered scan folders found.")
    entries = build_entries(scans)

    if args.scan is not None:
        chosen = next((e for e in entries if e[0] == args.scan), None)
        if chosen is None:
            raise SystemExit(f"Scan {args.scan} not found.")
    else:
        chosen = choose_scan(entries)
        if chosen is None:
            return

    num, scan_dir, modality, dcm, nii = chosen
    img, src = load_image(dcm, nii, args.source)
    if img is None:
        raise SystemExit(f"Scan {num} has no loadable image data.")

    spacing = tuple(img.GetSpacing()[:3])
    title = f"Scan {num} - {modality}  [{src}]"

    # try to de-interleave a multi-echo (MSME) volume from the DICOM
    echo_vol, echo_times = deinterleave_echoes(img, dcm)

    if echo_vol is not None:
        print(f"\nViewing {title}\n"
              f"  de-interleaved {echo_vol.shape[0]} slices x "
              f"{echo_vol.shape[1]} echoes (TE {echo_times[0]:g}-"
              f"{echo_times[-1]:g} ms)\n"
              f"  scroll = slice | click = crosshair | sliders = contrast | "
              f"echo slider = step through TEs")
        OrthoViewer(spacing=spacing, title=title,
                    echo_vol=echo_vol, echo_times=echo_times).show()
    else:
        vols = _to_volumes(img)
        frame = int(np.clip(args.frame, 0, len(vols) - 1))
        vol = vols[frame]
        if len(vols) > 1:
            title += f"   frame {frame + 1}/{len(vols)}"
        print(f"\nViewing {title}\n"
              f"  scroll = change slice | click = move crosshair | "
              f"sliders = contrast")
        OrthoViewer(vol=vol, spacing=spacing, title=title).show()


if __name__ == "__main__":
    main()