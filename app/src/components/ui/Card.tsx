import type { HTMLAttributes } from "react";

// Equivalente a `De` en el bundle original.
export function Card({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-[28px] border border-white/70 bg-white/95 shadow-[0_20px_60px_rgba(15,23,42,0.08)] ${className}`}
      {...props}
    />
  );
}
