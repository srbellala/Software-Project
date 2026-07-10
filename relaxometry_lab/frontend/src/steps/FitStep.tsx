import { useEffect, useState } from "react";
import { Button } from "../components/Button";
import { ParamTable } from "./fit/ParamTable";
import {
  DEFAULT_T1_PARAMS,
  DEFAULT_T2_PARAMS,
  collectT1Params,
  collectT2Params,
  type T1ParamState,
  type T2ParamState,
} from "./fit/paramConfig";
import { startFit, subscribeFitProgress } from "../api/fit";
import { useAppStore } from "../store/appStore";
import { toast } from "../store/toastStore";
import { loadPlotly } from "../lib/loadPlotly";

export function FitStep() {
  const sid = useAppStore((s) => s.sid);
  const modality = useAppStore((s) => s.modality);
  const setStep = useAppStore((s) => s.setStep);
  const setFittingDone = useAppStore((s) => s.setFittingDone);

  // Output (next step) needs Plotly (~4.5MB) — start fetching it now in the
  // background, since a fit run takes several seconds anyway, rather than
  // waiting until the user lands on Output.
  useEffect(() => {
    loadPlotly().catch(() => {});
  }, []);

  const [t2, setT2] = useState<T2ParamState>(DEFAULT_T2_PARAMS);
  const [t1, setT1] = useState<T1ParamState>(DEFAULT_T1_PARAMS);
  const [trMs, setTrMs] = useState(15);

  const [running, setRunning] = useState(false);
  const [pct, setPct] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");

  const isT2 = modality === "T2";
  const modelName = isT2 ? "T2 Mono-Exponential" : "T1 VFA (Variable Flip Angle)";
  const modelEqn = isT2 ? "S(TE) = C + S₀ · e−TE·R2" : "S(α) = S₀ · sin(α) · (1−E₁) / (1−cos(α)·E₁)";

  function onT2Change(patch: Partial<T2ParamState>) {
    setT2((p) => ({ ...p, ...patch }));
  }
  function onT1Change(patch: Partial<T1ParamState>) {
    setT1((p) => ({ ...p, ...patch }));
  }

  async function runFit() {
    if (!sid) {
      toast("No session", "error");
      return;
    }
    const params = isT2 ? collectT2Params(t2) : collectT1Params(t1);
    setRunning(true);
    setPct(0);
    setProgressLabel("Starting…");

    try {
      await startFit(sid, { modality, params, tr_ms: isT2 ? null : trMs });
    } catch {
      toast("Fit start failed", "error");
      setRunning(false);
      return;
    }

    subscribeFitProgress(sid, {
      onProgress: (p, done, total) => {
        setPct(p);
        setProgressLabel(`Fitting… ${done} / ${total} voxels (${p}%)`);
      },
      onDone: () => {
        setPct(100);
        setProgressLabel("Complete!");
        toast("Fitting complete", "ok");
        setRunning(false);
        setFittingDone(true);
        setTimeout(() => setStep(4), 600);
      },
      onError: (message) => {
        toast(`Fit error: ${message}`, "error");
        setRunning(false);
      },
    });
  }

  return (
    <div className="mx-auto max-w-[860px]">
      <div className="rounded-card bg-card px-6.5 py-5.5 shadow-card">
        <div className="mb-4.5 flex items-start justify-between border-b border-border pb-3.5">
          <div>
            <div className="mb-1 font-mono text-[11px] text-muted">Relaxometry · Fit</div>
            <div className="text-[22px] font-bold text-navy">Configure the Fit</div>
          </div>
          <span className="pt-1.5 text-[11px] whitespace-nowrap text-muted">Model: {modelName}</span>
        </div>

        <div className="mb-5 flex items-center gap-5 rounded-lg border border-border bg-[#f7f6f2] px-4 py-2.5">
          <div className="min-w-40 text-[13px] font-bold whitespace-nowrap text-navy">{modelName}</div>
          <div className="font-serif text-sm text-text italic">{modelEqn}</div>
        </div>

        <ParamTable modality={modality} t2={t2} onT2Change={onT2Change} t1={t1} onT1Change={onT1Change} />

        {!isT2 && (
          <div className="my-2.5 flex items-center gap-2">
            <span className="text-xs text-muted">TR</span>
            <input
              type="number"
              value={trMs}
              min={1}
              max={10000}
              step={1}
              onChange={(e) => setTrMs(e.target.valueAsNumber)}
              className="w-24 rounded-md border border-border bg-white px-2 py-1.5 text-xs text-text focus:border-accent focus:outline-none"
            />
            <span className="text-[11px] text-muted">ms</span>
          </div>
        )}

        <p className="my-4 text-[11px] leading-[1.75] text-muted italic">
          Voxels are fit inside the mask only; fits with R² below the threshold are discarded. Derived rows (grey)
          are computed from their reciprocal.
        </p>

        {running && (
          <>
            <div className="mt-2.5 h-2.5 overflow-hidden rounded-lg bg-[#e8e5dc]">
              <div className="h-full rounded-lg bg-navy transition-[width] duration-300" style={{ width: `${pct}%` }} />
            </div>
            <div className="mt-1.5 text-[11px] text-muted">{progressLabel}</div>
          </>
        )}

        <div className="mt-4 flex items-center justify-between border-t border-border pt-3.5">
          <Button variant="ghost" small onClick={() => setStep(2)}>
            ← Back
          </Button>
          <Button disabled={running} onClick={runFit}>
            Run fit →
          </Button>
        </div>
      </div>
    </div>
  );
}
