import { useEffect, useRef, useState } from "react";
import { loadPlotly } from "../lib/loadPlotly";

export const PLOTLY_CFG = { displayModeBar: false, responsive: true };
export const PLOTLY_LAYOUT = {
  paper_bgcolor: "#fafaf8",
  plot_bgcolor: "#fafaf8",
  font: { family: "system-ui, sans-serif", size: 10, color: "#6b7e94" },
  margin: { l: 46, r: 12, t: 10, b: 38 },
  showlegend: false,
};

interface PlotlyChartProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  layout?: any;
  className?: string;
  onPointClick?: (e: PlotlyClickEvent) => void;
}

/**
 * Thin imperative wrapper around the global Plotly.react — mirrors how the
 * vanilla app drives Plotly directly against a div by id. Kept imperative
 * (not react-plotly.js) since Plotly already owns its own DOM/redraw cycle;
 * fighting that with declarative re-renders would just be slower.
 */
export function PlotlyChart({ data, layout, className, onPointClick }: PlotlyChartProps) {
  const ref = useRef<PlotlyHTMLElement>(null);
  const onClickRef = useRef(onPointClick);
  onClickRef.current = onPointClick;
  const [ready, setReady] = useState(typeof window !== "undefined" && !!window.Plotly);

  useEffect(() => {
    let cancelled = false;
    loadPlotly().then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || !ready) return;
    Plotly.react(el, data, { ...PLOTLY_LAYOUT, ...layout }, PLOTLY_CFG).then(() => {
      if (onClickRef.current && !(el as unknown as { _clickBound?: boolean })._clickBound) {
        (el as unknown as { _clickBound?: boolean })._clickBound = true;
        el.on("plotly_click", (e) => onClickRef.current?.(e));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, layout, ready]);

  // Plotly attaches its own internal state (incl. WebGL contexts, event
  // listeners) to the div — React unmounting the div doesn't release any of
  // that. Without an explicit purge, switching between Output modes leaks a
  // chart's worth of resources every time, and browsers cap live WebGL
  // contexts (~8-16), so repeated switching eventually stalls the whole page.
  useEffect(() => {
    const el = ref.current;
    return () => {
      if (el) Plotly.purge(el);
    };
  }, []);

  return (
    <div ref={ref} className={className}>
      {!ready && <div className="flex h-full w-full items-center justify-center text-xs text-muted">Loading chart…</div>}
    </div>
  );
}

export function resizePlot(el: HTMLElement | null) {
  if (el && typeof Plotly !== "undefined" && (el as PlotlyHTMLElement).data) {
    Plotly.Plots.resize(el);
  }
}
