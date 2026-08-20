import type { Invoice } from "@/store/types";

// Dias 13-15: "Pendiente de Pago" / "Pagada" no son valores de
// `invoices.status` (que se queda en "processed") -- se derivan de
// paidAt, igual que ExportStatusBadge deriva su propio estado. Solo
// aplica a facturas ya procesadas; antes de eso no hay nada que pagar.
type PaymentState = "not_applicable" | "pending_payment" | "paid";

function derivePaymentState(invoice: Pick<Invoice, "status" | "paidAt">): PaymentState {
  if (invoice.status !== "processed") return "not_applicable";
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
