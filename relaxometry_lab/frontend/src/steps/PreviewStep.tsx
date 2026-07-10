import { useEffect, useRef, useState } from "react";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { OrthoPanel } from "./preview/OrthoPanel";
import { OrthoEngine, type OrthoRefs, type ViewName } from "../ortho/OrthoEngine";
import { useAppStore } from "../store/appStore";
import { toast } from "../store/toastStore";

const VIEWS: { view: ViewName; label: string; axisLetter: string; barClass: string }[] = [
  { view: "axial", label: "Axial", axisLetter: "Z", barClass: "bg-[#7b1f1f]" },
  { view: "coronal", label: "Coronal", axisLetter: "Y", barClass: "bg-[#6b5200]" },
  { view: "sagittal", label: "Sagittal", axisLetter: "X", barClass: "bg-[#1a5e2e]" },
];

export function PreviewStep() {
  const sid = useAppStore((s) => s.sid);
  const scanReady = useAppStore((s) => s.scanReady);
  const modality = useAppStore((s) => s.modality);
  const nVols = useAppStore((s) => s.nVols);
  const acqParams = useAppStore((s) => s.acqParams);
  const setStep = useAppStore((s) => s.setStep);

  const engineRef = useRef<OrthoEngine>(new OrthoEngine());
  const canvasRefs = useRef<Partial<Record<ViewName, HTMLCanvasElement>>>({});
  const posLabelRefs = useRef<Partial<Record<ViewName, HTMLSpanElement>>>({});
  const sliceInputRefs = useRef<Partial<Record<ViewName, HTMLInputElement>>>({});
  const sliceValueRefs = useRef<Partial<Record<ViewName, HTMLSpanElement>>>({});
  const volInputRef = useRef<HTMLInputElement>(null);
  const volValueRef = useRef<HTMLSpanElement>(null);

  const [loading, setLoading] = useState(true);
  const [overlayOn, setOverlayOn] = useState(false);
  const [overlayAlpha, setOverlayAlphaState] = useState(0.4);

  const acqLabel = modality === "T1" ? "Flip Angle" : "TE";

  useEffect(() => {
    const engine = engineRef.current;
    const refs: OrthoRefs = {
      canvases: canvasRefs.current as Record<ViewName, HTMLCanvasElement>,
      sliceInputs: sliceInputRefs.current as Record<ViewName, HTMLInputElement>,
      sliceValues: sliceValueRefs.current as Record<ViewName, HTMLSpanElement>,
      posLabels: posLabelRefs.current as Record<ViewName, HTMLSpanElement>,
    };
    engine.mount(refs);

    if (sid && scanReady) {
      setLoading(true);
      engine
        .load(sid, nVols, acqParams, acqLabel)
        .then(() => {
          if (volInputRef.current) {
            volInputRef.current.max = String(Math.max(0, nVols - 1));
            volInputRef.current.value = "0";
          }
          if (volValueRef.current) volValueRef.current.textContent = engine.volValueLabel();
        })
        .catch((e: Error) => toast(`Preview load error: ${e.message}`, "error"))
        .finally(() => setLoading(false));
    }

    return () => engine.unmount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleVolInput(idx: number) {
    if (!sid) return;
    engineRef.current
      .setVol(sid, idx)
      .then(() => {
        if (volValueRef.current) volValueRef.current.textContent = engineRef.current.volValueLabel();
      })
      .catch((e: Error) => toast(`Volume load error: ${e.message}`, "error"));
  }

  function handleOverlayToggle(checked: boolean) {
    setOverlayOn(checked);
    engineRef.current.toggleOverlay(checked);
  }

  function handleOverlayAlpha(v: number) {
    setOverlayAlphaState(v);
    engineRef.current.setOverlayAlpha(v);
  }

  return (
    <div className="mx-auto max-w-[940px]">
      <Card title="Multi-Viewer Preview">
        <div className="mt-1 mb-3.5 flex items-center gap-2.5">
          <input
            type="checkbox"
            id="seg-overlay-chk"
            checked={overlayOn}
            onChange={(e) => handleOverlayToggle(e.target.checked)}
          />
          <label htmlFor="seg-overlay-chk" className="text-xs text-muted">
            Segmentation Overlay
          </label>
          <span className="ml-2.5 text-[11px] text-muted">Opacity</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={overlayAlpha}
            className="w-[70px] accent-navy"
            onChange={(e) => handleOverlayAlpha(Number(e.target.value))}
          />
          <label className="ml-4 text-[11px] text-muted">{acqLabel}</label>
          <input ref={volInputRef} type="range" min={0} max={0} defaultValue={0} step={1} className="w-[90px] accent-navy" onInput={(e) => handleVolInput(Number((e.target as HTMLInputElement).value))} />
          <span ref={volValueRef} className="min-w-[50px] text-[11px] text-navy" />
        </div>

        <div className="mb-3 grid grid-cols-3 gap-3">
          {VIEWS.map(({ view, label, axisLetter, barClass }) => (
            <OrthoPanel
              key={view}
              view={view}
              label={label}
              axisLetter={axisLetter}
              barClassName={barClass}
              canvasRef={(el) => {
                if (el) canvasRefs.current[view] = el;
              }}
              posLabelRef={(el) => {
                if (el) posLabelRefs.current[view] = el;
              }}
              sliceInputRef={(el) => {
                if (el) sliceInputRefs.current[view] = el;
              }}
              sliceValueRef={(el) => {
                if (el) sliceValueRefs.current[view] = el;
              }}
              onSliceInput={(val) => engineRef.current.setSlice(view, val)}
            />
          ))}
        </div>

        {loading && <p className="mb-2 text-xs text-muted">Loading volume…</p>}

        <div className="mt-3 flex gap-2.5">
          <Button variant="ghost" small onClick={() => setStep(1)}>
            ← Back
          </Button>
          <Button small onClick={() => setStep(3)}>
            Continue to Fit →
          </Button>
        </div>
      </Card>
    </div>
  );
}
