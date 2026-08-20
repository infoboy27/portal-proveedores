import type { InvoiceStatus } from "@/store/types";

// Equivalente a `Cl` + `tl()` en el bundle original: el estado de
// exportacion se DERIVA del status de la factura, no es una columna aparte.
type ExportState = "pending" | "processing" | "completed" | "error";

function deriveExportState(status: InvoiceStatus): ExportState {
  if (status === "exported" || status === "processed") return "completed";
  if (status === "export_error") return "error";
  if (status === "ready_for_export") return "processing";
  return "pending";
}

const labels: Record<ExportState, string> = {
  pending: "Pendiente",
  processing: "Procesando",
  completed: "Completado",
  error: "Error de exportacion",
};

const tones: Record<ExportState, string> = {
  pending: "bg-slate-100 text-slate-700",
  processing: "bg-violet-100 text-violet-700",
  completed: "bg-teal-100 text-teal-700",
  error: "bg-rose-100 text-rose-700",
};

export function ExportStatusBadge({ status }: { status: InvoiceStatus }) {
  const state = deriveExportState(status);
  return (
    <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${tones[state]}`}>
      {labels[state]}
    </span>
  );
}
