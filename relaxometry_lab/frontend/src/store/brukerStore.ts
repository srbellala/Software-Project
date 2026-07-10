import { create } from "zustand";
import type { BrukerScanInfo } from "../api/client";

export type BrukerFilter = "all" | "T2" | "T1" | "anat";

interface BrukerSelection {
  scan: number;
  modality: string;
}

interface BrukerState {
  scans: BrukerScanInfo[];
  filter: BrukerFilter;
  selected: BrukerSelection | null;
  modalOpen: boolean;
  setScans: (scans: BrukerScanInfo[]) => void;
  setFilter: (f: BrukerFilter) => void;
  setSelected: (s: BrukerSelection | null) => void;
  openModal: () => void;
  closeModal: () => void;
}

export const useBrukerStore = create<BrukerState>((set) => ({
  scans: [],
  filter: "all",
  selected: null,
  modalOpen: false,
  setScans: (scans) => set({ scans }),
  setFilter: (filter) => set({ filter, selected: null }),
  setSelected: (selected) => set({ selected }),
  openModal: () => set({ modalOpen: true }),
  closeModal: () => set({ modalOpen: false }),
}));
