import type { ReactNode } from "react";
import { Card } from "./Card";

interface StatCardProps {
  title: string;
  value: string;
  description: string;
  icon?: ReactNode;
}

// Equivalente a `cl` en el bundle original.
export function StatCard({ title, value, description, icon }: StatCardProps) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">{title}</p>
        {icon}
      </div>
      <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">{value}</p>
      <p className="mt-1 text-sm text-slate-500">{description}</p>
    </Card>
  );
}
