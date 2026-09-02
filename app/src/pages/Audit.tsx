import { useMemo } from "react";
import { useTranslation } from "@/i18n";
import { useDomainStore } from "@/store/domain";
import { Card } from "@/components/ui/Card";

// Hallazgo QA 2026-09-02: los estados que faltaban aca (pending_approval,
// paid, export_error) se mostraban crudos ("Estado: pending_approval") en
// vez de un mensaje traducido -- confirmado en vivo en /audit.
const STATUS_MESSAGE_KEY: Record<string, string> = {
  uploaded: "invoiceUploadedAudit",
  pending_approval: "invoiceConfirmedForApprovalAudit",
  approved: "invoiceApprovedAudit",
  rejected: "invoiceRejectedAudit",
  ready_for_export: "invoiceQueuedAudit",
  exported: "invoiceExportedAudit",
  processed: "invoiceExportedAudit",
  paid: "invoicePaidAudit",
  export_error: "invoiceExportErrorAudit",
};

function formatDate(value: string) {
  return value ? new Date(value).toLocaleString("es-DO") : "";
}

// Reconstruccion de `function eP()` — index-beautified.js:25666.
export function Audit() {
  const { t } = useTranslation();
  const auditEvents = useDomainStore((s) => s.auditEvents);
  const invoices = useDomainStore((s) => s.invoices);
  const users = useDomainStore((s) => s.users);

  const invoicesById = useMemo(() => new Map(invoices.map((inv) => [inv.id, inv])), [invoices]);
  const usersById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">{t("traceability")}</p>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">{t("auditTitle")}</h1>
        <p className="max-w-2xl text-sm leading-6 text-slate-600 sm:text-base">{t("auditDescription")}</p>
      </section>

      <Card className="p-5">
        <div className="space-y-4">
          {auditEvents.map((event) => {
            const invoice = invoicesById.get(event.entityId);
            const actor = usersById.get(event.changedBy);
            const messageKey = STATUS_MESSAGE_KEY[event.status];
            const message = messageKey
              ? `${t(messageKey)} ${invoice?.invoiceNumber ?? event.entityId.slice(0, 8)}`
              : `${t("status")}: ${event.status}`;
            return (
              <div key={event.id} className="rounded-2xl border border-slate-200 p-4">
                <div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                  <p className="font-medium text-slate-900">{message}</p>
                  <p className="text-xs text-slate-500">{formatDate(event.changedAt)}</p>
                </div>
                <p className="mt-1 text-sm text-slate-600">
                  invoice - {actor?.username ?? actor?.email ?? event.changedBy.slice(0, 8)}
                </p>
                {event.reason && <p className="mt-1 text-sm text-slate-500">{event.reason}</p>}
              </div>
            );
          })}
          {auditEvents.length === 0 && <p className="py-10 text-center text-sm text-slate-500">{t("emptyState")}</p>}
        </div>
      </Card>
    </div>
  );
}
