import { useEffect, useRef, useState } from "react";
import { MapEngine } from "../output/MapEngine";
import { outputApi, type FitResult, type SavedScan, type ScatterResult, type VoxelResult } from "../api/output";
import { MapPanel } from "./output/MapPanel";
import { DecayHistPanel } from "./output/DecayHistPanel";
import { StatsSidebar } from "./output/StatsSidebar";
import { VoxelSignalPanel } from "./output/VoxelSignalPanel";
import { VoxelSidebar } from "./output/VoxelSidebar";
import { ComparisonPanel } from "./output/ComparisonPanel";
import { useAppStore } from "../store/appStore";
import { toast } from "../store/toastStore";

type Mode = "roi" | "voxel" | "compare";

export function OutputStep() {
  const sid = useAppStore((s) => s.sid);
  const currentScanLabel = useAppStore((s) => s.currentScanLabel);
  const modality = useAppStore((s) => s.modality);
  const setStep = useAppStore((s) => s.setStep);

  const engineRef = useRef(new MapEngine());
  const sliceRequestIdRef = useRef(0);
  const [mode, setMode] = useState<Mode>("roi");
  const [result, setResult] = useState<FitResult | null>(null);
  // T1 defaults to showing every voxel the fit could reach a value for (not
  // just the R²-quality-filtered subset) — the bounded nonlinear fit always
  // converges to *some* value per masked voxel, so this is what gives full,
  // gap-free coverage matching a typical published T1 map. T2 keeps its
  // original R²-filtered default (unchanged from before that T1 change).
  const [useAll, setUseAll] = useState(modality === "T1");
  const [scatter, setScatter] = useState<ScatterResult | null>(null);
  const [selected, setSelected] = useState<{ x: number; y: number; z: number } | null>(null);
  const [voxelData, setVoxelData] = useState<VoxelResult | null>(null);
  const [savedScans, setSavedScans] = useState<SavedScan[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!sid) return;
    setLoading(true);
    outputApi
      .fetchResult(sid, undefined, modality === "T1")
      .then((res) => {
        setResult(res);
        engineRef.current.loadResult(res, res.vmin, res.vmax);
      })
      .catch((e: Error) => toast(`Result fetch failed: ${e.message}`, "error"))
      .finally(() => setLoading(false));
    outputApi.fetchScatter(sid).then(setScatter).catch(() => {});
    outputApi.fetchSavedScans(sid).then((d) => setSavedScans(d.scans)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid]);

  function fetchSlice(z: number, ignoreThresh: boolean) {
    if (!sid) return;
    const reqId = ++sliceRequestIdRef.current;
    outputApi.fetchResult(sid, z, ignoreThresh).then((res) => {
      if (reqId !== sliceRequestIdRef.current) return; // superseded by a newer slice request
      setResult(res);
      engineRef.current.updateResult(res);
    });
  }

  function handleSliceChange(z: number) {
    fetchSlice(z, useAll);
  }

  function handleIgnoreThreshChange(v: boolean) {
    setUseAll(v);
    fetchSlice(result?.z ?? 0, v);
  }

  async function handleSelectVoxel(x: number, y: number, z: number) {
    if (!sid) return;
    setSelected({ x, y, z });
    engineRef.current.setSelected({ x, y });
    try {
      const d = await outputApi.fetchVoxel(sid, x, y, z);
      setVoxelData(d);
    } catch {
      /* voxel fetch best-effort, matches vanilla's silent failure */
    }
    if (z !== (result?.z ?? -1)) fetchSlice(z, useAll);
  }

  function handleMapClick(fracX: number, fracY: number) {
    const vox = engineRef.current.clickToVoxel(fracX, fracY);
    if (!vox) return;
    handleSelectVoxel(vox[0], vox[1], result?.z ?? 0);
  }

  function handleJumpToVoxel(vox: { x: number; y: number; z: number }) {
    setMode("voxel");
    handleSelectVoxel(vox.x, vox.y, vox.z);
  }

  async function refreshSavedScans() {
    if (!sid) return;
    const d = await outputApi.fetchSavedScans(sid);
    setSavedScans(d.scans);
  }

  function handleModeChange(m: Mode) {
    setMode(m);
    if (m === "compare") refreshSavedScans();
    if (m === "voxel" && !scatter && sid) outputApi.fetchScatter(sid).then(setScatter);
  }

  async function handleSaveScan(label: string) {
    if (!sid) {
      toast("No session — fit a scan first", "error");
      return;
    }
    try {
      const d = await outputApi.saveScan(sid, label || currentScanLabel);
      toast(`"${d.label}" saved (${d.n_saved} total)`, "ok");
      await refreshSavedScans();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  async function handleRemoveScan(id: string) {
    if (!sid) return;
    await outputApi.deleteSavedScan(sid, id);
    await refreshSavedScans();
  }

  const modes: { key: Mode; label: string }[] = [
    { key: "roi", label: "ROI Summary" },
    { key: "voxel", label: "Voxel Explorer" },
    { key: "compare", label: "Comparison" },
  ];

  return (
    <div>
      <div className="mb-3.5 flex gap-1.5">
        {modes.map((m) => (
          <button
            key={m.key}
            onClick={() => handleModeChange(m.key)}
            className={`rounded-full border px-4.5 py-1.5 text-xs font-semibold transition-colors ${
              mode === m.key ? "border-navy bg-navy text-white" : "border-border bg-transparent text-muted"
            }`}
          >
            {m.label}
            {m.key === "compare" && savedScans.length > 0 && (
              <span className="ml-1.5 inline-block rounded-full bg-accent-light px-2 py-0.5 text-[11px] font-bold text-navy">
                {savedScans.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {loading && !result && <p className="text-xs text-muted">Loading result…</p>}

      {mode !== "compare" ? (
        <div className="grid grid-cols-[1fr_1fr_320px] gap-5">
          <MapPanel
            engine={engineRef.current}
            result={result}
            mode={mode}
            scatter={scatter}
            onSliceChange={handleSliceChange}
            onMapClick={handleMapClick}
            onJumpToVoxel={handleJumpToVoxel}
            onIgnoreThreshChange={handleIgnoreThreshChange}
          />
          {mode === "roi" && result && (
            <>
              <DecayHistPanel result={result} />
              <StatsSidebar
                sid={sid!}
                stats={result.stats}
                onRefit={() => setStep(3)}
                onGoToCompare={() => handleModeChange("compare")}
              />
            </>
          )}
          {mode === "voxel" && (
            <>
              <VoxelSignalPanel voxelData={voxelData} />
              <VoxelSidebar
                scatter={scatter}
                selected={selected}
                voxelData={voxelData}
                label={result?.label ?? "T2"}
                onSelectVoxel={handleSelectVoxel}
                onRefit={() => setStep(3)}
              />
            </>
          )}
        </div>
      ) : (
        <ComparisonPanel
          scans={savedScans}
          defaultLabel={currentScanLabel}
          onSave={handleSaveScan}
          onRemove={handleRemoveScan}
        />
      )}
    </div>
  );
}
