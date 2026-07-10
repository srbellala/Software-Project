import { create } from "zustand";

export type ToastType = "info" | "ok" | "error";

export interface ToastEntry {
  id: number;
  message: string;
  type: ToastType;
}

let nextId = 1;

interface ToastState {
  toasts: ToastEntry[];
  push: (message: string, type?: ToastType, ms?: number) => void;
  dismiss: (id: number) => void;
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (message, type = "info", ms = 3500) => {
    const id = nextId++;
    set({ toasts: [...get().toasts, { id, message, type }] });
    setTimeout(() => get().dismiss(id), ms);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export function toast(message: string, type: ToastType = "info", ms = 3500) {
  useToastStore.getState().push(message, type, ms);
}
