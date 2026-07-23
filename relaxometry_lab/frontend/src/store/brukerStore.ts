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
  selectedMulti: number[];
  modalOpen: boolean;
  setScans: (scans: BrukerScanInfo[]) => void;
  setFilter: (f: BrukerFilter) => void;
  setSelected: (s: BrukerSelection | null) => void;
  toggleMulti: (scan: number) => void;
  clearMulti: () => void;
  openModal: () => void;
  closeModal: () => void;
}

export const useBrukerStore = create<BrukerState>((set) => ({
  scans: [],
  filter: "all",
  selected: null,
  selectedMulti: [],
  modalOpen: false,
  setScans: (scans) => set({ scans }),
  setFilter: (filter) => set({ filter, selected: null, selectedMulti: [] }),
  setSelected: (selected) => set({ selected, selectedMulti: [] }),
  toggleMulti: (scan) =>
    set((st) => ({
      selected: null,
      selectedMulti: st.selectedMulti.includes(scan)
        ? st.selectedMulti.filter((n) => n !== scan)
        : [...st.selectedMulti, scan],
    })),
  clearMulti: () => set({ selectedMulti: [] }),
  openModal: () => set({ modalOpen: true }),
  closeModal: () => set({ modalOpen: false, selectedMulti: [] }),
}));
