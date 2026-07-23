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

export type UploadProgress = (loaded: number, total: number) => void;

/**
 * fetch() has no upload-progress event, so uploads that want a progress bar
 * go through XMLHttpRequest instead. Behaves like fetch + res.json() on
 * success; throws on non-2xx or network failure.
 */
function xhrUpload<T>(
  method: string,
  url: string,
  body: FormData | File,
  onProgress?: UploadProgress
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded, e.total);
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(xhr.responseText ? (JSON.parse(xhr.responseText) as T) : ({} as T));
        } catch {
          resolve({} as T);
        }
      } else {
        let detail = "Request failed";
        try {
          detail = JSON.parse(xhr.responseText).detail || detail;
        } catch {
          /* non-JSON error body */
        }
        reject(new Error(detail));
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(body);
  });
}

/**
 * Cloud Run's front end caps request bodies at 32MB, which multi-echo NIfTI
 * stacks routinely exceed. When the backend has UPLOAD_BUCKET configured, we
 * upload files directly to that bucket via a signed URL instead of sending
 * them through the app's own request body. Locally (no bucket configured)
 * files just go straight through as before.
 */
let gcsEnabledPromise: Promise<boolean> | null = null;

function gcsEnabled(): Promise<boolean> {
  if (!gcsEnabledPromise) {
    gcsEnabledPromise = fetch("/api/load/config")
      .then((r) => asJson<{ gcs_enabled: boolean }>(r))
      .then((d) => d.gcs_enabled)
      .catch(() => false);
  }
  return gcsEnabledPromise;
}

function xhrPut(url: string, file: File, onProgress?: (loaded: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    if (onProgress) xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload to storage failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(file);
  });
}

async function uploadFileViaGCS(
  sid: string,
  purpose: string,
  file: File,
  onProgress?: (loaded: number) => void
): Promise<string> {
  const { url, object_path } = await fetch(
    `/api/load/${sid}/upload-url?purpose=${purpose}&filename=${encodeURIComponent(file.name)}`,
    { method: "POST" }
  ).then((r) => asJson<{ url: string; object_path: string }>(r));

  await xhrPut(url, file, onProgress);
  return object_path;
}

/** Aggregates per-file byte progress from parallel GCS uploads into one 0-1 fraction. */
function makeMultiFileProgress(files: File[], onProgress: UploadProgress) {
  const totals = files.map((f) => f.size);
  const totalBytes = totals.reduce((a, b) => a + b, 0);
  const loaded = new Array(files.length).fill(0);
  return (index: number) => (bytes: number) => {
    loaded[index] = bytes;
    onProgress(loaded.reduce((a, b) => a + b, 0), totalBytes);
  };
}

export const api = {
  createSession(modality: Modality): Promise<{ session_id: string }> {
    return fetch(`/api/load/session?modality=${modality}`, { method: "POST" }).then((r) =>
      asJson<{ session_id: string }>(r)
    );
  },

  async uploadScan(sid: string, files: File[], onProgress?: UploadProgress): Promise<ScanUploadResult> {
    if (await gcsEnabled()) {
      const perFile = onProgress ? makeMultiFileProgress(files, onProgress) : () => undefined;
      const objectPaths = await Promise.all(files.map((f, i) => uploadFileViaGCS(sid, "scan", f, perFile(i))));
      return fetch(`/api/load/${sid}/scan-from-gcs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ object_paths: objectPaths }),
      }).then((r) => asJson<ScanUploadResult>(r));
    }
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f));
    return xhrUpload<ScanUploadResult>("POST", `/api/load/${sid}/scan`, fd, onProgress);
  },

  async uploadSegmentation(sid: string, file: File, onProgress?: UploadProgress): Promise<SegUploadResult> {
    if (await gcsEnabled()) {
      const objectPath = await uploadFileViaGCS(sid, "segmentation", file, (loaded) => onProgress?.(loaded, file.size));
      return fetch(`/api/load/${sid}/segmentation-from-gcs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ object_path: objectPath }),
      }).then((r) => asJson<SegUploadResult>(r));
    }
    const fd = new FormData();
    fd.append("file", file);
    return xhrUpload<SegUploadResult>("POST", `/api/load/${sid}/segmentation`, fd, onProgress);
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

  async uploadBrukerStudy(sid: string, file: File, onProgress?: UploadProgress): Promise<BrukerStudyResult> {
    if (await gcsEnabled()) {
      const objectPath = await uploadFileViaGCS(sid, "bruker-study", file, (loaded) => onProgress?.(loaded, file.size));
      return fetch(`/api/load/${sid}/bruker-study-from-gcs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ object_path: objectPath }),
      }).then((r) => asJson<BrukerStudyResult>(r));
    }
    const fd = new FormData();
    fd.append("file", file);
    return xhrUpload<BrukerStudyResult>("POST", `/api/load/${sid}/bruker-study`, fd, onProgress);
  },

  listBrukerScans(sid: string): Promise<BrukerStudyResult> {
    return fetch(`/api/load/${sid}/bruker-scans`).then((r) => asJson<BrukerStudyResult>(r));
  },

  selectBrukerScan(sid: string, scan: number): Promise<ScanUploadResult> {
    return fetch(`/api/load/${sid}/bruker-select?scan=${scan}`, { method: "POST" }).then((r) =>
      asJson<ScanUploadResult>(r)
    );
  },

  selectBrukerScansMulti(sid: string, scans: number[]): Promise<ScanUploadResult> {
    return fetch(`/api/load/${sid}/bruker-select-multi`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scans }),
    }).then((r) => asJson<ScanUploadResult>(r));
  },
};
