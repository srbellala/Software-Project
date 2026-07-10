/**
 * /api/fit/* result endpoints for the Output step (map, scatter, per-voxel
 * fit, saved-scan comparison), matching api/fit_routes.py.
 */

export interface FitResult {
  label: string;
  unit: string;
  shape: [number, number]; // [Y, X]
  z: number;
  n_slices: number;
  map_b64: string;
  rmse_b64: string;
  vmin: number;
  vmax: number;
  stats: {
    median?: number;
    mean?: number;
    std?: number;
    p25?: number;
    p75?: number;
    n_vox?: number;
  };
  hist_counts: number[];
  hist_edges: number[];
  acq_params: number[];
  decay_curve: number[];
  decay_p25: number[];
  decay_p75: number[];
  sigma_global: number | null;
  anat_b64: string | null;
  orient: { right: string; left: string; top: string; bottom: string };
  voxel_mm: [number, number];
}

export interface ScatterVoxel {
  idx: number;
  x: number;
  y: number;
  z: number;
  t2: number;
  r2_fit: number;
}

export interface ScatterResult {
  voxels: ScatterVoxel[];
  median: number | null;
  n: number;
}

export interface VoxelResult {
  x: number;
  y: number;
  z: number;
  signal: number[];
  fitted: number[];
  residuals: number[];
  acq_params: number[];
  t2: number;
  r2_fit: number;
  rmse: number;
  modality: string;
}

export interface SavedScan {
  id: string;
  label: string;
  group: string | null;
  modality: string;
  acq_params: number[];
  stats: FitResult["stats"];
  snr_median: number | null;
  chi2_median: number | null;
  decay_curve: number[];
  decay_p25: number[];
  decay_p75: number[];
  hist_counts: number[];
  hist_edges: number[];
  color: string;
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

export const outputApi = {
  fetchResult(sid: string, sliceIdx?: number, useAll?: boolean): Promise<FitResult> {
    const params = new URLSearchParams();
    if (sliceIdx !== undefined) params.set("slice_idx", String(sliceIdx));
    if (useAll) params.set("use_all", "true");
    const qs = params.toString();
    return fetch(`/api/fit/${sid}/result${qs ? `?${qs}` : ""}`).then((r) => asJson<FitResult>(r));
  },

  fetchScatter(sid: string): Promise<ScatterResult> {
    return fetch(`/api/fit/${sid}/scatter`).then((r) => asJson<ScatterResult>(r));
  },

  fetchVoxel(sid: string, x: number, y: number, z: number): Promise<VoxelResult> {
    return fetch(`/api/fit/${sid}/voxel?x=${x}&y=${y}&z=${z}`).then((r) => asJson<VoxelResult>(r));
  },

  fetchSavedScans(sid: string): Promise<{ scans: SavedScan[]; n: number }> {
    return fetch(`/api/fit/${sid}/saved-scans`).then((r) => asJson(r));
  },

  saveScan(sid: string, label: string): Promise<{ saved: boolean; id: string; label: string; n_saved: number }> {
    const qs = label ? `?label=${encodeURIComponent(label)}` : "";
    return fetch(`/api/fit/${sid}/save-scan${qs}`, { method: "POST" }).then((r) => asJson(r));
  },

  deleteSavedScan(sid: string, id: string): Promise<void> {
    return fetch(`/api/fit/${sid}/saved-scans/${id}`, { method: "DELETE" }).then((r) => {
      if (!r.ok) throw new Error("Delete failed");
    });
  },
};

export function downloadUrl(sid: string, type: "map" | "stats" | "voxels" | "report"): string {
  const paths = {
    map: `/api/output/${sid}/map.nii.gz`,
    stats: `/api/output/${sid}/stats.csv`,
    voxels: `/api/output/${sid}/voxels.npz`,
    report: `/api/output/${sid}/report.pdf`,
  };
  return paths[type];
}
