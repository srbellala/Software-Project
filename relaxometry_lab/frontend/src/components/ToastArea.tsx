import { useToastStore } from "../store/toastStore";

const TYPE_CLASSES: Record<string, string> = {
  info: "bg-navy",
  ok: "bg-[#3a9e6e]",
  error: "bg-[#c0392b]",
};

export function ToastArea() {
  const toasts = useToastStore((s) => s.toasts);

  return (
    <div className="fixed bottom-6 right-6 z-[1000] flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`animate-[slideIn_0.2s_ease] rounded-lg px-4.5 py-2.5 text-[13px] text-white shadow-card ${TYPE_CLASSES[t.type]}`}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
