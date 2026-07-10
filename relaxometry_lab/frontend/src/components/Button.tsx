import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "ghost";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  small?: boolean;
}

const BASE =
  "inline-flex items-center gap-1.5 rounded-lg font-semibold cursor-pointer transition-[opacity,background] disabled:cursor-not-allowed disabled:opacity-40";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-navy text-white enabled:hover:bg-navy-light",
  ghost: "bg-transparent text-navy border border-navy enabled:hover:bg-accent-light",
};

export function Button({ variant = "primary", small = false, className = "", ...rest }: ButtonProps) {
  const size = small ? "px-3.5 py-1.5 text-xs" : "px-5 py-2.5 text-[13px]";
  return <button className={`${BASE} ${VARIANTS[variant]} ${size} ${className}`} {...rest} />;
}
