"""
Load routes — scan upload (DICOM or NIfTI), segmentation, voxel-space check,
ortho volume delivery, and synthetic demo generation.

NIfTI loading, default TEs, and demo data generation match t2_voxel_explorer.py exactly.
"""
import os
from pathlib import Path
from typing import List, Optional
import numpy as np

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response

from api.sessions import Session, create_session, get_session

router = APIRouter()


# ─────────────────────────────────────────────── helpers ──────────────────────

def _affine_check(aff1: np.ndarray, aff2: np.ndarray,
                  shape1, shape2) -> tuple[str, str]:
    """
    Returns (level, message) where level is "ok", "warn", or "error".

    Rules:
      - Shape mismatch           → "error"  (hard block: voxel indices won't align)
      - Voxel size mismatch >5%  → "warn"   (allow but flag it)
      - Only origin/orientation differs (common when seg tool ignores world coords)
                                 → "warn"   (allow — voxel indices still align)
      - All match                → "ok"
    """
    if list(shape1[:3]) != list(shape2[:3]):
        return "error", (f"Shape mismatch — scan {list(shape1[:3])} "
                         f"vs mask {list(shape2[:3])}. Cannot proceed.")

    vox1 = np.sqrt((aff1[:3, :3] ** 2).sum(axis=0))
    vox2 = np.sqrt((aff2[:3, :3] ** 2).sum(axis=0))

    if not np.allclose(vox1, vox2, rtol=0.05):
        return "warn", (f"Voxel size differs — scan {vox1.round(3)} mm vs "
                        f"mask {vox2.round(3)} mm. Proceeding in voxel space.")

    if not np.allclose(aff1, aff2, atol=0.5):
        return "warn", (f"Shapes match {list(shape1[:3])}, voxel size {vox1.round(3)} mm. "
                        f"World-space origins/orientations differ (common when the "
                        f"segmentation tool uses a different convention). "
                        f"Fitting proceeds in voxel space — labels are aligned.")

    return "ok", (f"Fully aligned — {list(shape1[:3])}, "
                  f"{vox1[0]:.2f} mm iso.")


def _vox_size_str(affine: np.ndarray) -> str:
    vs = np.sqrt((affine[:3, :3] ** 2).sum(axis=0))
    if np.allclose(vs, vs[0], atol=0.01):
        return f"{vs[0]:.2f} mm iso"
    return "×".join(f"{v:.2f}" for v in vs) + " mm"


# ── NIfTI folder loader (matches load_echo_folder in t2_voxel_explorer.py) ───

def _natural_echo_key(path: str) -> int:
    """Sort key: last run of digits in stem (e.g. echo_03.nii → 3)."""
    import re
    nums = re.findall(r"\d+", Path(path).stem)
    return int(nums[-1]) if nums else 0


def _default_TEs(n_echo: int) -> np.ndarray:
    """Default echo times matching t2_voxel_explorer.py default_TEs()."""
    if n_echo == 12:
        return np.arange(10, 121, 10, dtype=float)
    return (np.arange(n_echo) + 1) * 10.0


def _extract_TE_from_stem(stem: str) -> Optional[float]:
    """
    Try to read the echo time in ms directly from a filename stem.
    Handles patterns like:
      F2L_TE_010ms_stitched  →  10.0
      echo_070ms             →  70.0
      te025                  →  25.0
    Falls back to None if no pattern matches.
    """
    import re
    # Pattern: _TE_NNNms_ or _teNNNms or similar
    m = re.search(r'[_\-](?:TE|te|echo)[_\-]?(\d+(?:\.\d+)?)(?:ms|MS)?', stem)
    if m:
        return float(m.group(1))
    return None


def _load_nifti_folder(paths: List[str]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Sort NIfTI files by trailing number, stack into (X,Y,Z,nVol).

    Key behaviour for the F2L dataset:
      - Files named *_TE_NNNms_* → TE extracted from filename
      - 4D files with shape (X,Y,Z,2) → take channel 0 (magnitude)
        because channel 1 is phase; averaging magnitude+phase is wrong
      - 4D files with shape (X,Y,Z,N>2) → take mean (multiple averages)
      - Matching t2_voxel_explorer.py for 3D files and TE defaults
    """
    import nibabel as nib

    paths = sorted(paths, key=_natural_echo_key)
    vols, affine = [], None
    tes_from_name: List[Optional[float]] = []

    for p in paths:
        img = nib.load(p)
        if affine is None:
            affine = img.affine
        d = img.get_fdata()
        if d.ndim == 4:
            if d.shape[3] == 2:
                # Two channels (magnitude + phase from Bruker/Paravision exports).
                # Take the magnitude channel (index 0) — never average with phase.
                d = d[..., 0]
            else:
                # Multiple averages or repetitions → collapse by mean
                d = d.mean(axis=3)
        elif d.ndim != 3:
            raise ValueError(f"{Path(p).name}: expected 3D or 4D, got {d.ndim}D.")
        vols.append(d)
        tes_from_name.append(_extract_TE_from_stem(Path(p).stem))

    shapes = {v.shape for v in vols}
    if len(shapes) != 1:
        raise ValueError(f"Echo volumes have different shapes: {shapes}")

    stacked = np.stack(vols, axis=-1)       # (X, Y, Z, nVol)

    # Use TEs extracted from filenames if ALL could be read; otherwise use defaults
    if all(t is not None for t in tes_from_name):
        acq = np.array(tes_from_name, dtype=float)
    else:
        acq = _default_TEs(len(paths))

    return stacked, affine, acq


# ── DICOM loader ──────────────────────────────────────────────────────────────

def _load_dicom_4d(path: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Load an Enhanced Multi-Frame DICOM into (X,Y,Z,nTE) + affine + TE array."""
    import pydicom

    ds = pydicom.dcmread(path, force=True)
    pixels = ds.pixel_array.astype(np.float32)

    if pixels.ndim == 2:
        te = float(getattr(ds, "EchoTime", 10.0))
        stacked = pixels.T[:, :, np.newaxis, np.newaxis]
        return stacked, _simple_dicom_affine(ds), np.array([te])

    n_frames, rows, cols = pixels.shape
    pfgs = getattr(ds, "PerFrameFunctionalGroupsSequence", None)

    if pfgs and len(pfgs) == n_frames:
        frames_info = [{"te": _frame_echo_time(pfg, i),
                        "loc": _frame_position(pfg, i),
                        "idx": i}
                       for i, pfg in enumerate(pfgs)]
        unique_locs = sorted(set(round(f["loc"], 2) for f in frames_info))
        unique_tes  = sorted(set(f["te"]            for f in frames_info))
        loc_map = {loc: i for i, loc in enumerate(unique_locs)}
        te_map  = {te:  i for i, te  in enumerate(unique_tes)}
        stacked = np.zeros((cols, rows, len(unique_locs), len(unique_tes)), dtype=np.float32)
        for f in frames_info:
            stacked[:, :, loc_map[round(f["loc"],2)], te_map[f["te"]]] = pixels[f["idx"]].T
        return stacked, _enhanced_dicom_affine(ds, pfgs, unique_locs), np.array(unique_tes)

    # Fallback: treat frames as echoes of one slice
    te_list = [float(getattr(ds, "EchoTime", (i+1)*10.0)) for i in range(n_frames)]
    order   = np.argsort(te_list)
    tes     = np.array(te_list)[order]
    pix     = pixels[order].transpose(2, 1, 0)[:, :, np.newaxis, :]
    return pix, _simple_dicom_affine(ds), tes


def _frame_echo_time(pfg, fallback_idx: int) -> float:
    for seq_name in ("MREchoSequence", "MRTimingAndRelatedParametersSequence"):
        seq = getattr(pfg, seq_name, None)
        if seq:
            for tag in ("EffectiveEchoTime", "EchoTime"):
                if hasattr(seq[0], tag):
                    return float(getattr(seq[0], tag))
    return float((fallback_idx + 1) * 10)


def _frame_position(pfg, fallback_idx: int) -> float:
    ppo = getattr(pfg, "PlanePositionSequence", None)
    if ppo:
        try:
            return float(ppo[0].ImagePositionPatient[2])
        except Exception:
            pass
    return float(fallback_idx)


def _simple_dicom_affine(ds) -> np.ndarray:
    try:
        iop = [float(v) for v in ds.ImageOrientationPatient]
        ipp = [float(v) for v in ds.ImagePositionPatient]
        ps  = [float(v) for v in ds.PixelSpacing]
        st  = float(getattr(ds, "SliceThickness", ps[0]))
        row_cos = np.array(iop[:3]); col_cos = np.array(iop[3:])
        nrm_cos = np.cross(row_cos, col_cos)
        aff = np.eye(4)
        aff[:3, 0] = row_cos * ps[1]; aff[:3, 1] = col_cos * ps[0]
        aff[:3, 2] = nrm_cos * st;    aff[:3, 3] = ipp
        return aff
    except Exception:
        return np.eye(4)


def _enhanced_dicom_affine(ds, pfgs, unique_locs: list) -> np.ndarray:
    try:
        sfgs = getattr(ds, "SharedFunctionalGroupsSequence", [])
        if sfgs:
            poo = getattr(sfgs[0], "PlaneOrientationSequence", None)
            iop = [float(v) for v in poo[0].ImageOrientationPatient] if poo else [1,0,0,0,1,0]
            pms = getattr(sfgs[0], "PixelMeasuresSequence", None)
            ps  = [float(v) for v in pms[0].PixelSpacing] if pms else [1.0, 1.0]
            st  = float(pms[0].SliceThickness) if pms else (
                abs(unique_locs[1]-unique_locs[0]) if len(unique_locs) > 1 else 1.0)
        else:
            iop, ps, st = [1,0,0,0,1,0], [1.0, 1.0], 1.0
        row_cos = np.array(iop[:3]); col_cos = np.array(iop[3:])
        nrm_cos = np.cross(row_cos, col_cos)
        aff = np.eye(4)
        aff[:3, 0] = row_cos * ps[1]; aff[:3, 1] = col_cos * ps[0]
        aff[:3, 2] = nrm_cos * st;    aff[:3, 3] = [0, 0, unique_locs[0] if unique_locs else 0]
        return aff
    except Exception:
        return np.eye(4)


def _is_dicom(path: str) -> bool:
    try:
        with open(path, "rb") as f:
            f.seek(128)
            return f.read(4) == b"DICM"
    except Exception:
        return False


# ── Demo dataset (matches load_demo in t2_voxel_explorer.py exactly) ─────────

def _make_demo_session(s: Session, modality: str = "T2"):
    if modality == "T2":
        X = Y = 96
        Z = 20
        TE = np.arange(10, 121, 10, dtype=float)   # 12 echoes, 10–120 ms
        yy, xx = np.mgrid[0:X, 0:Y]
        stacked = np.zeros((X, Y, Z, len(TE)))
        seg = np.zeros((X, Y, Z))
        rng = np.random.default_rng(0)             # same seed as explorer
        for z in range(Z):
            cx = X / 2 + 6 * np.sin(z / 3)
            cy = Y / 2
            blob = ((xx - cx) ** 2 / 8 ** 2 + (yy - cy) ** 2 / 18 ** 2) < 1
            seg[blob, z] = 1
            t2_true = 35 + 6 * rng.standard_normal(blob.sum())
            sig = 9000.0 * np.exp(-TE[None, :] / t2_true[:, None]) + 250.0
            sig += rng.normal(0, 90, sig.shape)
            for (a, b), row in zip(np.argwhere(blob), sig):
                stacked[a, b, z, :] = row
        stacked += rng.normal(800, 60, stacked.shape).clip(min=0)

        s.modality   = "T2"
        s.acq_params = TE
        s.file_names = [f"demo_E{i}" for i in range(len(TE))]
        s.stacked    = stacked.astype(np.float32)
        s.affine     = np.eye(4)
        s.seg        = seg.astype(np.int32)
        s.seg_affine = np.eye(4)

    else:  # T1 VFA
        X = Y = 96
        Z = 20
        alphas = np.array([3, 6, 10, 15, 20, 25, 30, 35], dtype=float)
        TR = 15.0
        yy, xx = np.mgrid[0:X, 0:Y]
        stacked = np.zeros((X, Y, Z, len(alphas)))
        seg = np.zeros((X, Y, Z))
        rng = np.random.default_rng(0)
        for z in range(Z):
            cx = X / 2 + 6 * np.sin(z / 3)
            cy = Y / 2
            blob = ((xx - cx) ** 2 / 8 ** 2 + (yy - cy) ** 2 / 18 ** 2) < 1
            seg[blob, z] = 1
            t1_true = 900 + 200 * rng.standard_normal(blob.sum())
            t1_true = np.clip(t1_true, 100, 3000)
            E1 = np.exp(-TR / t1_true)
            for ai, fa in enumerate(alphas):
                alpha = np.deg2rad(fa)
                sig_fa = 3000 * np.sin(alpha) * (1 - E1) / (1 - np.cos(alpha) * E1)
                sig_fa += rng.normal(0, 30, sig_fa.shape)
                for (a, b), val in zip(np.argwhere(blob), sig_fa):
                    stacked[a, b, z, ai] = val
        stacked += rng.normal(100, 20, stacked.shape).clip(min=0)

        s.modality   = "T1"
        s.acq_params = alphas
        s.tr_ms      = TR
        s.file_names = [f"fa_{int(a):02d}deg_demo.nii.gz" for a in alphas]
        s.stacked    = stacked.astype(np.float32)
        s.affine     = np.eye(4)
        s.seg        = seg.astype(np.int32)
        s.seg_affine = np.eye(4)

    s.input_type = "demo"


# ─────────────────────────────────────────────── endpoints ────────────────────

@router.post("/session")
async def new_session(modality: str = "T2"):
    s = create_session()
    s.modality = modality if modality in ("T2", "T1") else "T2"
    return {"session_id": s.id}


@router.post("/{sid}/scan")
async def upload_scan(sid: str, files: List[UploadFile] = File(...)):
    s = get_session(sid)
    if not s:
        raise HTTPException(404, "Session not found")

    scan_dir = os.path.join(s.dir, "scan")
    os.makedirs(scan_dir, exist_ok=True)

    saved = []
    for f in files:
        name = os.path.basename(f.filename or f"file_{len(saved)}")
        dest = os.path.join(scan_dir, name)
        with open(dest, "wb") as fh:
            fh.write(await f.read())
        saved.append(dest)

    if not saved:
        raise HTTPException(400, "No files received")

    if len(saved) == 1 and (_is_dicom(saved[0]) or saved[0].lower().endswith(".dcm")):
        try:
            stacked, affine, acq = _load_dicom_4d(saved[0])
        except Exception as e:
            raise HTTPException(400, f"DICOM load failed: {e}")
        s.input_type = "dicom"
        s.file_names = [os.path.basename(saved[0])]
    else:
        nii_paths = [p for p in saved if p.lower().endswith((".nii", ".nii.gz"))]
        if not nii_paths:
            raise HTTPException(400, "No .nii or .nii.gz files found")
        try:
            stacked, affine, acq = _load_nifti_folder(nii_paths)
        except Exception as e:
            raise HTTPException(400, f"NIfTI load failed: {e}")
        s.input_type = "nifti"
        s.file_names = sorted([os.path.basename(p) for p in nii_paths],
                               key=lambda n: _natural_echo_key(n))

    s.stacked    = stacked.astype(np.float32)
    s.affine     = affine
    s.acq_params = acq

    X, Y, Z, nVol = stacked.shape
    label = "TE" if s.modality == "T2" else "flip angle"
    print(f"Loaded {nVol} {'echoes' if label=='TE' else 'flip angles'}, "
          f"volume {stacked.shape[:3]}")
    if label == "TE":
        for fname, te in zip(s.file_names, acq):
            print(f"  TE={te:6.1f} ms   {fname}")

    return {
        "shape":      [X, Y, Z],
        "n_vols":     nVol,
        "acq_params": acq.tolist(),
        "vox_str":    _vox_size_str(affine),
        "input_type": s.input_type,
        "files":      s.file_names,
        "label":      label,
    }


@router.post("/{sid}/segmentation")
async def upload_seg(sid: str, file: UploadFile = File(...)):
    import nibabel as nib
    s = get_session(sid)
    if not s:
        raise HTTPException(404, "Session not found")

    name = os.path.basename(file.filename or "seg.nii")
    dest = os.path.join(s.dir, name)
    with open(dest, "wb") as fh:
        fh.write(await file.read())

    try:
        img = nib.load(dest)
        seg = np.asarray(img.get_fdata()).astype(np.int32)   # matches explorer
        seg_affine = img.affine
    except Exception as e:
        raise HTTPException(400, f"Segmentation load failed: {e}")

    if s.stacked is not None and list(seg.shape[:3]) != list(s.stacked.shape[:3]):
        raise HTTPException(
            400,
            f"Segmentation shape {list(seg.shape[:3])} does not match "
            f"scan shape {list(s.stacked.shape[:3])}. "
            f"The mask must cover exactly the same voxel grid."
        )

    s.seg        = seg
    s.seg_affine = seg_affine
    labels = sorted(int(v) for v in np.unique(seg) if v != 0)
    return {"shape": list(seg.shape), "labels": labels, "filename": name}


@router.get("/{sid}/check")
async def voxel_check(sid: str):
    s = get_session(sid)
    if not s:
        raise HTTPException(404, "Session not found")
    if s.stacked is None:
        return {"ready": False, "message": "No scan loaded yet"}
    if s.seg is None:
        X, Y, Z = s.stacked.shape[:3]
        return {"ready": True,
                "message": (f"Scan loaded — {X}×{Y}×{Z}, "
                            f"{_vox_size_str(s.affine)}. "
                            f"No segmentation — will fit all non-zero voxels.")}

    level, msg = _affine_check(s.affine, s.seg_affine,
                                s.stacked.shape[:3], s.seg.shape)
    return {
        "ready":   level != "error",
        "level":   level,
        "message": msg,
    }


@router.get("/{sid}/volume")
async def get_volume(sid: str, echo: int = 0):
    """Return one echo as raw float32 binary (ZYX order) for the ortho viewer."""
    s = get_session(sid)
    if not s or s.stacked is None:
        raise HTTPException(404, "No scan loaded")

    vol = s.stacked[..., min(echo, s.stacked.shape[3] - 1)]  # (X, Y, Z)
    vol_zyx = np.ascontiguousarray(np.transpose(vol, (2, 1, 0)), dtype=np.float32)
    Z, Y, X = vol_zyx.shape

    vox_xyz = np.sqrt((s.affine[:3, :3] ** 2).sum(axis=0))   # [dx, dy, dz]
    vox_zyx = vox_xyz[[2, 1, 0]]                               # [dz, dy, dx]

    return Response(
        content=vol_zyx.tobytes(),
        media_type="application/octet-stream",
        headers={
            "X-Shape":    f"{Z},{Y},{X}",
            "X-VoxelMm":  f"{vox_zyx[0]:.4f},{vox_zyx[1]:.4f},{vox_zyx[2]:.4f}",
            "X-Spacing":  _vox_size_str(s.affine),
            "Access-Control-Expose-Headers": "X-Shape,X-VoxelMm,X-Spacing",
        },
    )


@router.get("/{sid}/seg-volume")
async def get_seg_volume(sid: str):
    """Return segmentation as raw int32 binary (ZYX order)."""
    s = get_session(sid)
    if not s or s.seg is None:
        raise HTTPException(404, "No segmentation loaded")
    seg_zyx = np.ascontiguousarray(np.transpose(s.seg, (2, 1, 0)).astype(np.int32))
    Z, Y, X = seg_zyx.shape
    return Response(
        content=seg_zyx.tobytes(),
        media_type="application/octet-stream",
        headers={"X-Shape": f"{Z},{Y},{X}",
                 "Access-Control-Expose-Headers": "X-Shape"},
    )


@router.post("/{sid}/demo")
async def load_demo(sid: str, modality: str = "T2"):
    s = get_session(sid)
    if not s:
        raise HTTPException(404, "Session not found")
    _make_demo_session(s, modality)
    X, Y, Z, nVol = s.stacked.shape
    return {
        "shape":      [X, Y, Z],
        "n_vols":     nVol,
        "acq_params": s.acq_params.tolist(),
        "vox_str":    _vox_size_str(s.affine),
        "input_type": "demo",
        "files":      s.file_names,
        "label":      "TE" if s.modality == "T2" else "flip angle",
        "has_seg":    True,
    }
