import asyncio, os, tempfile, uuid
from typing import Optional
import numpy as np


class Session:
    def __init__(self):
        self.id = str(uuid.uuid4())
        self.dir = tempfile.mkdtemp(prefix="rl_")

        # Loaded data
        self.modality: str = "T2"              # "T2" or "T1"
        self.stacked: Optional[np.ndarray] = None   # (X, Y, Z, nVol) nibabel axes
        self.affine: Optional[np.ndarray] = None
        self.acq_params: Optional[np.ndarray] = None  # TE ms (T2) or flip angles deg (T1)
        self.tr_ms: Optional[float] = None            # for T1 VFA
        self.seg: Optional[np.ndarray] = None         # (X, Y, Z)
        self.seg_affine: Optional[np.ndarray] = None
        self.input_type: Optional[str] = None         # "dicom" or "nifti"
        self.file_names: list = []

        # Fit results
        self.param_map: Optional[np.ndarray] = None   # all valid T2/T1 (X,Y,Z)
        self.good_map: Optional[np.ndarray] = None    # quality-filtered (fit-R² ≥ 0.5)
        self.r2_map: Optional[np.ndarray] = None      # fit quality R² (not relaxation rate)
        self.chi2_map: Optional[np.ndarray] = None
        self.noise_map: Optional[np.ndarray] = None
        self.rmse_map: Optional[np.ndarray] = None
        self.sigma_global: Optional[float] = None
        self.fitting_done: bool = False
        self.fit_config: Optional[dict] = None

        # SSE progress
        self._progress_q: Optional[asyncio.Queue] = None


_sessions: dict[str, Session] = {}


def create_session() -> Session:
    s = Session()
    _sessions[s.id] = s
    return s


def get_session(sid: str) -> Optional[Session]:
    return _sessions.get(sid)


def delete_session(sid: str):
    s = _sessions.pop(sid, None)
    if s:
        import shutil
        shutil.rmtree(s.dir, ignore_errors=True)
