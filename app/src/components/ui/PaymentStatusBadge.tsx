import type { Invoice } from "@/store/types";

// Dias 13-15: "Pendiente de Pago" / "Pagada" no son valores de
// `invoices.status` -- se derivan de paidAt, igual que ExportStatusBadge
// deriva su propio estado. Solo aplica a facturas ya sincronizadas con BC;
// antes de eso no hay nada que pagar. "exported" es el estado terminal
// desde 2026-09-02 (bc-export-invoice ya no crea Factura de Compra, solo
// sincroniza la Orden) -- "processed" se sigue aceptando por las facturas
// reales que ya llegaron a ese estado con el flujo viejo.
type PaymentState = "not_applicable" | "pending_payment" | "paid";

function derivePaymentState(invoice: Pick<Invoice, "status" | "paidAt">): PaymentState {
  if (invoice.status !== "exported" && invoice.status !== "processed") return "not_applicable";
  return invoice.paidAt ? "paid" : "pending_payment";
}

const labels: Record<PaymentState, string> = {
  not_applicable: "-",
  pending_payment: "Pendiente de pago",
  paid: "Pagada",
};

const tones: Record<PaymentState, string> = {
  not_applicable: "bg-slate-100 text-slate-500",
  pending_payment: "bg-amber-100 text-amber-700",
  paid: "bg-emerald-100 text-emerald-700",
};

export function PaymentStatusBadge({ invoice }: { invoice: Pick<Invoice, "status" | "paidAt"> }) {
  const state = derivePaymentState(invoice);
  if (state === "not_applicable") return null;
  return (
    <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${tones[state]}`}>
      {labels[state]}
    </span>
  );
}
