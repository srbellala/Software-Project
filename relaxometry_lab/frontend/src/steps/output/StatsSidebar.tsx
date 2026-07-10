import { Button } from "../../components/Button";
import { downloadUrl, type FitResult } from "../../api/output";

function fmt(v: number | undefined): string {
  return v !== undefined ? `${v.toFixed(1)} ms` : "—";
}

function triggerDownload(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  a.click();
}

export function StatsSidebar({
  sid,
  stats,
  onRefit,
  onGoToCompare,
}: {
  sid: string;
  stats: FitResult["stats"];
  onRefit: () => void;
  onGoToCompare: () => void;
}) {
  return (
    <div className="flex flex-col rounded-card bg-card px-6.5 py-5.5 shadow-card">
      <div className="mb-2.5 text-[15px] font-bold text-navy">ROI Statistics</div>
      <table className="mb-4 w-full border-collapse text-xs">
        <tbody>
          {[
            ["Median", fmt(stats.median)],
            ["Mean", fmt(stats.mean)],
            ["Std", fmt(stats.std)],
            ["P25", fmt(stats.p25)],
            ["P75", fmt(stats.p75)],
            ["Voxels in ROI", stats.n_vox ?? "—"],
          ].map(([label, val]) => (
            <tr key={label} className="border-b border-[#f0efeb]">
              <td className="py-1.5 text-muted">{label}</td>
              <td className="py-1.5 text-right font-semibold text-navy">{val}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <hr className="my-3.5 border-t border-border" />
      <div className="mb-2.5 text-[15px] font-bold text-navy">Downloads</div>
      <div className="flex flex-col gap-2">
        <Button className="w-full justify-center" onClick={() => triggerDownload(downloadUrl(sid, "map"))}>
          ↓ Map (NIfTI)
        </Button>
        <Button variant="ghost" className="w-full justify-center" onClick={() => triggerDownload(downloadUrl(sid, "stats"))}>
          ↓ Stats (CSV)
        </Button>
        <Button variant="ghost" className="w-full justify-center" onClick={() => triggerDownload(downloadUrl(sid, "voxels"))}>
          ↓ Voxels (.npz)
        </Button>
        <Button variant="ghost" className="w-full justify-center" onClick={() => triggerDownload(downloadUrl(sid, "report"))}>
          ↓ Report (PDF)
        </Button>
      </div>

      <hr className="my-3.5 border-t border-border" />
      <Button variant="ghost" className="w-full justify-center" onClick={onRefit}>
        ← Refit
      </Button>

      <hr className="my-3.5 border-t border-border" />
      <div className="mb-2 text-[15px] font-bold text-navy">Comparison</div>
      <Button variant="ghost" className="w-full justify-center" onClick={onGoToCompare}>
        Save &amp; Compare Results →
      </Button>
    </div>
  );
}
