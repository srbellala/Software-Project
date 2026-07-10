import type { PropsWithChildren, ReactNode } from "react";

interface CardProps {
  title: ReactNode;
  subtitle?: ReactNode;
  onClear?: () => void;
  clearDisabled?: boolean;
  clearTitle?: string;
  className?: string;
}

export function Card({
  title,
  subtitle,
  onClear,
  clearDisabled = true,
  clearTitle = "Clear",
  className = "",
  children,
}: PropsWithChildren<CardProps>) {
  return (
    <div className={`relative rounded-card bg-card px-6.5 py-5.5 shadow-card ${className}`}>
      {onClear && (
        <button
          type="button"
          title={clearTitle}
          disabled={clearDisabled}
          onClick={onClear}
          className="absolute top-4 right-4.5 flex h-6 w-6 items-center justify-center rounded-full border-none bg-bg text-[13px] text-muted transition-colors hover:bg-[#f3d9d6] hover:text-[#b3261e] disabled:pointer-events-none disabled:cursor-default disabled:opacity-35"
        >
          ✕
        </button>
      )}
      <div className="mb-1 text-[15px] font-bold text-navy">{title}</div>
      {subtitle && <div className="mb-4 text-xs text-muted">{subtitle}</div>}
      {children}
    </div>
  );
}
