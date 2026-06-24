#!/usr/bin/env python3
"""
t2_voxel_explorer.py  --  single-window PySide6 GUI for post-hoc inspection of a
T2 (MSME) map, voxel by voxel, over a segmentation ROI.

Panels (left to right): anatomy + T2 overlay (rotatable), voxel signal vs fit,
T2 distribution scatter (clickable). Per-voxel and ROI statistics live in a
dedicated sidebar. The standalone T2 map and the histogram have been removed.

Interaction
-----------
* Click the anatomy/overlay panel to select the voxel under the cursor
  (clicks are mapped back through any rotation/flip you've applied).
* Click the T2 distribution at a height to jump to the voxel with that T2.
* Rotate / flip controls reorient the overlay (and the click mapping) in-plane.

Export
------
* "Export panel images (PNG)" saves each panel as its own PNG (+ a combined one).
* "Export T2 data" writes the ROI T2 map as .npy and a per-voxel .csv (+ .nii).

Dependencies:  pip install PySide6 nibabel numpy scipy matplotlib
Run:           python t2_voxel_explorer.py   (File -> Load synthetic demo to try)
"""

import sys
import os
import re
import glob
from pathlib import Path

import numpy as np
from scipy.optimize import curve_fit
import nibabel as nib

from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout, QLabel,
    QSlider, QComboBox, QPushButton, QCheckBox, QLineEdit, QFileDialog,
    QMessageBox, QProgressDialog, QFrame, QSizePolicy,
)
from PySide6.QtCore import Qt
from PySide6.QtGui import QAction, QDoubleValidator, QFont

import matplotlib
matplotlib.use("QtAgg")
from matplotlib.backends.backend_qtagg import (
    FigureCanvasQTAgg as FigureCanvas,
    NavigationToolbar2QT as NavToolbar,
)
from matplotlib.figure import Figure
from matplotlib.colors import Normalize
from matplotlib.transforms import Bbox
import matplotlib.cm as mpl_cm
from mpl_toolkits.axes_grid1.anchored_artists import AnchoredSizeBar
import matplotlib.font_manager as fm
import matplotlib.patheffects as pe

try:
    from matplotlib import colormaps as _mpl_cmaps

    def get_cmap(name):
        return _mpl_cmaps[name].copy()
except Exception:                                   # older matplotlib
    import matplotlib.cm as _cm

    def get_cmap(name):
        c = _cm.get_cmap(name)
        return c.copy() if hasattr(c, "copy") else c


# --------------------------------------------------------------------------- #
# Palette
# --------------------------------------------------------------------------- #
FIG_BG = "#16161f"
PANEL_BG = "#20202e"
SIDE_BG = "#1b1b27"
TXT = "#d8d8e4"
MUTED = "#9aa0b5"
ACCENT = "#5aa9f7"
GRID = "#3a3a52"
C_MEAS = "#74c0fc"
C_FIT = "#ffd43b"
C_RESID = "#ff6b6b"
C_PT = "#5aa9f7"
C_OUT = "#ff6b6b"


# --------------------------------------------------------------------------- #
# Fit model + per-voxel fitter  (settings copied from T2_Mapping.py)
# --------------------------------------------------------------------------- #
class FitCfg:
    RATIO_S0, RATIO_S0_LB, RATIO_S0_UB = 1.25, 1.05, 10.0
    T2_INIT_MS, T2_LB_MS, T2_UB_MS = 20.0, 0.00001, 4000.0
    R2_INIT = 1000.0 * (1.0 / T2_INIT_MS)
    R2_LB = 1000.0 * (1.0 / T2_UB_MS)
    R2_UB = 1000.0 * (1.0 / T2_LB_MS)
    NOISE_INIT = 1473.0
    LOW_THRESH_MS, HIGH_THRESH_MS = 0.0, 4000.0
    R2_FIT_THRESH = 0.5


def model(TE_s, S0, R2, C):
    return C + S0 * np.exp(-TE_s * R2)


def fit_voxel(y_sig, TE_s, sigma_global=None):
    """Fit one decay curve. Returns a dict of results, or None on failure."""
    y_sig = np.asarray(y_sig, dtype=float)
    s1 = y_sig[0]
    if not np.isfinite(s1) or s1 <= 0:
        return None
    s0_lb, s0_ub = s1 * FitCfg.RATIO_S0_LB, s1 * FitCfg.RATIO_S0_UB
    n_ub = s0_ub
    n_init = min(FitCfg.NOISE_INIT, n_ub * 0.99)
    p0 = [s1 * FitCfg.RATIO_S0, FitCfg.R2_INIT, n_init]
    lower = [s0_lb, FitCfg.R2_LB, 0.0]
    upper = [s0_ub, FitCfg.R2_UB, n_ub]
    try:
        popt, _ = curve_fit(model, TE_s, y_sig, p0=p0,
                            bounds=(lower, upper), maxfev=5000)
    except (RuntimeError, ValueError):
        return None
    S0, R2, C = popt
    t2 = 1000.0 / R2
    pred = model(TE_s, *popt)
    resid = y_sig - pred
    sse = float(np.sum(resid ** 2))
    sst = float(np.sum((y_sig - np.mean(y_sig)) ** 2))
    r2 = 1.0 - sse / sst if sst > 0 else np.nan
    rmse = float(np.sqrt(sse / len(y_sig)))
    sigma2 = (sigma_global ** 2) if (sigma_global and sigma_global > 0) else max(C * C, 1e-9)
    chi2 = sse / sigma2
    return dict(t2=t2, r2=r2, rmse=rmse, chi2=chi2, noise=float(C),
                s0=float(S0), R2=float(R2), popt=popt, pred=pred)


# --------------------------------------------------------------------------- #
# Loaders
# --------------------------------------------------------------------------- #
def natural_echo_key(path):
    nums = re.findall(r"\d+", Path(path).stem)
    return int(nums[-1]) if nums else 0


def load_echo_folder(folder):
    files = []
    for ext in ("*.nii", "*.nii.gz"):
        files += glob.glob(os.path.join(folder, ext))
    if not files:
        raise ValueError("No .nii / .nii.gz files found in that folder.")
    files = sorted(files, key=natural_echo_key)
    vols, affine = [], None
    for f in files:
        img = nib.load(f)
        if affine is None:
            affine = img.affine
        d = img.get_fdata()
        if d.ndim == 4:
            d = d.mean(axis=3)
        elif d.ndim != 3:
            raise ValueError(f"{os.path.basename(f)}: expected 3D/4D, got {d.ndim}D.")
        vols.append(d)
    shapes = {v.shape for v in vols}
    if len(shapes) != 1:
        raise ValueError(f"Echo volumes have different shapes: {shapes}")
    stacked = np.stack(vols, axis=-1)
    return stacked, affine, files


def default_TEs(n_echo):
    if n_echo == 12:
        return list(np.arange(10, 121, 10, dtype=float))
    return list((np.arange(n_echo) + 1) * 10.0)


# --------------------------------------------------------------------------- #
# Main window
# --------------------------------------------------------------------------- #
class T2Explorer(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("T2 voxel explorer")
        self.resize(1680, 920)

        # data state
        self.stacked = None
        self.affine = None
        self.echo_files = []
        self.TE_ms = None
        self.TE_s = None
        self.seg = None
        self.sigma_global = None
        self.t2_all = self.t2_good = self.r2_all = None
        self.chi2_all = self.noise_all = self.rmse_all = None
        self.sel = (0, 0, 0)
        self.sel_fit = None
        # in-plane view transform
        self.rot_k = 0          # number of 90-deg rotations (np.rot90)
        self.flip_lr = False
        self.flip_ud = False
        self._scalebar = None   # AnchoredSizeBar artist on the anatomy panel

        self._build_ui()
        self._build_menu()
        self._set_controls_enabled(False)

    # ---------------------------------------------------------------- UI ---- #
    def _build_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)
        root.setContentsMargins(10, 8, 10, 6)
        root.setSpacing(8)

        # ---- row: data controls ----
        row_top = QHBoxLayout()
        row_top.addWidget(QLabel("Slice"))
        self.slice_slider = QSlider(Qt.Horizontal)
        self.slice_slider.setMinimum(1)
        self.slice_slider.setMaximum(1)
        self.slice_slider.setFixedWidth(220)
        self.slice_slider.valueChanged.connect(self._on_slice)
        row_top.addWidget(self.slice_slider)
        self.slice_lbl = QLabel("- / -")
        row_top.addWidget(self.slice_lbl)

        row_top.addSpacing(18)
        row_top.addWidget(QLabel("Mask"))
        self.mask_combo = QComboBox()
        self.mask_combo.setMinimumWidth(200)
        self.mask_combo.currentIndexChanged.connect(self._on_mask)
        row_top.addWidget(self.mask_combo)

        row_top.addSpacing(18)
        self.overlay_chk = QCheckBox("Overlay on anatomy")
        self.overlay_chk.setChecked(True)
        self.overlay_chk.stateChanged.connect(self.refresh)
        row_top.addWidget(self.overlay_chk)
        row_top.addWidget(QLabel("Alpha"))
        self.alpha_slider = QSlider(Qt.Horizontal)
        self.alpha_slider.setMinimum(0)
        self.alpha_slider.setMaximum(100)
        self.alpha_slider.setValue(45)
        self.alpha_slider.setFixedWidth(110)
        self.alpha_slider.valueChanged.connect(self.refresh)
        row_top.addWidget(self.alpha_slider)
        self.alpha_lbl = QLabel("0.45")
        row_top.addWidget(self.alpha_lbl)

        row_top.addSpacing(18)
        row_top.addWidget(QLabel("TE (ms)"))
        self.te_edit = QLineEdit()
        self.te_edit.setMinimumWidth(240)
        self.te_edit.setPlaceholderText("comma-separated echo times")
        self.te_edit.editingFinished.connect(self._on_te_edit)
        row_top.addWidget(self.te_edit)
        self.recompute_btn = QPushButton("Recompute")
        self.recompute_btn.clicked.connect(self._compute_maps)
        row_top.addWidget(self.recompute_btn)
        row_top.addStretch(1)
        root.addLayout(row_top)

        # ---- row: view (rotate/flip) + thresholds ----
        row_view = QHBoxLayout()
        row_view.addWidget(QLabel("View"))
        self.rotL_btn = QPushButton("\u21ba 90")
        self.rotL_btn.clicked.connect(lambda: self._rotate(+1))
        row_view.addWidget(self.rotL_btn)
        self.rotR_btn = QPushButton("90 \u21bb")
        self.rotR_btn.clicked.connect(lambda: self._rotate(-1))
        row_view.addWidget(self.rotR_btn)
        self.fliph_btn = QPushButton("Flip H")
        self.fliph_btn.clicked.connect(lambda: self._flip("h"))
        row_view.addWidget(self.fliph_btn)
        self.flipv_btn = QPushButton("Flip V")
        self.flipv_btn.clicked.connect(lambda: self._flip("v"))
        row_view.addWidget(self.flipv_btn)
        self.resetview_btn = QPushButton("Reset view")
        self.resetview_btn.clicked.connect(self._reset_view)
        row_view.addWidget(self.resetview_btn)

        row_view.addSpacing(24)
        row_view.addWidget(QLabel("T2 min"))
        self.tmin_edit = QLineEdit("15")
        self.tmin_edit.setValidator(QDoubleValidator())
        self.tmin_edit.setFixedWidth(60)
        self.tmin_edit.editingFinished.connect(self.refresh)
        row_view.addWidget(self.tmin_edit)
        row_view.addWidget(QLabel("T2 max"))
        self.tmax_edit = QLineEdit("65")
        self.tmax_edit.setValidator(QDoubleValidator())
        self.tmax_edit.setFixedWidth(60)
        self.tmax_edit.editingFinished.connect(self.refresh)
        row_view.addWidget(self.tmax_edit)
        self.reset_btn = QPushButton("Reset T2")
        self.reset_btn.clicked.connect(self._reset_thresholds)
        row_view.addWidget(self.reset_btn)
        self.ignore_chk = QCheckBox("Ignore T2 threshold")
        self.ignore_chk.stateChanged.connect(self.refresh)
        row_view.addWidget(self.ignore_chk)
        row_view.addStretch(1)
        root.addLayout(row_view)

        # ---- row: jumps ----
        row_jump = QHBoxLayout()
        row_jump.addWidget(QLabel("Target T2"))
        self.target_edit = QLineEdit("80")
        self.target_edit.setValidator(QDoubleValidator())
        self.target_edit.setFixedWidth(60)
        row_jump.addWidget(self.target_edit)
        b = QPushButton("Jump to closest T2")
        b.clicked.connect(self._jump_closest)
        row_jump.addWidget(b)
        b = QPushButton("Global median")
        b.clicked.connect(lambda: self._jump_median(scope="global"))
        row_jump.addWidget(b)
        b = QPushButton("Slice median")
        b.clicked.connect(lambda: self._jump_median(scope="slice"))
        row_jump.addWidget(b)
        b = QPushButton("Highest in slice")
        b.clicked.connect(lambda: self._jump_highest(scope="slice"))
        row_jump.addWidget(b)
        b = QPushButton("Highest global")
        b.clicked.connect(lambda: self._jump_highest(scope="global"))
        row_jump.addWidget(b)
        row_jump.addStretch(1)
        root.addLayout(row_jump)

        # ---- middle: canvas + stats sidebar ----
        mid = QHBoxLayout()
        mid.setSpacing(10)

        leftcol = QVBoxLayout()
        self.fig = Figure(figsize=(13, 6))
        self.fig.patch.set_facecolor(FIG_BG)
        self.canvas = FigureCanvas(self.fig)
        self.canvas.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        gs = self.fig.add_gridspec(2, 26, height_ratios=[3, 1])
        self.ax_anat = self.fig.add_subplot(gs[0:2, 0:8])
        self.cax = self.fig.add_subplot(gs[0:2, 8:9])
        self.ax_fit = self.fig.add_subplot(gs[0, 11:17])
        self.ax_resid = self.fig.add_subplot(gs[1, 11:17], sharex=self.ax_fit)
        self.ax_scat = self.fig.add_subplot(gs[0:2, 19:26])
        self.fig.subplots_adjust(left=0.04, right=0.98, top=0.90,
                                 bottom=0.12, wspace=0.5, hspace=0.12)
        self.canvas.mpl_connect("button_press_event", self._on_click)
        self.ax_anat.callbacks.connect("xlim_changed", self._on_anat_zoom)
        leftcol.addWidget(self.canvas, stretch=1)
        leftcol.addWidget(NavToolbar(self.canvas, self))
        mid.addLayout(leftcol, stretch=1)

        mid.addWidget(self._build_stats_panel())
        root.addLayout(mid, stretch=1)

        self._apply_styles()

    def _build_stats_panel(self):
        panel = QFrame()
        panel.setObjectName("statsPanel")
        panel.setFixedWidth(300)
        v = QVBoxLayout(panel)
        v.setContentsMargins(14, 14, 14, 14)
        v.setSpacing(6)

        mono = QFont("Menlo")
        mono.setStyleHint(QFont.Monospace)
        mono.setPointSize(11)

        def header(text):
            h = QLabel(text)
            h.setObjectName("statsHeader")
            return h

        v.addWidget(header("SELECTED VOXEL"))
        self.sel_stats_lbl = QLabel("-")
        self.sel_stats_lbl.setFont(mono)
        self.sel_stats_lbl.setTextInteractionFlags(Qt.TextSelectableByMouse)
        v.addWidget(self.sel_stats_lbl)

        v.addSpacing(10)
        v.addWidget(header("ROI SUMMARY"))
        self.roi_stats_lbl = QLabel("-")
        self.roi_stats_lbl.setFont(mono)
        self.roi_stats_lbl.setTextInteractionFlags(Qt.TextSelectableByMouse)
        v.addWidget(self.roi_stats_lbl)

        v.addSpacing(10)
        v.addWidget(header("DATASET"))
        self.ds_stats_lbl = QLabel("No data loaded.")
        self.ds_stats_lbl.setFont(mono)
        self.ds_stats_lbl.setWordWrap(True)
        self.ds_stats_lbl.setTextInteractionFlags(Qt.TextSelectableByMouse)
        v.addWidget(self.ds_stats_lbl)

        v.addStretch(1)
        return panel

    def _apply_styles(self):
        self.setStyleSheet(f"""
            QMainWindow, QWidget {{
                background-color: {FIG_BG}; color: {TXT};
                font-family: 'Segoe UI', 'Helvetica Neue', Arial; font-size: 13px;
            }}
            QPushButton {{
                background-color: #2b2b40; border: 1px solid #3a3a55;
                border-radius: 6px; padding: 5px 11px;
            }}
            QPushButton:hover {{ background-color: #383857; }}
            QPushButton:pressed {{ background-color: #45456a; }}
            QPushButton:disabled {{ color: #5b5b70; border-color: #2a2a3c; }}
            QLineEdit, QComboBox {{
                background-color: #232333; border: 1px solid #3a3a55;
                border-radius: 5px; padding: 3px 6px; color: {TXT};
            }}
            QComboBox::drop-down {{ border: none; }}
            QSlider::groove:horizontal {{
                height: 6px; background: #2b2b40; border-radius: 3px;
            }}
            QSlider::handle:horizontal {{
                background: {ACCENT}; width: 14px; border-radius: 7px; margin: -5px 0;
            }}
            QCheckBox {{ spacing: 6px; }}
            QMenuBar, QMenu {{ background-color: {SIDE_BG}; color: {TXT}; }}
            QMenu::item:selected {{ background-color: #383857; }}
            QFrame#statsPanel {{
                background-color: {SIDE_BG}; border: 1px solid #2e2e44;
                border-radius: 10px;
            }}
            QLabel#statsHeader {{
                color: {ACCENT}; font-weight: 600; font-size: 11px;
                letter-spacing: 1px;
            }}
            QToolBar {{ background: {FIG_BG}; border: none; }}
        """)

    def _build_menu(self):
        m = self.menuBar().addMenu("File")
        for text, fn in (("Open echo folder...", self.open_echo_folder),
                         ("Open segmentation...", self.open_segmentation)):
            a = QAction(text, self); a.triggered.connect(fn); m.addAction(a)
        m.addSeparator()
        a = QAction("Load synthetic demo", self); a.triggered.connect(self.load_demo)
        m.addAction(a)
        m.addSeparator()
        a = QAction("Export panel images (PNG)...", self)
        a.triggered.connect(self.export_panels); m.addAction(a)
        a = QAction("Export T2 data (.npy + .csv)...", self)
        a.triggered.connect(self.export_t2_data); m.addAction(a)

    def _set_controls_enabled(self, on):
        for w in (self.slice_slider, self.mask_combo, self.overlay_chk,
                  self.alpha_slider, self.te_edit, self.recompute_btn,
                  self.rotL_btn, self.rotR_btn, self.fliph_btn, self.flipv_btn,
                  self.resetview_btn, self.tmin_edit, self.tmax_edit,
                  self.reset_btn, self.ignore_chk, self.target_edit):
            w.setEnabled(on)

    # --------------------------------------------------- view transform ---- #
    def _view_transform(self, img2d):
        out = np.rot90(img2d, k=self.rot_k)
        if self.flip_lr:
            out = np.fliplr(out)
        if self.flip_ud:
            out = np.flipud(out)
        return out

    def _index_grids(self):
        """Transformed (row, col) index grids: for each displayed pixel, which
        original voxel it came from. Used to invert clicks and place markers."""
        nx, ny = self.stacked.shape[0], self.stacked.shape[1]
        rr, cc = np.meshgrid(np.arange(nx), np.arange(ny), indexing="ij")
        return self._view_transform(rr), self._view_transform(cc)

    # ------------------------------------- orientation / scale / colorbar -- #
    def _screen_world_vectors(self):
        """World-space (RAS) vectors for moving +1 pixel RIGHT and +1 pixel DOWN
        on the displayed (possibly rotated/flipped) anatomy image. Returns
        (right_vec, down_vec) or (None, None)."""
        if self.stacked is None or self.affine is None:
            return None, None
        rr_t, cc_t = self._index_grids()
        if rr_t.shape[0] < 2 or rr_t.shape[1] < 2:
            return None, None
        v_row = self.affine[:3, 0]          # world per +1 original row (axis 0)
        v_col = self.affine[:3, 1]          # world per +1 original col (axis 1)
        # how original (row, col) change when moving one displayed pixel
        drow_dc = rr_t[0, 1] - rr_t[0, 0]; dcol_dc = cc_t[0, 1] - cc_t[0, 0]
        drow_dr = rr_t[1, 0] - rr_t[0, 0]; dcol_dr = cc_t[1, 0] - cc_t[0, 0]
        wr = drow_dc * v_row + dcol_dc * v_col      # world per +1 screen-right
        wd = drow_dr * v_row + dcol_dr * v_col      # world per +1 screen-down
        return wr, wd

    @staticmethod
    def _nice_number(x):
        """Round to a 'nice' 1 / 2 / 5 x 10^k value for scale-bar lengths."""
        if x <= 0 or not np.isfinite(x):
            return 1.0
        exp = np.floor(np.log10(x))
        f = x / (10 ** exp)
        nf = 1 if f < 1.5 else 2 if f < 3.5 else 5 if f < 7.5 else 10
        return nf * (10 ** exp)

    def _draw_orientation(self):
        """Place anatomical L / R markers based on the header (RAS +X = Right)."""
        wr, wd = self._screen_world_vectors()
        if wr is None:
            return
        style = dict(color="white", fontsize=13, fontweight="bold",
                     ha="center", va="center", transform=self.ax_anat.transAxes)
        stroke = [pe.withStroke(linewidth=2.5, foreground="black")]
        if abs(wr[0]) >= abs(wd[0]):            # L/R lies along horizontal axis
            right_is_R = wr[0] > 0
            t1 = self.ax_anat.text(0.965, 0.5, "R" if right_is_R else "L", **style)
            t2 = self.ax_anat.text(0.035, 0.5, "L" if right_is_R else "R", **style)
        else:                                   # L/R lies along vertical axis
            bottom_is_R = wd[0] > 0
            t1 = self.ax_anat.text(0.5, 0.035, "R" if bottom_is_R else "L", **style)
            t2 = self.ax_anat.text(0.5, 0.965, "L" if bottom_is_R else "R", **style)
        for t in (t1, t2):
            t.set_path_effects(stroke)

    def _add_scalebar(self):
        """Add / refresh a physical-distance scale bar sized to the current zoom."""
        ax = self.ax_anat
        if self._scalebar is not None:
            try:
                self._scalebar.remove()
            except Exception:
                pass
            self._scalebar = None
        wr, _ = self._screen_world_vectors()
        if wr is None:
            return
        mm_per_px = float(np.linalg.norm(wr))    # mm per displayed pixel (x)
        if mm_per_px <= 0 or not np.isfinite(mm_per_px):
            return
        xlo, xhi = sorted(ax.get_xlim())
        nice_mm = self._nice_number(0.25 * (xhi - xlo) * mm_per_px)
        bar_len_vox = nice_mm / mm_per_px        # bar length in data (voxel) units
        sb = AnchoredSizeBar(ax.transData, bar_len_vox, f"{nice_mm:g} mm",
                             loc="lower right", pad=0.4, borderpad=0.6, sep=4,
                             color="white", frameon=False,
                             size_vertical=max(0.4, (xhi - xlo) * 0.004),
                             fontproperties=fm.FontProperties(size=9))
        ax.add_artist(sb)
        self._scalebar = sb

    def _on_anat_zoom(self, _ax):
        """Rescale the scale bar whenever the anatomy panel is zoomed/panned."""
        self._add_scalebar()
        self.canvas.draw_idle()

    def _match_colorbar_height(self):
        """Shrink the colorbar axes so its height matches the drawn image, not
        the full (letterboxed) anatomy panel."""
        try:
            if not self.ax_anat.images:
                return
            rend = self.canvas.get_renderer()
            if rend is None:
                return
            ext = self.ax_anat.images[0].get_window_extent(rend)
            inv = self.fig.transFigure.inverted()
            (_, y0) = inv.transform((ext.x0, ext.y0))
            (_, y1) = inv.transform((ext.x1, ext.y1))
            pos = self.cax.get_position()
            self.cax.set_position([pos.x0, y0, pos.width, max(1e-3, y1 - y0)])
        except Exception:
            pass

    def _select_nearest_scatter(self, ev):
        """Select the active voxel whose plotted dot is nearest the click in
        screen (pixel) space -- true absolute-position selection."""
        idx, vals = self._active_idx()
        if vals.size == 0:
            return
        jitter = np.random.RandomState(0).uniform(0, 1, vals.size)
        pts = self.ax_scat.transData.transform(np.column_stack([jitter, vals]))
        d2 = (pts[:, 0] - ev.x) ** 2 + (pts[:, 1] - ev.y) ** 2
        self._set_selection(*idx[int(np.argmin(d2))])

    def _rotate(self, direction):
        self.rot_k = (self.rot_k + direction) % 4
        self.refresh()

    def _flip(self, axis):
        if axis == "h":
            self.flip_lr = not self.flip_lr
        else:
            self.flip_ud = not self.flip_ud
        self.refresh()

    def _reset_view(self):
        self.rot_k = 0
        self.flip_lr = self.flip_ud = False
        self.refresh()

    # ------------------------------------------------------------- loading -- #
    def open_echo_folder(self):
        folder = QFileDialog.getExistingDirectory(self, "Folder of per-echo NIfTIs")
        if not folder:
            return
        try:
            stacked, affine, files = load_echo_folder(folder)
        except Exception as e:
            QMessageBox.critical(self, "Echo load failed", str(e))
            return
        self.stacked, self.affine, self.echo_files = stacked, affine, files
        n_echo = stacked.shape[-1]
        self.TE_ms = np.array(default_TEs(n_echo), dtype=float)
        self.TE_s = self.TE_ms / 1000.0
        self.te_edit.setText(", ".join(f"{t:g}" for t in self.TE_ms))
        print("Echo files (in fit order):")
        for f, te in zip(files, self.TE_ms):
            print(f"  TE={te:6.1f} ms   {os.path.basename(f)}")
        self.seg = None
        self.mask_combo.clear()
        self._clear_maps()
        self._update_dataset_info()
        self.statusBar().showMessage(
            f"Loaded {n_echo} echoes, volume {stacked.shape[:3]}. "
            "Now load a segmentation.", 8000)

    def open_segmentation(self):
        if self.stacked is None:
            QMessageBox.information(self, "Load echoes first",
                                    "Open the per-echo folder before the segmentation.")
            return
        path, _ = QFileDialog.getOpenFileName(
            self, "Segmentation NIfTI", "", "NIfTI (*.nii *.nii.gz)")
        if not path:
            return
        try:
            seg = np.asarray(nib.load(path).get_fdata())
        except Exception as e:
            QMessageBox.critical(self, "Segmentation load failed", str(e))
            return
        if seg.shape != self.stacked.shape[:3]:
            QMessageBox.critical(
                self, "Shape mismatch",
                f"Segmentation {seg.shape} does not match the images "
                f"{self.stacked.shape[:3]}.")
            return
        self.seg = seg
        self.seg_path = path
        labels = sorted(int(v) for v in np.unique(seg) if v != 0)
        self.mask_combo.blockSignals(True)
        self.mask_combo.clear()
        self.mask_combo.addItem("All (label > 0)", userData=None)
        for L in labels:
            self.mask_combo.addItem(f"label {L}", userData=L)
        self.mask_combo.blockSignals(False)
        self._compute_maps()

    def load_demo(self):
        X = Y = 96
        Z = 20
        TE = np.arange(10, 121, 10, dtype=float)
        yy, xx = np.mgrid[0:X, 0:Y]
        stacked = np.zeros((X, Y, Z, len(TE)))
        seg = np.zeros((X, Y, Z))
        rng = np.random.default_rng(0)
        for z in range(Z):
            cx, cy = X / 2 + 6 * np.sin(z / 3), Y / 2
            blob = ((xx - cx) ** 2 / 8 ** 2 + (yy - cy) ** 2 / 18 ** 2) < 1
            seg[blob, z] = 1
            t2_true = 35 + 6 * rng.standard_normal(blob.sum())
            sig = 9000.0 * np.exp(-TE[None, :] / t2_true[:, None]) + 250.0
            sig += rng.normal(0, 90, sig.shape)
            for (a, b), row in zip(np.argwhere(blob), sig):
                stacked[a, b, z, :] = row
        stacked += rng.normal(800, 60, stacked.shape).clip(min=0)
        self.stacked = stacked
        self.affine = np.eye(4)
        self.echo_files = [f"demo_E{i}" for i in range(len(TE))]
        self.TE_ms = TE
        self.TE_s = TE / 1000.0
        self.te_edit.setText(", ".join(f"{t:g}" for t in TE))
        self.seg = seg
        self.seg_path = "(synthetic demo)"
        self.mask_combo.blockSignals(True)
        self.mask_combo.clear()
        self.mask_combo.addItem("All (label > 0)", userData=None)
        self.mask_combo.addItem("label 1", userData=1)
        self.mask_combo.blockSignals(False)
        self._compute_maps()

    def _on_te_edit(self):
        if self.stacked is None:
            return
        txt = self.te_edit.text().replace(",", " ").split()
        try:
            tes = np.array([float(t) for t in txt], dtype=float)
        except ValueError:
            return
        if tes.size != self.stacked.shape[-1]:
            QMessageBox.warning(self, "TE count mismatch",
                                f"Entered {tes.size} TEs but there are "
                                f"{self.stacked.shape[-1]} echoes.")
            return
        self.TE_ms = tes
        self.TE_s = tes / 1000.0

    # --------------------------------------------------------- computation -- #
    def _clear_maps(self):
        self.t2_all = self.t2_good = self.r2_all = None
        self.chi2_all = self.noise_all = self.rmse_all = None

    def _estimate_sigma(self):
        first = self.stacked[..., 0]
        bg = first[self.seg == 0] if self.seg is not None else first.ravel()
        bg = bg[np.isfinite(bg)]
        if bg.size < 50:
            return None
        med = np.median(bg)
        mad = np.median(np.abs(bg - med))
        return float(1.4826 * mad) if mad > 0 else float(np.std(bg))

    def _compute_maps(self):
        if self.stacked is None or self.seg is None or self.TE_s is None:
            return
        idx = np.argwhere(self.seg > 0)
        if idx.size == 0:
            QMessageBox.warning(self, "Empty ROI", "The segmentation has no nonzero voxels.")
            return
        self.sigma_global = self._estimate_sigma()
        shape = self.stacked.shape[:3]
        self.t2_all = np.full(shape, np.nan)
        self.t2_good = np.full(shape, np.nan)
        self.r2_all = np.full(shape, np.nan)
        self.chi2_all = np.full(shape, np.nan)
        self.noise_all = np.full(shape, np.nan)
        self.rmse_all = np.full(shape, np.nan)

        prog = QProgressDialog("Fitting ROI voxels...", "Cancel", 0, len(idx), self)
        prog.setWindowModality(Qt.WindowModal)
        prog.setMinimumDuration(0)
        step = max(1, len(idx) // 200)
        for i, (x, y, z) in enumerate(idx):
            if i % step == 0:
                prog.setValue(i)
                if prog.wasCanceled():
                    break
            res = fit_voxel(self.stacked[x, y, z, :], self.TE_s, self.sigma_global)
            if res is None:
                continue
            t2 = res["t2"]
            self.r2_all[x, y, z] = res["r2"]
            self.chi2_all[x, y, z] = res["chi2"]
            self.noise_all[x, y, z] = res["noise"]
            self.rmse_all[x, y, z] = res["rmse"]
            if FitCfg.LOW_THRESH_MS < t2 < FitCfg.HIGH_THRESH_MS:
                self.t2_all[x, y, z] = t2
                if np.isfinite(res["r2"]) and res["r2"] >= FitCfg.R2_FIT_THRESH:
                    self.t2_good[x, y, z] = t2
        prog.setValue(len(idx))

        self.slice_slider.blockSignals(True)
        self.slice_slider.setMaximum(shape[2])
        self.slice_slider.blockSignals(False)
        self._set_controls_enabled(True)
        self._reset_thresholds(refresh=False)
        self._jump_median(scope="global")
        self._update_dataset_info()

    # ------------------------------------------------------------- helpers -- #
    def _roi(self):
        if self.seg is None:
            return None
        L = self.mask_combo.currentData()
        return (self.seg > 0) if L is None else (self.seg == L)

    def _active_idx(self):
        roi = self._roi()
        if roi is None or self.t2_good is None:
            return np.empty((0, 3), int), np.empty(0)
        m = roi & np.isfinite(self.t2_good)
        return np.argwhere(m), self.t2_good[m]

    def _thr(self):
        try:
            lo = float(self.tmin_edit.text())
            hi = float(self.tmax_edit.text())
        except ValueError:
            lo, hi = 15.0, 65.0
        if hi <= lo:
            hi = lo + 1.0
        return lo, hi

    def _color_range(self):
        """vmin/vmax for the overlay + colorbar (respects 'ignore threshold')."""
        if self.ignore_chk.isChecked():
            _, vals = self._active_idx()
            if vals.size:
                return float(np.nanmin(vals)), float(np.nanmax(vals))
        return self._thr()

    def _reset_thresholds(self, refresh=True):
        _, vals = self._active_idx()
        if vals.size:
            lo, hi = np.percentile(vals, [2, 98])
            self.tmin_edit.setText(f"{lo:.0f}")
            self.tmax_edit.setText(f"{hi:.0f}")
        if refresh:
            self.refresh()

    def _set_selection(self, x, y, z):
        self.sel = (int(x), int(y), int(z))
        self.slice_slider.blockSignals(True)
        self.slice_slider.setValue(int(z) + 1)
        self.slice_slider.blockSignals(False)
        self.refresh()

    def _select_by_t2(self, target_t2):
        if target_t2 is None or not np.isfinite(target_t2):
            return
        idx, vals = self._active_idx()
        if vals.size == 0:
            return
        self._set_selection(*idx[int(np.argmin(np.abs(vals - target_t2)))])

    # ----------------------------------------------------------- callbacks -- #
    def _on_slice(self, val):
        x, y, _ = self.sel
        self.sel = (x, y, val - 1)
        self.refresh()

    def _on_mask(self, _):
        self.refresh()

    def _on_click(self, ev):
        if self.stacked is None or ev.inaxes is None:
            return
        if ev.xdata is None or ev.ydata is None:
            return
        if ev.inaxes is self.ax_anat:
            rr_t, cc_t = self._index_grids()
            drow = int(round(ev.ydata))
            dcol = int(round(ev.xdata))
            if 0 <= drow < rr_t.shape[0] and 0 <= dcol < rr_t.shape[1]:
                self.sel = (int(rr_t[drow, dcol]), int(cc_t[drow, dcol]), self.sel[2])
                self.refresh()
            return
        if ev.inaxes is self.ax_scat:
            self._select_nearest_scatter(ev)
            return

    def _jump_median(self, scope="global"):
        idx, vals = self._active_idx()
        if vals.size == 0:
            return
        if scope == "slice":
            m = idx[:, 2] == self.sel[2]
            if not m.any():
                return
            idx, vals = idx[m], vals[m]
        self._set_selection(*idx[int(np.argmin(np.abs(vals - np.median(vals))))])

    def _jump_closest(self):
        try:
            self._select_by_t2(float(self.target_edit.text()))
        except ValueError:
            pass

    def _jump_highest(self, scope="global"):
        idx, vals = self._active_idx()
        if vals.size == 0:
            return
        if scope == "slice":
            m = idx[:, 2] == self.sel[2]
            if not m.any():
                return
            idx, vals = idx[m], vals[m]
        self._set_selection(*idx[int(np.argmax(vals))])

    # ------------------------------------------------------------- drawing -- #
    def _style_ax(self, ax, title="", xlabel="", ylabel=""):
        ax.set_facecolor(PANEL_BG)
        ax.set_title(title, color=TXT, fontsize=11, pad=8)
        ax.set_xlabel(xlabel, color=MUTED, fontsize=9)
        ax.set_ylabel(ylabel, color=MUTED, fontsize=9)
        for s in ax.spines.values():
            s.set_color(GRID)
        ax.tick_params(colors=MUTED, labelsize=8)

    def refresh(self):
        self.alpha_lbl.setText(f"{self.alpha_slider.value() / 100:.2f}")
        if self.stacked is None:
            self.canvas.draw_idle()
            return
        x, y, z = self.sel
        self.slice_lbl.setText(f"{z + 1} / {self.stacked.shape[2]}")
        self.sel_fit = fit_voxel(self.stacked[x, y, z, :], self.TE_s, self.sigma_global)
        self._draw_images()
        self._draw_fit()
        self._draw_resid()
        self._draw_dist()
        self._update_readout()
        self.canvas.draw()
        self._match_colorbar_height()
        self.canvas.draw_idle()

    def _draw_images(self):
        x, y, z = self.sel
        cmin, cmax = self._color_range()

        anat = self._view_transform(self.stacked[:, :, z, 0])
        a_lo, a_hi = np.percentile(anat, [1, 99])

        self.ax_anat.clear()
        self.ax_anat.imshow(anat, cmap="gray", vmin=a_lo, vmax=a_hi)
        cmap = get_cmap("viridis")
        if self.overlay_chk.isChecked() and self.t2_good is not None:
            roi = self._roi()
            disp = np.where(roi[:, :, z], self.t2_good[:, :, z], np.nan)
            disp = self._view_transform(disp)
            cmap.set_bad((0, 0, 0, 0))
            self.ax_anat.imshow(np.ma.masked_invalid(disp), cmap=cmap,
                                vmin=cmin, vmax=cmax,
                                alpha=self.alpha_slider.value() / 100)
        rr_t, cc_t = self._index_grids()
        hit = np.argwhere((rr_t == x) & (cc_t == y))
        if len(hit):
            dr, dc = hit[0]
            self.ax_anat.plot(dc, dr, "+", color="#ff5252", ms=13, mew=1.8)
        rot_txt = f"rot {self.rot_k*90}\u00b0" + (" H" if self.flip_lr else "") + (" V" if self.flip_ud else "")
        self._style_ax(self.ax_anat, f"Anatomy + T2 overlay | slice {z+1} | {rot_txt}")
        self._scalebar = None          # cleared by ax.clear(); rebuild below
        self._draw_orientation()
        self._add_scalebar()

        self.cax.clear()
        sm = mpl_cm.ScalarMappable(norm=Normalize(cmin, cmax), cmap=get_cmap("viridis"))
        cb = self.fig.colorbar(sm, cax=self.cax)
        cb.set_label("T2 (ms)", color=MUTED, fontsize=9)
        self.cax.tick_params(colors=MUTED, labelsize=8)
        for s in self.cax.spines.values():
            s.set_color(GRID)

    def _draw_fit(self):
        x, y, z = self.sel
        self.ax_fit.clear()
        if self.sel_fit is not None and self.TE_ms is not None:
            raw = self.stacked[x, y, z, :]
            self.ax_fit.plot(self.TE_ms, raw, "o", color=C_MEAS, label="Measured")
            te_fine = np.linspace(self.TE_ms.min(), self.TE_ms.max(), 200)
            self.ax_fit.plot(te_fine, model(te_fine / 1000.0, *self.sel_fit["popt"]),
                             "-", color=C_FIT, lw=2, label="Fitted")
            leg = self.ax_fit.legend(loc="upper right", fontsize=8,
                                     facecolor=PANEL_BG, edgecolor=GRID)
            for t in leg.get_texts():
                t.set_color(TXT)
        self.ax_fit.grid(True, alpha=0.15, color=GRID)
        self._style_ax(self.ax_fit, f"Voxel signal vs fit  [{x} {y} {z}]",
                       "", "Signal")
        # x-axis is shared with the residual panel below, so hide it here
        self.ax_fit.tick_params(labelbottom=False)

    def _draw_resid(self):
        x, y, z = self.sel
        self.ax_resid.clear()
        if self.sel_fit is not None and self.TE_ms is not None:
            raw = self.stacked[x, y, z, :]
            resid = raw - self.sel_fit["pred"]
            self.ax_resid.axhline(0, color=MUTED, lw=1)
            for te, r in zip(self.TE_ms, resid):
                self.ax_resid.plot([te, te], [0, r], "-", color=C_RESID, lw=1)
            self.ax_resid.plot(self.TE_ms, resid, "o", color=C_RESID, ms=4)
        self.ax_resid.grid(True, alpha=0.15, color=GRID)
        self._style_ax(self.ax_resid, "", "TE (ms)", "Residual")

    def _draw_dist(self):
        idx, vals = self._active_idx()
        lo, hi = self._thr()
        ignore = self.ignore_chk.isChecked()
        sel_t2 = self.sel_fit["t2"] if self.sel_fit is not None else None

        self.ax_scat.clear()
        if vals.size:
            jitter = np.random.RandomState(0).uniform(0, 1, vals.size)
            if ignore:
                self.ax_scat.scatter(jitter, vals, s=7, alpha=0.55, color=C_PT)
            else:
                out = (vals < lo) | (vals > hi)
                self.ax_scat.scatter(jitter[~out], vals[~out], s=7, alpha=0.55, color=C_PT)
                if out.any():
                    self.ax_scat.scatter(jitter[out], vals[out], s=14, color=C_OUT)
            if sel_t2 is not None and np.isfinite(sel_t2):
                self.ax_scat.axhline(sel_t2, color="#ff5252", lw=0.9, alpha=0.6)
                # find the selected voxel's row in the active list so the circle
                # lands on its actual dot (its jitter x), not the graph center
                sel_arr = np.array(self.sel)
                match = np.argwhere(np.all(idx == sel_arr, axis=1))
                sel_x = float(jitter[match[0, 0]]) if len(match) else 0.5
                self.ax_scat.plot(sel_x, sel_t2, "o", mfc="none",
                                  mec="#ff5252", ms=13, mew=2)
        self.ax_scat.set_xticks([])
        self.ax_scat.grid(True, axis="y", alpha=0.15, color=GRID)
        self._style_ax(self.ax_scat,
                       f"T2 distribution (n={vals.size}) | click to select",
                       "active voxels", "T2 (ms)")

    def _update_readout(self):
        x, y, z = self.sel
        roi = self._roi()
        active = bool(roi is not None and roi[x, y, z]
                      and self.t2_good is not None
                      and np.isfinite(self.t2_good[x, y, z]))
        if self.sel_fit is not None:
            f = self.sel_fit
            self.sel_stats_lbl.setText(
                f"[r c s] = [{x} {y} {z}]\n"
                f"active   = {'yes' if active else 'no'}\n"
                f"T2       = {f['t2']:8.2f} ms\n"
                f"chi^2    = {f['chi2']:8.2f}\n"
                f"noise C  = {f['noise']:8.1f}\n"
                f"fit R^2  = {f['r2']:8.3f}\n"
                f"RMSE     = {f['rmse']:8.1f}")
        else:
            self.sel_stats_lbl.setText(f"[r c s] = [{x} {y} {z}]\n"
                                       "(no successful fit here)")

        _, vals = self._active_idx()
        if vals.size:
            self.roi_stats_lbl.setText(
                f"n        = {vals.size}\n"
                f"median   = {np.median(vals):8.2f} ms\n"
                f"IQR      = {np.percentile(vals,75)-np.percentile(vals,25):8.2f}\n"
                f"mean     = {np.mean(vals):8.2f}\n"
                f"std      = {np.std(vals):8.2f}")
        else:
            self.roi_stats_lbl.setText("no active voxels")

    def _update_dataset_info(self):
        if self.stacked is None:
            self.ds_stats_lbl.setText("No data loaded.")
            return
        seg = os.path.basename(getattr(self, "seg_path", "-")) if self.seg is not None else "-"
        sig = f"{self.sigma_global:.1f}" if self.sigma_global else "n/a"
        self.ds_stats_lbl.setText(
            f"echoes = {self.stacked.shape[-1]}\n"
            f"volume = {self.stacked.shape[:3]}\n"
            f"mask   = {seg}\n"
            f"sigma  = {sig}\n"
            f"anat   = echo 1")

    # ------------------------------------------------------------- export --- #
    def export_panels(self):
        if self.stacked is None:
            QMessageBox.information(self, "Nothing to export", "Load data first.")
            return
        folder = QFileDialog.getExistingDirectory(self, "Export panel PNGs to folder")
        if not folder:
            return
        self.canvas.draw()
        rend = self.canvas.get_renderer()
        inv = self.fig.dpi_scale_trans.inverted()
        anat_bbox = Bbox.union([self.ax_anat.get_tightbbox(rend),
                                self.cax.get_tightbbox(rend)]).transformed(inv)
        targets = [("anatomy_overlay", anat_bbox),
                   ("voxel_fit", self.ax_fit.get_tightbbox(rend).transformed(inv)),
                   ("voxel_residuals", self.ax_resid.get_tightbbox(rend).transformed(inv)),
                   ("t2_distribution", self.ax_scat.get_tightbbox(rend).transformed(inv))]
        for name, bbox in targets:
            self.fig.savefig(os.path.join(folder, f"{name}.png"), dpi=200,
                             bbox_inches=bbox.expanded(1.08, 1.08),
                             facecolor=self.fig.get_facecolor())
        self.fig.savefig(os.path.join(folder, "all_panels.png"), dpi=200,
                         facecolor=self.fig.get_facecolor())
        QMessageBox.information(self, "Exported",
                                "Saved anatomy_overlay.png, voxel_fit.png, "
                                "t2_distribution.png, all_panels.png")

    def export_t2_data(self):
        if self.t2_good is None:
            QMessageBox.information(self, "Nothing to export", "Compute a map first.")
            return
        folder = QFileDialog.getExistingDirectory(self, "Export T2 data to folder")
        if not folder:
            return
        roi = self._roi()
        t2_roi = np.where(roi, self.t2_good, np.nan).astype(np.float32)

        np.save(os.path.join(folder, "t2map_good.npy"), t2_roi)
        nib.save(nib.Nifti1Image(t2_roi, self.affine),
                 os.path.join(folder, "t2map_good.nii.gz"))
        idx, _ = self._active_idx()
        import csv
        with open(os.path.join(folder, "t2_voxel_table.csv"), "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["row", "col", "slice", "T2_ms", "fitR2", "chi2", "noise_C", "RMSE"])
            for (x, y, z) in idx:
                w.writerow([x, y, z,
                            f"{self.t2_good[x, y, z]:.4f}",
                            f"{self.r2_all[x, y, z]:.4f}",
                            f"{self.chi2_all[x, y, z]:.4f}",
                            f"{self.noise_all[x, y, z]:.4f}",
                            f"{self.rmse_all[x, y, z]:.4f}"])
        _, vals = self._active_idx()
        summ = (f"n={vals.size}, median={np.median(vals):.2f} ms, "
                f"IQR={np.percentile(vals,75)-np.percentile(vals,25):.2f}") if vals.size else "no active voxels"
        QMessageBox.information(self, "Exported",
                                f"Saved t2map_good.npy, t2map_good.nii.gz, "
                                f"t2_voxel_table.csv\n\n{summ}")


def main():
    app = QApplication(sys.argv)
    win = T2Explorer()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()