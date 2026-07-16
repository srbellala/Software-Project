import { useAppStore } from "../store/appStore";

/**
 * Single modality toggle rendered once and reused everywhere (navbar here,
 * and again inside the Load step's own selector) — both read/write the same
 * Zustand slice, so there is no way for them to drift out of sync the way
 * the old two-DOM-node vanilla-JS toggle did.
 */
export function ModalityToggle({ variant }: { variant: "navbar" | "card" }) {
  const modality = useAppStore((s) => s.modality);
  const locked = useAppStore((s) => s.modalityLocked);
  const setModality = useAppStore((s) => s.setModality);

  function select(m: "T2" | "T1") {
    if (locked) return;
    setModality(m);
  }

  if (variant === "navbar") {
    return (
      <>
        <button
          id="tool-t2"
          disabled={locked}
          onClick={() => select("T2")}
          className={`rounded-full border px-3.5 py-1 text-[13px] transition-colors ${
            modality === "T2"
              ? "border-white/60 bg-white/18 font-semibold text-white"
              : "border-white/35 bg-transparent text-white/80"
          } ${locked ? (modality === "T2" ? "opacity-55" : "cursor-default text-white/40 opacity-55") : "cursor-pointer"}`}
        >
          T2
        </button>
        <button
          id="tool-t1"
          disabled={locked}
          onClick={() => select("T1")}
          className={`rounded-full border px-3.5 py-1 text-[13px] transition-colors ${
            modality === "T1"
              ? "border-white/60 bg-white/18 font-semibold text-white"
              : "border-white/35 bg-transparent text-white/80"
          } ${locked ? (modality === "T1" ? "opacity-55" : "cursor-default text-white/40 opacity-55") : "cursor-pointer"}`}
        >
          T1
        </button>
        <button
          disabled
          title="Coming soon"
          className="cursor-not-allowed rounded-full border border-white/35 bg-transparent px-3.5 py-1 text-[13px] text-white/80 opacity-38"
        >
          T2*
        </button>
      </>
    );
  }

  return (
    <div className="mb-3.5 flex gap-1.5">
      <button
        disabled={locked}
        onClick={() => select("T2")}
        className={`rounded-full border px-4 py-1.5 text-xs font-semibold transition-colors ${
          modality === "T2" ? "border-navy bg-navy text-white" : "border-border bg-transparent text-muted"
        } ${locked ? "cursor-default opacity-55" : "cursor-pointer"}`}
      >
        T2 (Multi-Echo)
      </button>
      <button
        disabled={locked}
        onClick={() => select("T1")}
        className={`rounded-full border px-4 py-1.5 text-xs font-semibold transition-colors ${
          modality === "T1" ? "border-navy bg-navy text-white" : "border-border bg-transparent text-muted"
        } ${locked ? "cursor-default opacity-55" : "cursor-pointer"}`}
      >
        T1 (VFA)
      </button>
    </div>
  );
}

export function Navbar() {
  return (
    <nav className="sticky top-0 z-20 flex h-13 w-full flex-shrink-0 items-center gap-3 bg-navy px-6 text-white shadow-[0_2px_6px_rgba(0,0,0,.25)]">
      <a href="/" className="mr-3 text-base font-bold tracking-wide text-white no-underline">
        Relaxometry Lab
      </a>
      <div className="mx-2 h-6 w-px bg-white/25" />
      <span className="mr-1 text-[11px] text-white/50">tool</span>
      <ModalityToggle variant="navbar" />
    </nav>
  );
}
