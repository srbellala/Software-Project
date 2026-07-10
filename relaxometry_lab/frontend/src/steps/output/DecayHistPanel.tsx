import { useMemo } from "react";
import { PlotlyChart } from "../../components/PlotlyChart";
import type { FitResult } from "../../api/output";

export function DecayHistPanel({ result }: { result: FitResult }) {
  const decayTraces = useMemo(() => {
    const acq = result.acq_params || [];
    const curve = result.decay_curve || [];
    if (!acq.length || !curve.length) return [];
    const p25 = result.decay_p25 || [];
    const p75 = result.decay_p75 || [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const traces: any[] = [];
    if (p25.length === acq.length && p75.length === acq.length) {
      traces.push(
        { x: acq, y: p25, mode: "lines", line: { width: 0 }, hoverinfo: "skip", showlegend: false },
        {
          x: acq,
          y: p75,
          mode: "lines",
          line: { width: 0 },
          fill: "tonexty",
          fillcolor: "rgba(74,144,196,0.2)",
          name: "IQR",
          hoverinfo: "skip",
        }
      );
    }
    traces.push({
      x: acq,
      y: curve,
      mode: "lines+markers",
      name: "Median",
      line: { color: "#234a6e", width: 2 },
      marker: { color: "#4a90c4", size: 6 },
    });
    return traces;
  }, [result]);

  const histTraces = useMemo(() => {
    if (!result.hist_counts?.length) return [];
    const edges = result.hist_edges;
    const mids = edges.slice(0, -1).map((e, i) => (e + edges[i + 1]) / 2);
    return [
      {
        x: mids,
        y: result.hist_counts,
        type: "bar",
        marker: { color: "#234a6e", opacity: 0.8 },
        hovertemplate: "%{x:.1f} ms: %{y}<extra></extra>",
      },
    ];
  }, [result]);

  const xlabel = result.label === "T2" ? "Echo Time (ms)" : "Flip Angle (°)";
  const decayTitle = result.label === "T2" ? "Median Decay Curve" : "Median VFA Curve";

  return (
    <div className="flex h-full flex-col gap-2 rounded-card bg-card px-6.5 py-5.5 shadow-card">
      <div className="text-[15px] font-bold text-navy">{decayTitle}</div>
      <PlotlyChart
        data={decayTraces}
        layout={{
          xaxis: { title: { text: xlabel, standoff: 14 }, color: "#6b7e94", gridcolor: "#e8e6e0", zeroline: false },
          yaxis: { title: { text: "Signal", standoff: 14 }, color: "#6b7e94", gridcolor: "#e8e6e0", zeroline: false },
        }}
        className="min-h-0 flex-[4_1_0] rounded-md"
      />

      <hr className="my-3.5 border-t border-border" />

      <div className="mb-1.5 text-[15px] font-bold text-navy">{result.label} Distribution</div>
      <PlotlyChart
        data={histTraces}
        layout={{
          bargap: 0.05,
          xaxis: {
            title: { text: `${result.label} (ms)`, standoff: 14 },
            color: "#6b7e94",
            gridcolor: "#e8e6e0",
            zeroline: false,
          },
          yaxis: { color: "#6b7e94", gridcolor: "#e8e6e0", zeroline: false },
        }}
        className="min-h-0 flex-[3_1_0] rounded-md"
      />
    </div>
  );
}
