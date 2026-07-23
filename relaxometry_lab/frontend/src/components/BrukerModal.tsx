import { useMemo } from "react";
import { useBrukerStore, type BrukerFilter } from "../store/brukerStore";
import { Button } from "../components/Button";
import { selectBrukerScan, selectBrukerScansMulti } from "../actions/loadActions";
import type { BrukerScanInfo } from "../api/client";

const FILTERS: { key: BrukerFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "T2", label: "T2 Multi-Echo" },
  { key: "T1", label: "T1" },
  { key: "anat", label: "Anat / Other" },
];

const FILTER_MAP: Record<BrukerFilter, string[] | null> = {
  all: null,
  T2: ["T2"],
  T1: ["T1"],
  anat: ["anat", "other", "unknown"],
};

const BADGE_CLASS: Record<string, string> = {
  T2: "bg-[#dbeeff] text-[#1a5fa0]",
  T1: "bg-[#fde8d0] text-[#8a4000]",
  anat: "bg-[#e8e6e0] text-[#5a6370]",
  other: "bg-[#e8e6e0] text-[#5a6370]",
  unknown: "bg-[#f0f0f0] text-[#888]",
};

const MODALITY_LABEL: Record<string, string> = {
  T2: "T2 multi-echo",
  T1: "T1",
  anat: "Anat",
  other: "Other",
  unknown: "Unknown",
};

function rowMeta(s: BrukerScanInfo) {
  const teStr = s.tes?.length
    ? s.tes.slice(0, 5).map((t) => t.toFixed(1)).join(", ") + (s.tes.length > 5 ? " …" : "")
    : "—";
  const echoStr = s.n_echo > 0 ? `${s.n_echo} echo${s.n_echo > 1 ? "es" : ""}` : s.flip_angle != null ? `FA ${s.flip_angle}°` : "—";
  const filesStr = [s.has_dicom ? "DICOM" : null, s.has_nifti ? "NIfTI" : null].filter(Boolean).join(" · ") || "—";
  const preferredFit = s.modality === "T2" ? "T2" : s.modality === "T1" ? "T1" : null;
  return { teStr, echoStr, filesStr, preferredFit };
}

export function BrukerModal() {
  const modalOpen = useBrukerStore((s) => s.modalOpen);
  const scans = useBrukerStore((s) => s.scans);
  const filter = useBrukerStore((s) => s.filter);
  const setFilter = useBrukerStore((s) => s.setFilter);
  const selected = useBrukerStore((s) => s.selected);
  const setSelected = useBrukerStore((s) => s.setSelected);
  const selectedMulti = useBrukerStore((s) => s.selectedMulti);
  const toggleMulti = useBrukerStore((s) => s.toggleMulti);
  const closeModal = useBrukerStore((s) => s.closeModal);

  const rows = useMemo(() => {
    const want = FILTER_MAP[filter];
    return scans.filter((s) => !want || want.includes(s.modality));
  }, [scans, filter]);

  if (!modalOpen) return null;

  const multiMode = selectedMulti.length > 0;

  const hint = multiMode
    ? `${selectedMulti.length} scan${selectedMulti.length > 1 ? "s" : ""} checked for flip-angle series`
    : !selected
    ? "Click a row to select a scan, or check T1 rows to combine several as one flip-angle series"
    : (() => {
        const s = scans.find((x) => x.scan === selected.scan);
        const preferredFit = selected.modality === "T2" ? "T2" : selected.modality === "T1" ? "T1" : null;
        return preferredFit
          ? `Selected: scan ${selected.scan} — ${s?.title || s?.method}`
          : `Selected: scan ${selected.scan} — modality unknown, will attempt load`;
      })();

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-[rgba(30,45,61,.45)] p-6"
      onClick={closeModal}
    >
      <div
        className="flex max-h-[80vh] w-[min(860px,100%)] flex-col overflow-hidden rounded-2xl bg-card shadow-[0_8px_40px_rgba(35,74,110,.22)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-5 py-4 pb-3">
          <span className="text-[15px] font-bold text-navy">Bruker Study Browser</span>
          <button className="cursor-pointer border-none bg-none px-1 text-xl leading-none text-muted hover:text-text" onClick={closeModal}>
            ×
          </button>
        </div>

        <div className="flex flex-shrink-0 gap-1.5 border-b border-border px-5 py-2.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
                filter === f.key
                  ? "border-navy bg-navy text-white"
                  : "border-border bg-transparent text-muted hover:border-navy hover:text-navy"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="max-h-[55vh] min-h-[120px] flex-1 overflow-y-auto">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr>
                {["", "#", "Title", "Modality", "Echoes / TEs · Flip Angle", "Files"].map((h, i) => (
                  <th
                    key={i}
                    className="sticky top-0 whitespace-nowrap border-b-2 border-border bg-card px-3.5 py-2.5 text-left text-[11px] font-bold tracking-wide text-muted uppercase"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-6 text-center text-muted">
                    No scans match this filter.
                  </td>
                </tr>
              )}
              {rows.map((s) => {
                const { teStr, echoStr, filesStr, preferredFit } = rowMeta(s);
                const isSelected = selected?.scan === s.scan;
                const isChecked = selectedMulti.includes(s.scan);
                return (
                  <tr
                    key={s.scan}
                    onClick={() => setSelected({ scan: s.scan, modality: s.modality })}
                    className={`cursor-pointer border-b border-border transition-colors hover:bg-accent-light ${
                      isSelected ? "bg-[#dbeeff]" : ""
                    } ${isChecked ? "bg-[#fde8d0]" : ""} ${!preferredFit ? "opacity-55" : ""}`}
                  >
                    <td className="w-8 px-3.5 py-2.5" onClick={(e) => e.stopPropagation()}>
                      {s.modality === "T1" && (
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleMulti(s.scan)}
                          className="cursor-pointer"
                        />
                      )}
                    </td>
                    <td className="w-10 px-3.5 py-2.5 font-bold text-muted">{s.scan}</td>
                    <td className="px-3.5 py-2.5">{s.title || "—"}</td>
                    <td className="px-3.5 py-2.5">
                      <span className={`inline-block rounded-[10px] px-2 py-0.5 text-[11px] font-bold ${BADGE_CLASS[s.modality] ?? BADGE_CLASS.unknown}`}>
                        {MODALITY_LABEL[s.modality] ?? s.modality}
                      </span>
                    </td>
                    <td className="px-3.5 py-2.5">
                      {echoStr}
                      <br />
                      <span className="text-[11px] text-muted">{teStr}</span>
                    </td>
                    <td className="px-3.5 py-2.5">{filesStr}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex flex-shrink-0 items-center justify-between border-t border-border px-5 py-3">
          <span className="text-xs text-muted">{hint}</span>
          {multiMode ? (
            <Button disabled={selectedMulti.length < 2} onClick={selectBrukerScansMulti}>
              Load {selectedMulti.length} Scans as Flip-Angle Series →
            </Button>
          ) : (
            <Button disabled={!selected} onClick={selectBrukerScan}>
              Use Selected Scan →
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
