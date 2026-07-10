import { useMemo, useState } from "react";
import { Button } from "../../components/Button";
import { PlotlyChart } from "../../components/PlotlyChart";
import type { SavedScan } from "../../api/output";

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function fmt(v: number | undefined): string {
  return v !== undefined && isFinite(v) ? v.toFixed(1) : "—";
}
function fmtN(v: number | undefined): string {
  return v !== undefined && isFinite(v) ? v.toLocaleString() : "—";
}

interface ComparisonPanelProps {
  scans: SavedScan[];
  defaultLabel: string;
  onSave: (label: string) => Promise<void>;
  onRemove: (id: string) => void;
}

export function ComparisonPanel({ scans, defaultLabel, onSave, onRemove }: ComparisonPanelProps) {
  const [label, setLabel] = useState(defaultLabel);

  const histTraces = useMemo(
    () =>
      scans
        .filter((s) => s.hist_counts?.length)
        .map((sc) => {
          const mids = sc.hist_edges.slice(0, -1).map((e, i) => (e + sc.hist_edges[i + 1]) / 2);
          return {
            x: mids,
            y: sc.hist_counts,
            type: "scatter",
            mode: "lines",
            name: sc.label,
            line: { color: sc.color, width: 2 },
            fill: "tozeroy",
            fillcolor: hexToRgba(sc.color, 0.1),
          };
        }),
    [scans]
  );

  const decayTraces = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const traces: any[] = [];
    scans
      .filter((s) => s.decay_curve?.length)
      .forEach((sc) => {
        const acq = sc.acq_params;
        const p25 = sc.decay_p25,
          p75 = sc.decay_p75;
        if (p25?.length === acq.length && p75?.length === acq.length) {
          traces.push({ x: acq, y: p25, mode: "lines", line: { width: 0 }, hoverinfo: "skip", showlegend: false });
          traces.push({
            x: acq,
            y: p75,
            mode: "lines",
            line: { width: 0 },
            fill: "tonexty",
            fillcolor: hexToRgba(sc.color, 0.12),
            hoverinfo: "skip",
            showlegend: false,
          });
        }
        traces.push({
          x: acq,
          y: sc.decay_curve,
          mode: "lines+markers",
          name: sc.label,
          line: { color: sc.color, width: 2 },
          marker: { color: sc.color, size: 5 },
        });
      });
    return traces;
  }, [scans]);

  const xlabel = scans.some((s) => s.modality === "T2") ? "Echo Time (ms)" : "Flip Angle (°)";
  const legendLayout = {
    showlegend: true,
    legend: { x: 0.98, xanchor: "right", y: 0.98, bgcolor: "rgba(0,0,0,0)", font: { size: 9 } },
    xaxis: { color: "#6b7e94", gridcolor: "#e8e6e0", zeroline: false },
    yaxis: { color: "#6b7e94", gridcolor: "#e8e6e0", zeroline: false },
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex items-center gap-2.5">
          <span className="text-[15px] font-bold text-navy">Saved Results</span>
          {scans.length > 0 && (
            <span className="inline-block rounded-full bg-accent-light px-2.5 py-0.5 text-[11px] font-bold text-navy">
              {scans.length} saved
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label for current result…"
            className="w-56 rounded-lg border border-border bg-white px-3 py-1.5 text-xs text-text placeholder:text-muted focus:border-accent focus:outline-none"
          />
          <Button
            small
            onClick={async () => {
              await onSave(label);
              setLabel("");
            }}
          >
            Save current result
          </Button>
        </div>
      </div>

      {scans.length === 0 ? (
        <div className="rounded-card bg-card px-8 py-16 text-center text-muted shadow-card">
          <div className="mb-3.5 text-[40px]">📊</div>
          <div className="mb-2 text-base font-bold text-navy">No results saved yet</div>
          <div className="mx-auto max-w-[480px] text-[13px] leading-relaxed">
            Fit a scan, then type a label above and click &quot;Save current result&quot;.
            <br />
            Go back to Load, pick a different scan from the same Bruker study, fit it, and save again.
            <br />
            All saved results appear here for side-by-side comparison.
          </div>
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-card bg-card shadow-card">
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr>
                  {["", "Scan", "Type", "Median (ms)", "Mean (ms)", "Std (ms)", "P25 (ms)", "P75 (ms)", "Voxels", ""].map(
                    (h, i) => (
                      <th
                        key={i}
                        className={`border-b-2 border-border bg-[#f7f6f2] px-3.5 py-2.5 text-left text-[10.5px] font-bold tracking-[.05em] whitespace-nowrap text-muted uppercase ${
                          i >= 3 && i <= 8 ? "text-right" : ""
                        }`}
                      >
                        {h}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody>
                {scans.map((sc) => (
                  <tr key={sc.id}>
                    <td className="border-b border-[#f0efeb] py-2.5 pr-1.5 pl-3.5">
                      <span className="inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ background: sc.color }} />
                    </td>
                    <td className="border-b border-[#f0efeb] px-3.5 py-2.5">
                      <span className="max-w-55 truncate text-[12.5px] font-semibold text-text" title={sc.label}>
                        {sc.label}
                      </span>
                    </td>
                    <td className="border-b border-[#f0efeb] px-3.5 py-2.5 text-[11px] text-muted">{sc.modality}</td>
                    <td className="border-b border-[#f0efeb] px-3.5 py-2.5 text-right text-xs font-semibold text-navy">
                      {fmt(sc.stats.median)}
                    </td>
                    <td className="border-b border-[#f0efeb] px-3.5 py-2.5 text-right text-xs text-muted">{fmt(sc.stats.mean)}</td>
                    <td className="border-b border-[#f0efeb] px-3.5 py-2.5 text-right text-xs text-muted">{fmt(sc.stats.std)}</td>
                    <td className="border-b border-[#f0efeb] px-3.5 py-2.5 text-right text-xs text-muted">{fmt(sc.stats.p25)}</td>
                    <td className="border-b border-[#f0efeb] px-3.5 py-2.5 text-right text-xs text-muted">{fmt(sc.stats.p75)}</td>
                    <td className="border-b border-[#f0efeb] px-3.5 py-2.5 text-right text-xs text-muted">{fmtN(sc.stats.n_vox)}</td>
                    <td className="border-b border-[#f0efeb] px-3.5 py-2.5">
                      <button
                        title="Remove"
                        onClick={() => onRemove(sc.id)}
                        className="rounded px-1.5 py-0.5 text-base text-muted transition-colors hover:bg-[#fdf0ee] hover:text-[#c0392b]"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid grid-cols-2 gap-5">
            <div className="rounded-card bg-card px-6.5 py-5.5 shadow-card">
              <div className="mb-1.5 text-[15px] font-bold text-navy">Distribution Overlay</div>
              <PlotlyChart data={histTraces} layout={{ ...legendLayout, xaxis: { ...legendLayout.xaxis, title: { text: "Value (ms)", standoff: 14 } } }} className="h-[240px] w-full rounded-md" />
            </div>
            <div className="rounded-card bg-card px-6.5 py-5.5 shadow-card">
              <div className="mb-1.5 text-[15px] font-bold text-navy">Signal Decay Overlay</div>
              <PlotlyChart data={decayTraces} layout={{ ...legendLayout, xaxis: { ...legendLayout.xaxis, title: { text: xlabel, standoff: 14 } }, yaxis: { ...legendLayout.yaxis, title: { text: "Signal", standoff: 14 } } }} className="h-[240px] w-full rounded-md" />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
