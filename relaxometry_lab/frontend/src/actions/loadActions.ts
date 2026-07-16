import { api, type Modality, type ScanUploadResult } from "../api/client";
import { useAppStore, type FileListEntry } from "../store/appStore";
import { useBrukerStore } from "../store/brukerStore";
import { toast } from "../store/toastStore";

async function ensureSession(): Promise<string> {
  const { sid, modality } = useAppStore.getState();
  if (sid) return sid;
  const d = await api.createSession(modality);
  useAppStore.getState().setSid(d.session_id);
  return d.session_id;
}

function applyScanResult(d: ScanUploadResult, files: FileListEntry[]) {
  const store = useAppStore.getState();
  store.setScanReady(true);
  store.setModalityLocked(true);
  store.setScanFiles(files);
  store.setCurrentScanLabel(files[0]?.label ?? "");
  store.setAcquisition(d.n_vols, d.acq_params);
  if (d.modality) store.setModality(d.modality);
}

export async function doCheck() {
  const sid = useAppStore.getState().sid;
  if (!sid) return;
  const d = await api.check(sid);
  const level: "ok" | "warn" | "err" =
    d.level === "ok" ? "ok" : d.level === "warn" ? "warn" : d.ready ? "ok" : "err";
  useAppStore.getState().setAlign(d.message, level, d.ready);
}

export async function uploadScan(files: File[]) {
  if (files.length === 1 && files[0].name.toLowerCase().endsWith(".zip")) {
    return uploadBrukerZip(files[0]);
  }
  try {
    const sid = await ensureSession();
    toast("Uploading scan…");
    useAppStore.getState().setScanUploadProgress(0);
    const d = await api.uploadScan(sid, files, (loaded, total) => {
      useAppStore.getState().setScanUploadProgress(total > 0 ? Math.round((loaded / total) * 100) : 0);
    });
    applyScanResult(
      d,
      d.files.map((f) => ({ icon: "📄", label: f }))
    );
    toast(`Loaded ${d.n_vols} volumes · ${d.vox_str}`, "ok");
    await doCheck();
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    useAppStore.getState().setScanUploadProgress(null);
  }
}

export async function uploadSegmentation(file: File) {
  const sid = useAppStore.getState().sid;
  if (!sid) {
    toast("Upload scan first", "error");
    return;
  }
  try {
    toast("Uploading segmentation…");
    const d = await api.uploadSegmentation(sid, file);
    useAppStore.getState().setSegFiles([{ icon: "🎭", label: `${d.filename} (labels: ${d.labels.join(", ")})` }]);
    toast("Segmentation loaded", "ok");
    await doCheck();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

export async function clearScan() {
  const sid = useAppStore.getState().sid;
  if (sid) {
    try {
      await api.clearScan(sid);
    } catch {
      /* clear local UI regardless */
    }
  }
  useAppStore.getState().resetScan();
  await doCheck();
  toast("Scan cleared", "ok");
}

export async function clearSegmentation() {
  const sid = useAppStore.getState().sid;
  if (sid) {
    try {
      await api.clearSegmentation(sid);
    } catch {
      /* clear local UI regardless */
    }
  }
  useAppStore.getState().resetSeg();
  await doCheck();
  toast("Segmentation cleared", "ok");
}

export async function loadDemo() {
  try {
    const sid = await ensureSession();
    const modality = useAppStore.getState().modality;
    toast("Loading demo data…");
    const d = await api.loadDemo(sid, modality);
    applyScanResult(
      d,
      d.files.map((f) => ({ icon: "📄", label: f }))
    );
    useAppStore.getState().setSegFiles([{ icon: "🎭", label: "demo_seg.nii.gz (label: 1)" }]);
    useAppStore
      .getState()
      .setAlign(`Demo data loaded — ${d.shape[0]}×${d.shape[1]}×${d.shape[2]}, ${d.vox_str}.`, "ok", true);
    toast("Demo data ready", "ok");
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

export async function uploadBrukerZip(file: File) {
  try {
    toast("Uploading Bruker study…");
    const sid = await ensureSession();
    useAppStore.getState().setScanUploadProgress(0);
    const d = await api.uploadBrukerStudy(sid, file, (loaded, total) => {
      useAppStore.getState().setScanUploadProgress(total > 0 ? Math.round((loaded / total) * 100) : 0);
    });
    useBrukerStore.getState().setScans(d.scans);
    useBrukerStore.getState().setFilter("all");
    useAppStore.getState().setBrukerStudyLoaded(true);
    useAppStore.getState().setBrukerZipTitle(file.name.replace(/\.zip$/i, ""));
    useBrukerStore.getState().openModal();
    toast(`Found ${d.n_scans} scan${d.n_scans !== 1 ? "s" : ""}`, "ok");
  } catch (e) {
    toast((e as Error).message, "error");
  } finally {
    useAppStore.getState().setScanUploadProgress(null);
  }
}

export async function reopenBrukerBrowser() {
  const sid = useAppStore.getState().sid;
  if (!sid) return;
  try {
    const d = await api.listBrukerScans(sid);
    useBrukerStore.getState().setScans(d.scans);
    useBrukerStore.getState().openModal();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

export async function selectBrukerScan() {
  const sid = useAppStore.getState().sid;
  const selected = useBrukerStore.getState().selected;
  if (!sid || !selected) return;
  try {
    toast(`Loading scan ${selected.scan}…`);
    const d = await api.selectBrukerScan(sid, selected.scan);
    useBrukerStore.getState().closeModal();
    applyScanResult(
      d,
      d.files.map((f) => ({ icon: "📄", label: f }))
    );
    toast(
      `Loaded scan ${selected.scan} · ${d.n_vols} ${d.label === "TE" ? "echoes" : "volumes"} · ${d.vox_str}`,
      "ok"
    );
    await doCheck();
  } catch (e) {
    toast((e as Error).message, "error");
  }
}

export type { Modality };
