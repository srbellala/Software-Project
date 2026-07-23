"""
Load routes — scan upload (DICOM or NIfTI), segmentation, voxel-space check,
ortho volume delivery, and synthetic demo generation.

NIfTI loading, default TEs, and demo data generation match t2_voxel_explorer.py exactly.
"""
import os
from pathlib import Path
from typing import List, Optional
import numpy as np

from fastapi import APIRouter, Body, File, HTTPException, UploadFile
from fastapi.responses import Response

from api.sessions import Session, create_session, get_session

router = APIRouter()


# ── GCS-backed uploads (used only when deployed with UPLOAD_BUCKET set) ───────
#
# Cloud Run's front end hard-caps request bodies at 32MB, which multi-echo
# NIfTI stacks routinely exceed. When UPLOAD_BUCKET is set, the frontend
# uploads files directly to that bucket via a signed URL, then hands us the
# object paths to fetch — the file never passes through the container's
# 32MB-limited request path. Locally (no UPLOAD_BUCKET), uploads still go
# straight through the /scan, /segmentation, /bruker-study bodies below.

_gcs_client = None


def _upload_bucket() -> Optional[str]:
    return os.environ.get("UPLOAD_BUCKET")


def _gcs():
    global _gcs_client
    if _gcs_client is None:
        from google.cloud import storage
        _gcs_client = storage.Client()
    return _gcs_client


def _gcs_signed_put_url(bucket_name: str, object_path: str) -> str:
    import datetime
    import google.auth
    from google.auth.transport import requests as gauth_requests

    credentials, _ = google.auth.default()
    credentials.refresh(gauth_requests.Request())

    blob = _gcs().bucket(bucket_name).blob(object_path)
    return blob.generate_signed_url(
        version="v4",
        expiration=datetime.timedelta(minutes=20),
        method="PUT",
        content_type="application/octet-stream",
        service_account_email=credentials.service_account_email,
        access_token=credentials.token,
    )


def _download_from_gcs(bucket_name: str, object_path: str, dest: str):
    _gcs().bucket(bucket_name).blob(object_path).download_to_filename(dest)


def _delete_from_gcs(bucket_name: str, object_path: str):
    try:
        _gcs().bucket(bucket_name).blob(object_path).delete()
    except Exception:
        pass


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
    m = re.search(r'[_\-](?:TE|te|echo)[_\-]?(\d+(?:\.\d+)?)(?:ms|MS)?', stem)
    if m:
        return float(m.group(1))
    return None


def _read_sidecar_json(nii_path: str) -> Optional[dict]:
    """Load the BIDS JSON sidecar (.json with same basename) for a NIfTI file."""
    import json
    p = Path(nii_path)
    stem = p.name
    for suffix in ('.nii.gz', '.nii'):
        if stem.lower().endswith(suffix):
            stem = stem[:-len(suffix)]
            break
    json_path = p.parent / (stem + '.json')
    if not json_path.exists():
        return None
    try:
        with open(json_path) as f:
            return json.load(f)
    except Exception:
        return None


def _te_ms(raw) -> Optional[float]:
    """Convert a raw EchoTime value to ms. BIDS stores seconds; values < 5 are assumed seconds."""
    if raw is None or isinstance(raw, list):
        return None
    v = float(raw)
    return v * 1000.0 if v < 5.0 else v


def _extract_TE_from_sidecar(nii_path: str) -> Optional[float]:
    """
    Read a single EchoTime from the BIDS JSON sidecar alongside a NIfTI file.
    Returns TE in milliseconds, or None if not found.
    """
    meta = _read_sidecar_json(nii_path)
    if not meta:
        return None
    for key in ('EchoTime', 'echo_time', 'TE'):
        v = _te_ms(meta.get(key))
        if v is not None:
            return v
    return None


def _extract_TEs_from_sidecar(nii_path: str, n_echoes: int) -> Optional[np.ndarray]:
    """
    Read an array of EchoTimes from the BIDS JSON sidecar for a 4D multi-echo NIfTI.
    Returns a float64 array of TEs in ms if the array length matches n_echoes, else None.
    """
    meta = _read_sidecar_json(nii_path)
    if not meta:
        return None
    for key in ('EchoTime', 'EchoTimes', 'echo_time', 'echo_times', 'TE', 'TEs'):
        et = meta.get(key)
        if isinstance(et, list) and len(et) == n_echoes:
            arr = np.array(et, dtype=float)
            return arr * 1000.0 if arr.max() < 5.0 else arr
    return None


def _load_nifti_folder(paths: List[str]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Sort NIfTI files by trailing number, stack into (X,Y,Z,nVol).

    TE extraction priority (highest first):
      1. BIDS JSON sidecar  (<stem>.json, EchoTime field)
      2. Filename stem       (*_TE_NNNms_* patterns)
      3. Default TEs         (10, 20, 30 … ms)

    Special cases:
      - Single 4D file, shape (X,Y,Z,N>2): treated as N echoes; sidecar may
        supply an EchoTime array or scalar; defaults are used if absent.
      - 4D with N=2: magnitude+phase pair → take channel 0 (magnitude only).
    """
    import nibabel as nib

    paths = sorted(paths, key=_natural_echo_key)

    # ── Single 4D NIfTI: treat 4th dim as echoes ─────────────────────────
    if len(paths) == 1:
        img = nib.load(paths[0])
        d   = img.get_fdata(dtype=np.float32)
        if d.ndim == 4 and d.shape[3] == 2:
            # Magnitude + phase (Bruker/Paravision): take magnitude only
            d = d[..., 0:1]
        if d.ndim == 4 and d.shape[3] > 1:
            n = d.shape[3]
            # Prefer sidecar array (must match n_echoes exactly), then defaults
            tes = _extract_TEs_from_sidecar(paths[0], n)
            if tes is None:
                tes = _default_TEs(n)
            return d, img.affine, tes
        # 3D single file (n_echoes=1)
        te  = _extract_TE_from_sidecar(paths[0]) or _extract_TE_from_stem(Path(paths[0]).stem)
        acq = np.array([te if te is not None else 10.0], dtype=float)
        vol = d if d.ndim == 3 else d[..., 0]
        return vol[..., np.newaxis], img.affine, acq

    # ── Multiple files: one 3D volume per echo ────────────────────────────
    vols, affine = [], None
    tes_from_file: List[Optional[float]] = []

    for p in paths:
        img = nib.load(p)
        if affine is None:
            affine = img.affine
        d = img.get_fdata(dtype=np.float32)
        if d.ndim == 4:
            if d.shape[3] == 2:
                d = d[..., 0]   # magnitude channel
            else:
                d = d.mean(axis=3)
        elif d.ndim != 3:
            raise ValueError(f"{Path(p).name}: expected 3D or 4D, got {d.ndim}D.")
        vols.append(d)
        # Prefer sidecar, then filename, then None (will trigger defaults below)
        te = _extract_TE_from_sidecar(p) or _extract_TE_from_stem(Path(p).stem)
        tes_from_file.append(te)

    shapes = {v.shape for v in vols}
    if len(shapes) != 1:
        raise ValueError(f"Echo volumes have different shapes: {shapes}")

    stacked = np.stack(vols, axis=-1)   # (X, Y, Z, nVol)

    if all(t is not None for t in tes_from_file):
        acq = np.array(tes_from_file, dtype=float)
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
        normal = _dicom_slice_normal(ds)
        real_tes = [_frame_echo_time_real(pfg) for pfg in pfgs]
        has_real_te = any(t is not None for t in real_tes)
        frames_info = [{"te": real_tes[i] if real_tes[i] is not None
                             else (float((i + 1) * 10) if has_real_te else 0.0),
                        "loc": _frame_position(pfg, normal, i),
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

    # No per-frame metadata: there's no reliable way to tell whether these
    # frames are distinct slices of one 3D volume or distinct echoes/flip
    # angles of one slice. Treat them as slices of a single volume — by far
    # the more common case for plain multiframe DICOM lacking rich per-frame
    # tags — rather than fabricating a fake echo/volume split from the frame
    # index, which used to shred real 3D scans into bogus 1-slice "volumes".
    te = float(getattr(ds, "EchoTime", 10.0))
    pix = pixels.transpose(2, 1, 0)[:, :, :, np.newaxis]
    return pix, _simple_dicom_affine(ds), np.array([te])


def _frame_echo_time_real(pfg) -> float | None:
    for seq_name in ("MREchoSequence", "MRTimingAndRelatedParametersSequence"):
        seq = getattr(pfg, seq_name, None)
        if seq:
            for tag in ("EffectiveEchoTime", "EchoTime"):
                if hasattr(seq[0], tag):
                    return float(getattr(seq[0], tag))
    return None


def _dicom_slice_normal(ds) -> np.ndarray:
    """
    Through-plane unit vector for an enhanced multiframe DICOM, derived from
    the shared PlaneOrientationSequence. Slices only vary monotonically along
    this axis in general — for non-axial acquisitions (coronal, sagittal,
    oblique) that's NOT the Z axis, so frame positions must be projected onto
    it rather than reading ImagePositionPatient[2] directly (which silently
    collapses every coronal/sagittal slice onto one Z value).
    """
    try:
        sfgs = getattr(ds, "SharedFunctionalGroupsSequence", [])
        poo = getattr(sfgs[0], "PlaneOrientationSequence", None) if sfgs else None
        iop = [float(v) for v in poo[0].ImageOrientationPatient] if poo else None
        if iop:
            row_cos = np.array(iop[:3]); col_cos = np.array(iop[3:])
            return np.cross(row_cos, col_cos)
    except Exception:
        pass
    return np.array([0.0, 0.0, 1.0])


def _frame_position(pfg, normal: np.ndarray, fallback_idx: int) -> float:
    ppo = getattr(pfg, "PlanePositionSequence", None)
    if ppo:
        try:
            ipp = np.array([float(v) for v in ppo[0].ImagePositionPatient])
            return float(np.dot(ipp, normal))
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


def _load_dicom_series_generic(paths: List[str], modality: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Stack a folder of single-frame DICOM slices (one file per slice — the
    common export format for real 3D scans, as opposed to a single enhanced
    multiframe file) into (X,Y,Z,nVol).

    Groups frames by slice location; the acquisition-parameter axis is
    EchoTime for T2 or FlipAngle for T1. If every frame shares the same
    value (or the tag is absent everywhere — a plain single-volume 3D scan
    with no echo/flip-angle variation), all frames collapse into one volume
    differentiated purely by slice location rather than a meaningless split.
    """
    import pydicom

    tag = "EchoTime" if modality == "T2" else "FlipAngle"
    frames = []
    for path in paths:
        try:
            ds = pydicom.dcmread(path, stop_before_pixels=True)
        except Exception:
            continue
        acq = float(getattr(ds, tag, 0.0))
        try:
            loc = float(ds.SliceLocation)
        except Exception:
            ipp = getattr(ds, "ImagePositionPatient", None)
            loc = float(ipp[2]) if ipp else 0.0
        frames.append({"path": path, "acq": round(acq, 3), "loc": round(loc, 2)})

    if not frames:
        raise ValueError("No readable DICOM slices")

    unique_locs = sorted(set(f["loc"] for f in frames))
    unique_acqs = sorted(set(f["acq"] for f in frames))

    if len(unique_acqs) < 2:
        # No real per-frame variation — one volume, slices only.
        acq_map = {a: 0 for a in unique_acqs}
        n_acq = 1
    else:
        acq_map = {a: i for i, a in enumerate(unique_acqs)}
        n_acq = len(unique_acqs)

    if modality == "T1" and n_acq > 1 and unique_acqs[0] == 0.0:
        raise ValueError(
            "These DICOM files don't have distinct FlipAngle (0018,1314) tags — "
            "VFA fitting needs each flip angle's slices tagged with its flip angle."
        )

    loc_map = {loc: i for i, loc in enumerate(unique_locs)}

    ds0 = pydicom.dcmread(frames[0]["path"])
    rows, cols = ds0.pixel_array.shape
    vol = np.zeros((cols, rows, len(unique_locs), n_acq), dtype=np.float32)
    for f in frames:
        try:
            ds = pydicom.dcmread(f["path"])
            vol[:, :, loc_map[f["loc"]], acq_map[f["acq"]]] = ds.pixel_array.astype(np.float32).T
        except Exception:
            continue

    if n_acq == 1:
        acq_arr = np.array([unique_acqs[0] if unique_acqs else (10.0 if modality == "T2" else 0.0)])
    else:
        acq_arr = np.array(unique_acqs, dtype=float)

    return vol, _simple_dicom_affine(ds0), acq_arr


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


@router.get("/config")
async def load_config():
    return {"gcs_enabled": bool(_upload_bucket())}


@router.post("/{sid}/upload-url")
async def get_upload_url(sid: str, purpose: str, filename: str):
    s = get_session(sid)
    if not s:
        raise HTTPException(404, "Session not found")
    bucket_name = _upload_bucket()
    if not bucket_name:
        raise HTTPException(400, "GCS uploads are not enabled on this server")
    if purpose not in ("scan", "segmentation", "bruker-study"):
        raise HTTPException(400, "Invalid purpose")

    import uuid as uuid_mod

    object_path = f"uploads/{sid}/{purpose}/{uuid_mod.uuid4().hex}/{os.path.basename(filename)}"
    try:
        url = _gcs_signed_put_url(bucket_name, object_path)
    except Exception as e:
        raise HTTPException(500, f"Could not create upload URL: {e}")
    return {"url": url, "object_path": object_path}


def _process_scan_files(s: Session, saved: List[str]) -> dict:
    if not saved:
        raise HTTPException(400, "No files received")

    dicom_paths = [p for p in saved if _is_dicom(p) or p.lower().endswith(".dcm")]
    nii_paths   = [p for p in saved if p.lower().endswith((".nii", ".nii.gz"))]

    if len(dicom_paths) == 1 and not nii_paths:
        try:
            stacked, affine, acq = _load_dicom_4d(dicom_paths[0])
        except Exception as e:
            raise HTTPException(400, f"DICOM load failed: {e}")
        s.input_type = "dicom"
        s.file_names = [os.path.basename(dicom_paths[0])]
    elif len(dicom_paths) > 1 and not nii_paths:
        try:
            stacked, affine, acq = _load_dicom_series_generic(dicom_paths, s.modality)
        except Exception as e:
            raise HTTPException(400, f"DICOM series load failed: {e}")
        s.input_type = "dicom"
        s.file_names = sorted([os.path.basename(p) for p in dicom_paths])
    else:
        if not nii_paths:
            raise HTTPException(400, "No .nii, .nii.gz, or .dcm files found")
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

    return _process_scan_files(s, saved)


@router.post("/{sid}/scan-from-gcs")
async def scan_from_gcs(sid: str, payload: dict = Body(...)):
    s = get_session(sid)
    if not s:
        raise HTTPException(404, "Session not found")
    bucket_name = _upload_bucket()
    if not bucket_name:
        raise HTTPException(400, "GCS uploads are not enabled on this server")

    object_paths = payload.get("object_paths") or []
    scan_dir = os.path.join(s.dir, "scan")
    os.makedirs(scan_dir, exist_ok=True)

    saved = []
    for object_path in object_paths:
        dest = os.path.join(scan_dir, os.path.basename(object_path))
        try:
            _download_from_gcs(bucket_name, object_path, dest)
        except Exception as e:
            raise HTTPException(400, f"Failed to fetch uploaded file: {e}")
        saved.append(dest)

    result = _process_scan_files(s, saved)
    for object_path in object_paths:
        _delete_from_gcs(bucket_name, object_path)
    return result


def _process_segmentation_file(s: Session, dest: str) -> dict:
    import nibabel as nib

    name = os.path.basename(dest)
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

    s.seg          = seg
    s.seg_affine   = seg_affine
    s.seg_filename = name
    labels = sorted(int(v) for v in np.unique(seg) if v != 0)
    return {"shape": list(seg.shape), "labels": labels, "filename": name}


@router.post("/{sid}/segmentation")
async def upload_seg(sid: str, file: UploadFile = File(...)):
    s = get_session(sid)
    if not s:
        raise HTTPException(404, "Session not found")

    name = os.path.basename(file.filename or "seg.nii")
    dest = os.path.join(s.dir, name)
    with open(dest, "wb") as fh:
        fh.write(await file.read())

    return _process_segmentation_file(s, dest)


@router.post("/{sid}/segmentation-from-gcs")
async def segmentation_from_gcs(sid: str, payload: dict = Body(...)):
    s = get_session(sid)
    if not s:
        raise HTTPException(404, "Session not found")
    bucket_name = _upload_bucket()
    if not bucket_name:
        raise HTTPException(400, "GCS uploads are not enabled on this server")

    object_path = payload.get("object_path")
    if not object_path:
        raise HTTPException(400, "Missing object_path")

    dest = os.path.join(s.dir, os.path.basename(object_path))
    try:
        _download_from_gcs(bucket_name, object_path, dest)
    except Exception as e:
        raise HTTPException(400, f"Failed to fetch uploaded file: {e}")

    result = _process_segmentation_file(s, dest)
    _delete_from_gcs(bucket_name, object_path)
    return result


@router.delete("/{sid}/scan")
async def clear_scan(sid: str):
    """Clear the loaded scan (and any Bruker study state) so a new one can be uploaded."""
    s = get_session(sid)
    if not s:
        raise HTTPException(404, "Session not found")
    s.stacked          = None
    s.affine           = None
    s.acq_params       = None
    s.tr_ms            = None
    s.input_type       = None
    s.file_names       = []
    s.bruker_study_dir = None
    s.reset_fit()
    return {"cleared": True}


@router.delete("/{sid}/segmentation")
async def clear_segmentation(sid: str):
    """Clear the loaded segmentation mask."""
    s = get_session(sid)
    if not s:
        raise HTTPException(404, "Session not found")
    s.seg          = None
    s.seg_affine   = None
    s.seg_filename = None
    s.reset_fit()
    return {"cleared": True}


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


# ─────────────────────────────────────────────── Bruker study browser ────────

def _read_bruker_text(path: str) -> str:
    try:
        with open(path, "r", errors="ignore") as f:
            return f.read()
    except OSError:
        return ""


def _bruker_param(text: str, key: str) -> list:
    """Extract a JCAMP-DX parameter value as a list of string tokens."""
    import re as _re
    m = _re.search(rf"^##\$\s*{_re.escape(key)}\s*=(.*)$", text, _re.MULTILINE)
    if not m:
        return []
    rhs = m.group(1).strip()
    if rhs.startswith("<") and rhs.endswith(">"):
        return [rhs[1:-1]]
    if rhs.startswith("("):
        tail = text[m.end():]
        tokens = []
        for line in tail.splitlines():
            if line.startswith("##") or line.startswith("$$"):
                break
            tokens.extend(line.split())
        return tokens
    return rhs.split()


def _bruker_floats(text: str, key: str) -> list:
    out = []
    for tok in _bruker_param(text, key):
        try:
            out.append(float(tok))
        except ValueError:
            pass
    return out


def _bruker_locate_exports(scan_dir: str) -> tuple:
    """Return (dicom_files, nifti_files) found under pdata/<reco>/dicom|nifti/."""
    dcm, nii = [], []
    pdata = os.path.join(scan_dir, "pdata")
    if not os.path.isdir(pdata):
        return dcm, nii
    for reco in sorted(os.listdir(pdata)):
        rp = os.path.join(pdata, reco)
        if not os.path.isdir(rp):
            continue
        dcm_dir = os.path.join(rp, "dicom")
        nii_dir = os.path.join(rp, "nifti")
        if os.path.isdir(dcm_dir):
            dcm += [os.path.join(dcm_dir, f) for f in sorted(os.listdir(dcm_dir))
                    if f.lower().endswith(".dcm")]
        if os.path.isdir(nii_dir):
            nii += [os.path.join(nii_dir, f) for f in sorted(os.listdir(nii_dir))
                    if f.lower().endswith((".nii", ".nii.gz"))]
    return dcm, nii


def _bruker_scan_info(scan_dir: str) -> dict:
    """Read Bruker method/acqp files + DICOM header to produce a scan metadata dict."""
    text  = _read_bruker_text(os.path.join(scan_dir, "method"))
    acqp  = _read_bruker_text(os.path.join(scan_dir, "acqp"))

    # Sequence/method name — try method file first, fall back to acqp fields
    method_toks = (
        _bruker_param(text, "Method") or
        _bruker_param(acqp, "ACQ_scan_name") or
        _bruker_param(acqp, "ACQ_protocol_name") or
        _bruker_param(text, "PVM_ScanMethod")
    )
    method_name = method_toks[0] if method_toks else "?"
    mu = method_name.upper()

    # Echo times: method file → acqp fallback
    tes = (
        _bruker_floats(text, "EffectiveTE") or
        _bruker_floats(text, "PVM_EchoTime") or
        _bruker_floats(acqp, "ACQ_echo_time")
    )
    unique_tes = sorted(set(round(t, 3) for t in tes))
    n_echo     = len(unique_tes)

    # Echo-count fallback when the TE array is absent
    if n_echo == 0:
        ne_raw = _bruker_floats(acqp, "NECHOES") or _bruker_floats(text, "PVM_NEchoImages")
        if ne_raw:
            n_echo = max(int(ne_raw[0]), 0)

    flip = _bruker_floats(text, "PVM_ExcPulseAngle") or _bruker_floats(text, "ExcPulse1")
    tr   = _bruker_floats(text, "PVM_RepetitionTime")

    # Modality detection (method name takes priority, then echo count)
    _T2 = {"MSME", "MGE", "CPMG", "MEMS", "GRASE", "UTE", "MEMD"}
    _T1 = {"VTR", "RAREVTR", "IR", "FLASH", "VFA", "SSFP"}
    if any(k in mu for k in _T2) or "T2" in mu:
        modality = "T2"
    elif any(k in mu for k in _T1) or "T1" in mu:
        modality = "T1"
    elif "RARE" in mu:
        modality = "anat" if n_echo < 3 else "T2"
    elif n_echo >= 2:
        # Multi-echo with unrecognised method name → likely T2
        modality = "T2"
    else:
        modality = "other"

    dcm, nii = _bruker_locate_exports(scan_dir)

    # Use DICOM SeriesDescription as a better title when available
    title = method_name
    if dcm:
        try:
            import pydicom
            ds = pydicom.dcmread(dcm[0], stop_before_pixels=True)
            desc = (getattr(ds, "SeriesDescription", None) or
                    getattr(ds, "ProtocolName", None))
            if desc:
                title = str(desc).strip()
        except Exception:
            pass

    print(f"[Bruker] scan {os.path.basename(scan_dir)}: method={method_name!r} "
          f"n_echo={n_echo} modality={modality} tes={unique_tes[:4]}")

    return {
        "method":     method_name,
        "modality":   modality,
        "title":      title,
        "n_echo":     n_echo,
        "tes":        unique_tes[:8],
        "flip_angle": flip[0] if flip else None,
        "tr_ms":      tr[0]   if tr   else None,
        "has_dicom":  len(dcm) > 0,
        "has_nifti":  len(nii) > 0,
    }


def _find_bruker_study_root(base_dir: str) -> Optional[str]:
    """BFS up to 5 levels deep to find the directory containing numbered Bruker scan subfolders."""
    def _has_numbered(d: str) -> bool:
        try:
            return any(n.isdigit() and os.path.isdir(os.path.join(d, n))
                       for n in os.listdir(d))
        except OSError:
            return False

    from collections import deque
    queue: deque = deque([(base_dir, 0)])
    while queue:
        current, depth = queue.popleft()
        if _has_numbered(current):
            return current
        if depth >= 5:
            continue
        try:
            for name in sorted(os.listdir(current)):
                if name.startswith("__") or name.startswith("."):
                    continue  # skip __MACOSX and hidden dirs
                full = os.path.join(current, name)
                if os.path.isdir(full):
                    queue.append((full, depth + 1))
        except OSError:
            pass
    return None


def _load_dicom_series_multifile(paths: list) -> tuple:
    """Stack individual single-frame DICOMs (slice per file) into (X,Y,Z,nTE)."""
    import pydicom
    frames = []
    for path in sorted(paths):
        try:
            ds  = pydicom.dcmread(path, stop_before_pixels=True)
            te  = float(getattr(ds, "EchoTime", 0.0))
            try:
                loc = float(ds.SliceLocation)
            except Exception:
                ipp = getattr(ds, "ImagePositionPatient", None)
                loc = float(ipp[2]) if ipp else 0.0
            frames.append({"path": path, "te": te, "loc": round(loc, 2)})
        except Exception:
            continue
    if not frames:
        raise ValueError("No readable DICOM frames")
    unique_tes  = sorted(set(f["te"]  for f in frames))
    unique_locs = sorted(set(f["loc"] for f in frames))
    te_map  = {te:  i for i, te  in enumerate(unique_tes)}
    loc_map = {loc: i for i, loc in enumerate(unique_locs)}
    ds0 = pydicom.dcmread(frames[0]["path"])
    rows, cols = ds0.pixel_array.shape
    vol = np.zeros((cols, rows, len(unique_locs), len(unique_tes)), dtype=np.float32)
    for f in frames:
        try:
            ds = pydicom.dcmread(f["path"])
            vol[:, :, loc_map[f["loc"]], te_map[f["te"]]] = ds.pixel_array.astype(np.float32).T
        except Exception:
            continue
    return vol, _simple_dicom_affine(pydicom.dcmread(frames[0]["path"])), np.array(unique_tes)


def _process_bruker_zip(s: Session, zip_path: str) -> dict:
    """Extract an uploaded zipped Bruker study folder; return a list of all scans with metadata."""
    import zipfile

    study_dir = os.path.join(s.dir, "study")
    try:
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(study_dir)
    except zipfile.BadZipFile:
        raise HTTPException(400, "Not a valid ZIP file")

    study_root = _find_bruker_study_root(study_dir)
    if study_root is None:
        # Report top-level contents to help debug ZIP structure
        try:
            top = sorted(os.listdir(study_dir))[:10]
            detail = f"No numbered scan folders found. ZIP top-level contains: {top}"
        except OSError:
            detail = "No Bruker study structure found — expected numbered scan folders (1/, 2/, …)"
        raise HTTPException(400, detail)

    s.bruker_study_dir = study_root

    scans = []
    for name in sorted(os.listdir(study_root), key=lambda n: (not n.isdigit(), n)):
        if not name.isdigit():
            continue
        scan_path = os.path.join(study_root, name)
        if not os.path.isdir(scan_path):
            continue
        try:
            info = _bruker_scan_info(scan_path)
            scans.append({"scan": int(name), **info})
        except Exception as exc:
            scans.append({
                "scan": int(name), "title": f"Scan {name} (read error)",
                "modality": "unknown", "method": "?",
                "n_echo": 0, "tes": [], "flip_angle": None, "tr_ms": None,
                "has_dicom": False, "has_nifti": False,
                "error": str(exc),
            })

    if not scans:
        raise HTTPException(400, "No scan folders found in study")

    return {"scans": scans, "n_scans": len(scans)}


@router.post("/{sid}/bruker-study")
async def upload_bruker_study(sid: str, file: UploadFile = File(...)):
    """Upload a zipped Bruker study folder; returns a list of all scans with metadata."""
    s = get_session(sid)
    if not s:
        raise HTTPException(404, "Session not found")

    zip_path = os.path.join(s.dir, "study.zip")
    with open(zip_path, "wb") as fh:
        while chunk := await file.read(1024 * 1024):  # stream 1 MB at a time
            fh.write(chunk)

    return _process_bruker_zip(s, zip_path)


@router.post("/{sid}/bruker-study-from-gcs")
async def bruker_study_from_gcs(sid: str, payload: dict = Body(...)):
    s = get_session(sid)
    if not s:
        raise HTTPException(404, "Session not found")
    bucket_name = _upload_bucket()
    if not bucket_name:
        raise HTTPException(400, "GCS uploads are not enabled on this server")

    object_path = payload.get("object_path")
    if not object_path:
        raise HTTPException(400, "Missing object_path")

    zip_path = os.path.join(s.dir, "study.zip")
    try:
        _download_from_gcs(bucket_name, object_path, zip_path)
    except Exception as e:
        raise HTTPException(400, f"Failed to fetch uploaded file: {e}")

    result = _process_bruker_zip(s, zip_path)
    _delete_from_gcs(bucket_name, object_path)
    return result


@router.post("/{sid}/bruker-select")
async def select_bruker_scan(sid: str, scan: int):
    """Load a specific scan from the uploaded Bruker study into the session."""
    s = get_session(sid)
    if not s:
        raise HTTPException(404, "Session not found")
    if not getattr(s, "bruker_study_dir", None):
        raise HTTPException(400, "No Bruker study uploaded — call /bruker-study first")

    scan_dir = os.path.join(s.bruker_study_dir, str(scan))
    if not os.path.isdir(scan_dir):
        raise HTTPException(404, f"Scan {scan} not found in study")

    info = _bruker_scan_info(scan_dir)
    dcm, nii = _bruker_locate_exports(scan_dir)

    stacked = affine = acq_img = None
    errors  = []

    if dcm:
        try:
            stacked, affine, acq_img = (
                _load_dicom_4d(dcm[0]) if len(dcm) == 1
                else _load_dicom_series_multifile(dcm)
            )
        except Exception as exc:
            errors.append(f"DICOM: {exc}")

    if stacked is None and nii:
        try:
            stacked, affine, acq_img = _load_nifti_folder(nii)
        except Exception as exc:
            errors.append(f"NIfTI: {exc}")

    if stacked is None:
        raise HTTPException(400, f"Could not load scan {scan}: " + "; ".join(errors))

    # Echo times: Bruker method file is authoritative; fall back to image metadata
    modality = "T2" if info["modality"] == "T2" else "T1"
    acq = acq_img

    if modality == "T2" and info["tes"]:
        bruker_tes = np.array(info["tes"], dtype=float)
        n_vols = stacked.shape[3]
        if len(bruker_tes) == n_vols:
            acq = bruker_tes
        elif len(bruker_tes) > n_vols:
            acq = bruker_tes[:n_vols]

    if acq is None:
        acq = _default_TEs(stacked.shape[3])

    s.stacked    = stacked.astype(np.float32)
    s.affine     = affine
    s.acq_params = acq
    s.modality   = modality
    s.tr_ms      = info["tr_ms"]
    s.input_type = "bruker"
    s.file_names = [info["title"] or f"scan_{scan}_{info['method']}"]

    X, Y, Z, nVol = stacked.shape
    label = "TE" if modality == "T2" else "flip angle"
    print(f"[Bruker] Loaded scan {scan} '{info['title']}' — "
          f"{modality}, {nVol} {'echoes' if modality == 'T2' else 'volumes'}, "
          f"{X}x{Y}x{Z}")

    return {
        "shape":      [X, Y, Z],
        "n_vols":     nVol,
        "acq_params": acq.tolist(),
        "vox_str":    _vox_size_str(affine),
        "input_type": "bruker",
        "files":      s.file_names,
        "label":      label,
        "modality":   modality,
    }


@router.get("/{sid}/bruker-scans")
async def list_bruker_scans(sid: str):
    """Return the cached scan list from an already-uploaded Bruker study (no re-upload needed)."""
    s = get_session(sid)
    if not s:
        raise HTTPException(404, "Session not found")
    if not getattr(s, "bruker_study_dir", None):
        raise HTTPException(400, "No Bruker study uploaded yet")

    study_root = s.bruker_study_dir
    scans = []
    for name in sorted(os.listdir(study_root), key=lambda n: (not n.isdigit(), n)):
        if not name.isdigit():
            continue
        scan_path = os.path.join(study_root, name)
        if not os.path.isdir(scan_path):
            continue
        try:
            info = _bruker_scan_info(scan_path)
            scans.append({"scan": int(name), **info})
        except Exception as exc:
            scans.append({
                "scan": int(name), "title": f"Scan {name} (read error)",
                "modality": "unknown", "method": "?",
                "n_echo": 0, "tes": [], "flip_angle": None, "tr_ms": None,
                "has_dicom": False, "has_nifti": False, "error": str(exc),
            })
    return {"scans": scans, "n_scans": len(scans)}


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
