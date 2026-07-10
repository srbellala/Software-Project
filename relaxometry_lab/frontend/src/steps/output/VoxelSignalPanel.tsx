import { useMemo } from "react";
import { PlotlyChart } from "../../components/PlotlyChart";
import type { VoxelResult } from "../../api/output";

export function VoxelSignalPanel({ voxelData }: { voxelData: VoxelResult | null }) {
  const xlabel = voxelData?.modality === "T2" ? "TE (ms)" : "Flip Angle (°)";

  const signalTraces = useMemo(() => {
    if (!voxelData) return [];
    const { acq_params: acq, signal: sig, fitted: fit } = voxelData;
    if (!acq.length) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const traces: any[] = [
      {
        x: acq,
        y: sig,
        mode: "markers",
        name: "Measured",
        marker: { color: "#3a80c4", size: 8, line: { color: "#fff", width: 1.5 } },
        hovertemplate: `%{x:.1f}: %{y:.0f}<extra>Measured</extra>`,
      },
    ];
    if (fit.length) {
      traces.push({
        x: acq,
        y: fit,
        mode: "lines",
        name: "Fitted",
        line: { color: "#e8a020", width: 2.5 },
        hovertemplate: `%{x:.1f}: %{y:.0f}<extra>Fitted</extra>`,
      });
    }
    return traces;
  }, [voxelData]);

  const residualTraces = useMemo(() => {
    if (!voxelData) return [];
    const { acq_params: acq, residuals: res } = voxelData;
    if (!acq.length || !res.length) return [];
    const stemX: (number | null)[] = [];
    const stemY: (number | null)[] = [];
    acq.forEach((a, i) => {
      stemX.push(a, a, null);
      stemY.push(0, res[i], null);
    });
    return [
      { x: stemX, y: stemY, mode: "lines", line: { color: "rgba(190,50,50,0.7)", width: 1.5 }, hoverinfo: "skip" },
      {
        x: acq,
        y: res,
        mode: "markers",
        marker: { color: "rgba(190,50,50,0.85)", size: 7 },
        hovertemplate: `%{x:.1f}: %{y:.1f}<extra>Residual</extra>`,
      },
    ];
  }, [voxelData]);

  return (
    <div className="flex h-full flex-col gap-1.5 rounded-card bg-card px-6.5 py-5.5 shadow-card">
      <div className="mb-2 text-[15px] font-bold text-navy">Voxel Signal vs Fit</div>
      <PlotlyChart
        data={signalTraces}
        layout={{
          margin: { l: 56, r: 12, t: 10, b: 50 },
          showlegend: true,
          legend: { x: 0.98, xanchor: "right", y: 0.98, bgcolor: "rgba(0,0,0,0)", font: { size: 9 } },
          xaxis: { title: { text: xlabel, standoff: 14 }, automargin: true, color: "#6b7e94", gridcolor: "#e8e6e0", zeroline: false },
          yaxis: { title: { text: "Signal", standoff: 14 }, automargin: true, color: "#6b7e94", gridcolor: "#e8e6e0", zeroline: false },
        }}
        className="min-h-0 flex-[10_1_0] rounded-md"
      />
      <hr className="my-3.5 border-t border-border" />
      <div className="mb-1.5 text-[11px] font-semibold tracking-[.04em] text-muted uppercase">Residuals</div>
      <PlotlyChart
        data={residualTraces}
        layout={{
          margin: { l: 56, r: 12, t: 6, b: 50 },
          xaxis: { title: { text: xlabel, standoff: 14 }, automargin: true, color: "#6b7e94", gridcolor: "#e8e6e0", zeroline: false },
          yaxis: {
            title: { text: "Residual", standoff: 14 },
            automargin: true,
            color: "#6b7e94",
            gridcolor: "#e8e6e0",
            zeroline: true,
            zerolinecolor: "#bbb",
            zerolinewidth: 1,
          },
        }}
        className="min-h-0 flex-[7_1_0] rounded-md"
      />
    </div>
  );
}
