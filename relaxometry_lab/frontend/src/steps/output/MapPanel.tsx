import { useEffect, useRef, useState } from "react";
import type { MapEngine } from "../../output/MapEngine";
import type { FitResult, ScatterResult } from "../../api/output";

interface MapPanelProps {
  engine: MapEngine;
  result: FitResult | null;
  mode: "roi" | "voxel" | "compare";
  scatter: ScatterResult | null;
  onSliceChange: (z: number) => void;
  onMapClick: (fracX: number, fracY: number) => void;
  onJumpToVoxel: (vox: { x: number; y: number; z: number }) => void;
  onIgnoreThreshChange: (v: boolean) => void;
}

function CtrlButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center rounded-lg border border-navy bg-transparent px-3 py-1.5 text-[11px] font-semibold whitespace-nowrap text-navy transition-colors hover:bg-accent-light"
    >
      {children}
    </button>
  );
}

export function MapPanel({
  engine,
  result,
  mode,
  scatter,
  onSliceChange,
  onMapClick,
  onJumpToVoxel,
  onIgnoreThreshChange,
}: MapPanelProps) {
  const mapCanvasRef = useRef<HTMLCanvasElement>(null);
  const colorbarRef = useRef<HTMLCanvasElement>(null);
  const [sliceVal, setSliceVal] = useState(0);
  const [overlayAlpha, setOverlayAlphaState] = useState(0.75);
  const [t2Min, setT2Min] = useState(0);
  const [t2Max, setT2Max] = useState(0);
  const [ignoreThresh, setIgnoreThresh] = useState(false);
  const [targetT2, setTargetT2] = useState(30);
  const [cbMin, setCbMin] = useState(0);
  const [cbMax, setCbMax] = useState(0);

  useEffect(() => {
    if (!mapCanvasRef.current || !colorbarRef.current) return;
    engine.mount({ mapCanvas: mapCanvasRef.current, colorbarCanvas: colorbarRef.current });
    engine.onSliceWheel = (delta) => {
      const el = document.getElementById("map-slice-slider") as HTMLInputElement | null;
      const cur = el ? Number(el.value) : 0;
      const max = el ? Number(el.max) : 0;
      const next = Math.max(0, Math.min(max, cur + delta));
      onSliceChange(next);
    };
    return () => engine.unmount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!result) return;
    setSliceVal(result.z);
    setCbMin(result.vmin);
    setCbMax(result.vmax);
    setT2Min(Math.round(result.vmin));
    setT2Max(Math.round(result.vmax));
  }, [result]);

  function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (mode !== "voxel") return;
    const rect = e.currentTarget.getBoundingClientRect();
    onMapClick((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
  }

  function applyT2Range() {
    engine.setRange(t2Min, t2Max);
    setCbMin(t2Min);
    setCbMax(t2Max);
  }

  function resetT2Range() {
    if (!result) return;
    setT2Min(Math.round(result.vmin));
    setT2Max(Math.round(result.vmax));
    engine.setRange(result.vmin, result.vmax);
    setCbMin(result.vmin);
    setCbMax(result.vmax);
  }

  function jumpTo(type: "global_median" | "slice_median" | "highest_slice" | "highest_global") {
    if (!scatter?.voxels?.length) return;
    let vox;
    if (type === "global_median") {
      const med = scatter.median ?? 0;
      vox = scatter.voxels.reduce((b, v) => (Math.abs(v.t2 - med) < Math.abs(b.t2 - med) ? v : b));
    } else if (type === "slice_median") {
      const sv = scatter.voxels.filter((v) => v.z === sliceVal);
      if (!sv.length) return;
      const med = sv.reduce((s, v) => s + v.t2, 0) / sv.length;
      vox = sv.reduce((b, v) => (Math.abs(v.t2 - med) < Math.abs(b.t2 - med) ? v : b));
    } else if (type === "highest_slice") {
      const sv = scatter.voxels.filter((v) => v.z === sliceVal);
      if (!sv.length) return;
      vox = sv.reduce((b, v) => (v.t2 > b.t2 ? v : b));
    } else {
      vox = scatter.voxels.reduce((b, v) => (v.t2 > b.t2 ? v : b));
    }
    onJumpToVoxel(vox);
  }

  function jumpToTargetT2() {
    if (!scatter?.voxels?.length) return;
    const vox = scatter.voxels.reduce((b, v) => (Math.abs(v.t2 - targetT2) < Math.abs(b.t2 - targetT2) ? v : b));
    onJumpToVoxel(vox);
  }

  return (
    <div className="flex flex-col gap-2 rounded-card bg-card px-6.5 py-5.5 shadow-card">
      <div className="mb-1 flex items-center justify-between">
        <div className="text-[15px] font-bold text-navy">{result?.label ?? "T2"} Map</div>
        {mode === "voxel" && <span className="text-[11px] text-muted italic">Click map to select voxel</span>}
      </div>

      <div className="mt-1 flex items-center gap-2.5">
        <label className="text-[11px] whitespace-nowrap text-muted">Slice</label>
        <input
          id="map-slice-slider"
          type="range"
          min={0}
          max={result ? result.n_slices - 1 : 0}
          value={sliceVal}
          onChange={(e) => {
            const z = Number(e.target.value);
            setSliceVal(z);
            onSliceChange(z);
          }}
          className="flex-1 accent-navy"
        />
        <span className="min-w-9 text-right text-[11px] text-navy">{sliceVal}</span>
      </div>

      <div className="relative overflow-hidden rounded-md bg-[#0d0d0d]">
        <canvas ref={mapCanvasRef} onClick={handleClick} className="block w-full" />
      </div>

      <div className="flex items-center gap-2 text-[11px] text-muted">
        <span>{cbMin.toFixed(0)}</span>
        <canvas ref={colorbarRef} className="h-3.5 flex-1 rounded" />
        <span>{cbMax.toFixed(0)}</span>
        <span>ms</span>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <span className="text-[11px] text-muted">Map Opacity</span>
        <input
          type="range"
          min={0.1}
          max={1}
          step={0.05}
          value={overlayAlpha}
          onChange={(e) => {
            const v = Number(e.target.value);
            setOverlayAlphaState(v);
            engine.setOverlayAlpha(v);
          }}
          className="flex-1 accent-navy"
        />
        <span className="min-w-8 text-[11px] text-navy">{Math.round(overlayAlpha * 100)}%</span>
      </div>

      {mode === "voxel" && (
        <div className="mt-2.5 flex flex-col gap-2.5 border-t border-border pt-2.5">
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[10px] font-semibold tracking-[.04em] text-muted uppercase">View</span>
            <CtrlButton onClick={() => engine.rotate(-90)}>↺ 90</CtrlButton>
            <CtrlButton onClick={() => engine.rotate(90)}>90 ↻</CtrlButton>
            <CtrlButton onClick={() => engine.flip("h")}>Flip H</CtrlButton>
            <CtrlButton onClick={() => engine.flip("v")}>Flip V</CtrlButton>
            <CtrlButton onClick={() => engine.resetView()}>Reset view</CtrlButton>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[10px] font-semibold tracking-[.04em] text-muted uppercase">T2 min</span>
            <input
              type="number"
              value={t2Min}
              onChange={(e) => setT2Min(e.target.valueAsNumber)}
              onBlur={applyT2Range}
              className="w-14 rounded-lg border border-border bg-white px-2 py-1.5 text-[11px] text-text focus:border-accent focus:outline-none"
            />
            <span className="text-[10px] font-semibold tracking-[.04em] text-muted uppercase">T2 max</span>
            <input
              type="number"
              value={t2Max}
              onChange={(e) => setT2Max(e.target.valueAsNumber)}
              onBlur={applyT2Range}
              className="w-14 rounded-lg border border-border bg-white px-2 py-1.5 text-[11px] text-text focus:border-accent focus:outline-none"
            />
            <CtrlButton onClick={resetT2Range}>Reset T2</CtrlButton>
            <label className="flex cursor-pointer items-center gap-1 text-[11px] whitespace-nowrap text-muted">
              <input
                type="checkbox"
                checked={ignoreThresh}
                onChange={(e) => {
                  setIgnoreThresh(e.target.checked);
                  onIgnoreThreshChange(e.target.checked);
                }}
              />
              Ignore T2 threshold
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[10px] font-semibold tracking-[.04em] text-muted uppercase">Target T2</span>
            <input
              type="number"
              value={targetT2}
              onChange={(e) => setTargetT2(e.target.valueAsNumber)}
              className="w-14 rounded-lg border border-border bg-white px-2 py-1.5 text-[11px] text-text focus:border-accent focus:outline-none"
            />
            <CtrlButton onClick={jumpToTargetT2}>Jump to closest T2</CtrlButton>
            <CtrlButton onClick={() => jumpTo("global_median")}>Global Median</CtrlButton>
            <CtrlButton onClick={() => jumpTo("slice_median")}>Slice Median</CtrlButton>
            <CtrlButton onClick={() => jumpTo("highest_slice")}>Highest in Slice</CtrlButton>
            <CtrlButton onClick={() => jumpTo("highest_global")}>Highest Global</CtrlButton>
          </div>
        </div>
      )}
    </div>
  );
}
