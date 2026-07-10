import { Fragment } from "react";
import { useAppStore, type WizardStep } from "../store/appStore";

const STEPS: { n: WizardStep; label: string }[] = [
  { n: 1, label: "Load" },
  { n: 2, label: "Preview" },
  { n: 3, label: "Fit" },
  { n: 4, label: "Output" },
];

export function WizardHeader() {
  const step = useAppStore((s) => s.step);
  const setStep = useAppStore((s) => s.setStep);
  const highestStepReached = useAppStore((s) => s.highestStepReached);

  function go(n: WizardStep) {
    // Only steps already visited are directly clickable — matches the old
    // app's "active/complete" class check on the step circles.
    if (n <= highestStepReached) setStep(n);
  }

  return (
    <div className="mb-7 flex items-center">
      {STEPS.map((s, i) => {
        const status = s.n < step ? "complete" : s.n === step ? "active" : "idle";
        return (
          <Fragment key={s.n}>
            <div className="flex flex-shrink-0 items-center">
              <div
                onClick={() => go(s.n)}
                className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border-2 text-[13px] font-bold transition-colors ${
                  status === "active"
                    ? "cursor-pointer border-navy bg-navy text-white hover:brightness-115"
                    : status === "complete"
                      ? "cursor-pointer border-[#3a9e6e] bg-[#3a9e6e] text-white hover:brightness-112"
                      : "border-border bg-card text-muted"
                }`}
              >
                {s.n}
              </div>
              <span
                className={`ml-2 whitespace-nowrap text-xs font-semibold ${
                  status === "active" ? "text-navy" : status === "complete" ? "text-[#3a9e6e]" : "text-muted"
                }`}
              >
                {s.label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div className={`mx-2 h-0.5 min-w-6 flex-1 ${s.n < step ? "bg-[#3a9e6e]" : "bg-border"}`} />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
