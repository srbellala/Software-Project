import type { ViewName } from "../../ortho/OrthoEngine";

interface OrthoPanelProps {
  view: ViewName;
  label: string;
  axisLetter: string;
  barClassName: string;
  canvasRef: (el: HTMLCanvasElement | null) => void;
  posLabelRef: (el: HTMLSpanElement | null) => void;
  sliceInputRef: (el: HTMLInputElement | null) => void;
  sliceValueRef: (el: HTMLSpanElement | null) => void;
  onSliceInput: (val: number) => void;
}

export function OrthoPanel({
  view,
  label,
  axisLetter,
  barClassName,
  canvasRef,
  posLabelRef,
  sliceInputRef,
  sliceValueRef,
  onSliceInput,
}: OrthoPanelProps) {
  return (
    <div className="flex flex-col overflow-hidden rounded-md shadow-[0_1px_4px_rgba(0,0,0,.18)]">
      <div className={`flex flex-shrink-0 items-center justify-between px-2.5 py-1.5 text-[10px] font-bold tracking-[.08em] text-white uppercase ${barClassName}`}>
        <span>{label}</span>
        <span ref={posLabelRef} className="font-mono text-[10px] font-normal tracking-normal text-white/85 normal-case" />
      </div>
      <div className="relative aspect-square flex-1 bg-[#0d0d0d]" data-view={view}>
        <canvas ref={canvasRef} className="block h-full w-full" />
      </div>
      <div className="flex items-center gap-2 border-t border-border bg-[#f5f4f0] px-2 py-1.5">
        <label className="w-3.5 text-[11px] text-muted">{axisLetter}</label>
        <input
          ref={sliceInputRef}
          type="range"
          min={0}
          max={0}
          defaultValue={0}
          className="flex-1 accent-navy"
          onInput={(e) => onSliceInput(Number((e.target as HTMLInputElement).value))}
        />
        <span ref={sliceValueRef} className="w-7 text-right text-[11px] text-navy">
          0
        </span>
      </div>
    </div>
  );
}
