/**
 * Typed wrappers around the /api/load/* endpoints (api/load_routes.py).
 * Same-origin relative paths — the Vite dev server proxies /api to FastAPI
 * on 127.0.0.1:8001; in production this bundle is served by that same
 * FastAPI app, so no base URL is needed either way.
 */

export type Modality = "T2" | "T1";

export interface ScanUploadResult {
  shape: [number, number, number];
  n_vols: number;
  acq_params: number[];
  vox_str: string;
  input_type: string;
  files: string[];
  label: string;
  modality?: Modality;
  has_seg?: boolean;
}

export interface SegUploadResult {
  shape: number[];
  labels: number[];
  filename: string;
}

export interface CheckResult {
  ready: boolean;
  level?: "ok" | "warn" | "error";
  message: string;
}

export interface BrukerScanInfo {
  scan: number;
  method: string;
  modality: string;
  title: string;
  n_echo: number;
  tes: number[];
  flip_angle: number | null;
  tr_ms: number | null;
  has_dicom: boolean;
  has_nifti: boolean;
  error?: string;
}

export interface BrukerStudyResult {
  scans: BrukerScanInfo[];
  n_scans: number;
}

async function asJson<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let detail = "Request failed";
    try {
      const d = await r.json();
      detail = d.detail || detail;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  return r.json() as Promise<T>;
}

export const api = {
  createSession(modality: Modality): Promise<{ session_id: string }> {
    return fetch(`/api/load/session?modality=${modality}`, { method: "POST" }).then((r) =>
      asJson<{ session_id: string }>(r)
    );
  },

  uploadScan(sid: string, files: File[]): Promise<ScanUploadResult> {
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f));
    return fetch(`/api/load/${sid}/scan`, { method: "POST", body: fd }).then((r) =>
      asJson<ScanUploadResult>(r)
    );
  },

  uploadSegmentation(sid: string, file: File): Promise<SegUploadResult> {
    const fd = new FormData();
    fd.append("file", file);
    return fetch(`/api/load/${sid}/segmentation`, { method: "POST", body: fd }).then((r) =>
      asJson<SegUploadResult>(r)
    );
  },

  clearScan(sid: string): Promise<{ cleared: boolean }> {
    return fetch(`/api/load/${sid}/scan`, { method: "DELETE" }).then((r) => asJson<{ cleared: boolean }>(r));
  },

  clearSegmentation(sid: string): Promise<{ cleared: boolean }> {
    return fetch(`/api/load/${sid}/segmentation`, { method: "DELETE" }).then((r) =>
      asJson<{ cleared: boolean }>(r)
    );
  },

  check(sid: string): Promise<CheckResult> {
    return fetch(`/api/load/${sid}/check`).then((r) => asJson<CheckResult>(r));
  },

  loadDemo(sid: string, modality: Modality): Promise<ScanUploadResult> {
    return fetch(`/api/load/${sid}/demo?modality=${modality}`, { method: "POST" }).then((r) =>
      asJson<ScanUploadResult>(r)
    );
  },

  uploadBrukerStudy(sid: string, file: File): Promise<BrukerStudyResult> {
    const fd = new FormData();
    fd.append("file", file);
    return fetch(`/api/load/${sid}/bruker-study`, { method: "POST", body: fd }).then((r) =>
      asJson<BrukerStudyResult>(r)
    );
  },

  listBrukerScans(sid: string): Promise<BrukerStudyResult> {
    return fetch(`/api/load/${sid}/bruker-scans`).then((r) => asJson<BrukerStudyResult>(r));
  },

  selectBrukerScan(sid: string, scan: number): Promise<ScanUploadResult> {
    return fetch(`/api/load/${sid}/bruker-select?scan=${scan}`, { method: "POST" }).then((r) =>
      asJson<ScanUploadResult>(r)
    );
  },
};
