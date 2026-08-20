import type { InvoiceStatus } from "@/store/types";

// Equivalente a `Sr` en el bundle original.
// Colores confirmados en extraido/02-rutas-y-modulos.md (auditoria del bundle).
const statusStyles: Record<InvoiceStatus, string> = {
  draft: "bg-slate-100 text-slate-700",
  uploaded: "bg-sky-100 text-sky-700",
  pending_approval: "bg-amber-100 text-amber-700",
  rejected: "bg-rose-100 text-rose-700",
  approved: "bg-emerald-100 text-emerald-700",
  ready_for_export: "bg-violet-100 text-violet-700",
  exported: "bg-teal-100 text-teal-700",
  processed: "bg-cyan-100 text-cyan-700",
  export_error: "bg-rose-100 text-rose-700",
};

export function StatusBadge({ status }: { status: InvoiceStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${statusStyles[status]}`}
    >
      {status}
    </span>
  );
}
