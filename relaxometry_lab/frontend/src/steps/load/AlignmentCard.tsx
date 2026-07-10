import { Card } from "../../components/Card";
import { Button } from "../../components/Button";
import { useAppStore } from "../../store/appStore";

const LEVEL_CLASSES: Record<string, string> = {
  idle: "border-border bg-[#f7f6f2] text-muted",
  ok: "border-[#3a9e6e] bg-[#edfaf3] text-[#235e41]",
  warn: "border-[#c87f0a] bg-[#fdf6ee] text-[#7a4a05]",
  err: "border-[#c0392b] bg-[#fdf0ee] text-[#7a1a12]",
};

export function AlignmentCard() {
  const alignMessage = useAppStore((s) => s.alignMessage);
  const alignLevel = useAppStore((s) => s.alignLevel);
  const scanReady = useAppStore((s) => s.scanReady);
  const checkReady = useAppStore((s) => s.checkReady);
  const setStep = useAppStore((s) => s.setStep);

  return (
    <Card
      title="Scan–Mask Alignment"
      subtitle="Checks that your mask covers the same voxel grid as your scan"
      className="flex h-full flex-col"
    >
      <div className={`min-h-[90px] rounded-lg border px-4 py-3.5 text-xs leading-[1.7] ${LEVEL_CLASSES[alignLevel]}`}>
        {alignMessage}
      </div>
      <div className="mt-auto pt-4">
        <Button
          className="w-full justify-center"
          disabled={!scanReady || !checkReady}
          onClick={() => setStep(2)}
        >
          Continue to Preview →
        </Button>
      </div>
    </Card>
  );
}
