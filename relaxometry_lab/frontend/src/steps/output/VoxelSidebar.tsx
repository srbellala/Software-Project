import { useMemo } from "react";
import { Button } from "../../components/Button";
import { PlotlyChart } from "../../components/PlotlyChart";
import type { ScatterResult, VoxelResult } from "../../api/output";

interface VoxelSidebarProps {
  scatter: ScatterResult | null;
  selected: { x: number; y: number; z: number } | null;
  voxelData: VoxelResult | null;
  label: string;
  onSelectVoxel: (x: number, y: number, z: number) => void;
  onRefit: () => void;
}

export function VoxelSidebar({ scatter, selected, voxelData, label, onSelectVoxel, onRefit }: VoxelSidebarProps) {
  const traces = useMemo(() => {
    if (!scatter?.voxels?.length) return [];
    const voxels = scatter.voxels;
    const good = voxels.filter((v) => (v.r2_fit ?? 1) >= 0.5);
    const poor = voxels.filter((v) => (v.r2_fit ?? 1) < 0.5);
    const mkGood = (pts: typeof voxels) => ({
      x: pts.map((p) => voxels.indexOf(p)),
      y: pts.map((v) => v.t2),
      mode: "markers",
      marker: { color: "rgba(35,74,110,0.65)", size: 4 },
      customdata: pts,
      hovertemplate: `%{y:.1f} ms<extra></extra>`,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t: any[] = [
      { ...mkGood(good), name: "Good fit" },
      { ...mkGood(poor), name: "Poor fit", marker: { color: "rgba(210,95,80,0.7)", size: 4 } },
    ];
    if (selected) {
      const si = voxels.findIndex((v) => v.x === selected.x && v.y === selected.y && v.z === selected.z);
      if (si >= 0) {
        t.push({
          x: [si],
          y: [voxels[si].t2],
          mode: "markers",
          marker: { color: "rgba(210,40,40,0.9)", size: 10, symbol: "circle", line: { color: "#fff", width: 1.5 } },
          hovertemplate: `%{y:.1f} ms<extra>Selected</extra>`,
        });
      }
    }
    return t;
  }, [scatter, selected]);

  const layout = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const l: any = {
      showlegend: false,
      xaxis: { title: { text: "Voxel index", standoff: 14 }, color: "#6b7e94", gridcolor: "#e8e6e0", zeroline: false },
      yaxis: { title: { text: `${label} (ms)`, standoff: 4 }, color: "#6b7e94", gridcolor: "#e8e6e0", zeroline: false },
    };
    if (scatter?.median != null) {
      l.shapes = [
        {
          type: "line",
          x0: 0,
          x1: 1,
          xref: "paper",
          y0: scatter.median,
          y1: scatter.median,
          yref: "y",
          line: { color: "rgba(70,130,90,0.6)", width: 1, dash: "dash" },
        },
      ];
      l.annotations = [
        {
          x: 1,
          xref: "paper",
          xanchor: "right",
          y: scatter.median,
          yref: "y",
          yanchor: "bottom",
          text: `median ${scatter.median.toFixed(0)}`,
          showarrow: false,
          font: { size: 9, color: "rgba(70,130,90,0.9)" },
        },
      ];
    }
    return l;
  }, [scatter, label]);

  return (
    <div className="flex flex-col rounded-card bg-card px-6.5 py-5.5 shadow-card">
      <div className="mb-0.5 text-[15px] font-bold text-navy">
        {label} Distribution{scatter?.n ? `  (n=${scatter.n})` : ""}
      </div>
      <div className="mb-1.5 text-[10px] text-muted">Click to Select Voxel</div>
      <PlotlyChart
        data={traces}
        layout={layout}
        className="h-[300px] w-full rounded-md"
        onPointClick={(e) => {
          const pt = e.points?.[0];
          if (!pt) return;
          const vox = (pt.customdata as { x: number; y: number; z: number } | undefined) ?? scatter?.voxels?.[Math.round(pt.x)];
          if (vox) onSelectVoxel(vox.x, vox.y, vox.z);
        }}
      />

      <hr className="my-3.5 border-t border-border" />

      <div className="mb-2 text-[15px] font-bold text-navy">Selected Voxel</div>
      <table className="mb-4 w-full border-collapse text-xs">
        <tbody>
          <tr className="border-b border-[#f0efeb]">
            <td className="py-1.5 text-muted">Position</td>
            <td className="py-1.5 text-right font-semibold text-navy">
              {selected ? `(${selected.x}, ${selected.y}, ${selected.z})` : "—"}
            </td>
          </tr>
          <tr className="border-b border-[#f0efeb]">
            <td className="py-1.5 text-muted">{voxelData?.modality === "T1" ? "T1 (ms)" : "T2 (ms)"}</td>
            <td className="py-1.5 text-right font-semibold text-navy">
              {voxelData && isFinite(voxelData.t2) ? `${voxelData.t2.toFixed(1)} ms` : "—"}
            </td>
          </tr>
          <tr className="border-b border-[#f0efeb]">
            <td className="py-1.5 text-muted">Fit quality (R²)</td>
            <td className="py-1.5 text-right font-semibold text-navy">
              {voxelData && isFinite(voxelData.r2_fit) ? voxelData.r2_fit.toFixed(3) : "—"}
            </td>
          </tr>
          <tr className="border-b border-[#f0efeb]">
            <td className="py-1.5 text-muted">RMSE</td>
            <td className="py-1.5 text-right font-semibold text-navy">
              {voxelData && isFinite(voxelData.rmse) ? voxelData.rmse.toFixed(1) : "—"}
            </td>
          </tr>
        </tbody>
      </table>

      <hr className="my-3.5 border-t border-border" />
      <Button variant="ghost" className="w-full justify-center" onClick={onRefit}>
        ← Refit
      </Button>
    </div>
  );
}
