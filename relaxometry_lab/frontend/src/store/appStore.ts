import { create } from "zustand";

export type Modality = "T2" | "T1";
export type WizardStep = 1 | 2 | 3 | 4;

export interface FileListEntry {
  icon: string;
  label: string;
}

interface AppState {
  sid: string | null;
  modality: Modality;
  /** Locked once a scan is loaded — can't switch T2/T1 mid-session. */
  modalityLocked: boolean;
  scanReady: boolean;
  /** 0-100 while a scan upload is in flight; null when idle. */
  scanUploadProgress: number | null;
  scanFiles: FileListEntry[];
  segFiles: FileListEntry[];
  currentScanLabel: string;
  nVols: number;
  acqParams: number[];
  brukerStudyLoaded: boolean;
  brukerZipTitle: string;
  alignMessage: string;
  alignLevel: "idle" | "ok" | "warn" | "err";
  /** Mirrors the backend /check endpoint's `ready` flag exactly (a "warn" level is still ready=true). */
  checkReady: boolean;
  step: WizardStep;
  /** Highest step the user has reached — gates which wizard-header steps are clickable, like the old app's "active/complete" class check. */
  highestStepReached: WizardStep;
  fittingDone: boolean;

  setSid: (sid: string) => void;
  setModality: (m: Modality) => void;
  setModalityLocked: (locked: boolean) => void;
  setScanReady: (ready: boolean) => void;
  setScanUploadProgress: (pct: number | null) => void;
  setScanFiles: (files: FileListEntry[]) => void;
  setSegFiles: (files: FileListEntry[]) => void;
  setCurrentScanLabel: (label: string) => void;
  setAcquisition: (nVols: number, acqParams: number[]) => void;
  setBrukerStudyLoaded: (loaded: boolean) => void;
  setBrukerZipTitle: (title: string) => void;
  setAlign: (message: string, level: AppState["alignLevel"], ready: boolean) => void;
  setStep: (step: WizardStep) => void;
  setFittingDone: (done: boolean) => void;
  resetScan: () => void;
  resetSeg: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  sid: null,
  modality: "T2",
  modalityLocked: false,
  scanReady: false,
  scanUploadProgress: null,
  scanFiles: [],
  segFiles: [],
  currentScanLabel: "",
  nVols: 0,
  acqParams: [],
  brukerStudyLoaded: false,
  brukerZipTitle: "",
  alignMessage: "Load a Scan and Segmentation Mask to check Alignment.",
  alignLevel: "idle",
  checkReady: false,
  step: 1,
  highestStepReached: 1,
  fittingDone: false,

  setSid: (sid) => set({ sid }),
  setModality: (modality) => set({ modality }),
  setModalityLocked: (modalityLocked) => set({ modalityLocked }),
  setScanReady: (scanReady) => set({ scanReady }),
  setScanUploadProgress: (scanUploadProgress) => set({ scanUploadProgress }),
  setScanFiles: (scanFiles) => set({ scanFiles }),
  setSegFiles: (segFiles) => set({ segFiles }),
  setCurrentScanLabel: (currentScanLabel) => set({ currentScanLabel }),
  setAcquisition: (nVols, acqParams) => set({ nVols, acqParams }),
  setBrukerStudyLoaded: (brukerStudyLoaded) => set({ brukerStudyLoaded }),
  setBrukerZipTitle: (brukerZipTitle) => set({ brukerZipTitle }),
  setAlign: (alignMessage, alignLevel, checkReady) => set({ alignMessage, alignLevel, checkReady }),
  setStep: (step) =>
    set((s) => ({ step, highestStepReached: Math.max(s.highestStepReached, step) as WizardStep })),
  setFittingDone: (fittingDone) => set({ fittingDone }),

  resetScan: () =>
    set({
      scanReady: false,
      modalityLocked: false,
      scanUploadProgress: null,
      scanFiles: [],
      currentScanLabel: "",
      nVols: 0,
      acqParams: [],
      brukerStudyLoaded: false,
      brukerZipTitle: "",
      step: 1,
      highestStepReached: 1,
      fittingDone: false,
    }),
  resetSeg: () => set({ segFiles: [] }),
}));
