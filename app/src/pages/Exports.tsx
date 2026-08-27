import { useState } from "react";
import { useTranslation } from "@/i18n";
import { useSessionStore } from "@/store/session";
import { useDomainStore } from "@/store/domain";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ExportStatusBadge } from "@/components/ui/ExportStatusBadge";

type ExportResult =
  | { kind: "success"; invoiceNumber: string; bcInvoiceNumber: string; attached: boolean }
  | { kind: "error"; invoiceNumber: string; message: string };

// Reconstruccion de `function wP()` (Monitoreo de exportaciones) del bundle
// original, index-beautified.js:27330.
//
// Fase A: "Exportar ahora" ahora llama de verdad a Business Central via la
// Edge Function bc-export-invoice (ver domain.ts:exportInvoice). El boton se
// muestra para facturas "approved" — el flujo actual de aprobacion nunca
// produce el estado "ready_for_export" (definido en types.ts pero sin
// ninguna transicion que lo alcance), asi que se acepta tambien "approved"
// como disparador, igual que ya hace el conteo de Dashboard.tsx.

function formatUpdated(value: string) {
  if (!value) return "";
  return new Date(value).toLocaleString("es-DO");
}

export function Exports() {
  const { t } = useTranslation();
  const session = useSessionStore((s) => s.session);
  const invoices = useDomainStore((s) => s.invoices);
  const exportInvoice = useDomainStore((s) => s.exportInvoice);
  const fetchAll = useDomainStore((s) => s.fetchAll);
  const loading = useDomainStore((s) => s.loading);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);

  async function handleExport(invoiceId: string, invoiceNumber: string) {
    if (!session.userId) return;
    setExportingId(invoiceId);
    try {
      const { bcInvoiceNumber, attached } = await exportInvoice(invoiceId, session.userId);
      setResult({ kind: "success", invoiceNumber, bcInvoiceNumber, attached });
    } catch (err) {
      setResult({ kind: "error", invoiceNumber, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setExportingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">
            {t("erpIntegration")}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">{t("exportsTitle")}</h1>
          <p className="max-w-2xl text-sm leading-6 text-slate-600 sm:text-base">{t("exportsDescription")}</p>
        </div>
        <Button variant="ghost" onClick={() => fetchAll()} disabled={loading}>
          {t("refreshStatus")}
        </Button>
      </div>

      <div className="grid gap-4">
        {invoices.map((inv) => (
          <Card key={inv.id} className="p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold text-slate-950">{inv.invoiceNumber}</p>
                  <StatusBadge status={inv.status} />
                  <ExportStatusBadge status={inv.status} />
                </div>
                <p className="text-sm text-slate-500">
                  {t("updated") ?? "Actualizado"} {formatUpdated(inv.updatedAt)} - {t("erp") ?? "ERP"}{" "}
                  {inv.erpId ?? t("pending")}
                </p>
                {inv.status === "export_error" && inv.rejectionReason ? (
                  <p className="text-sm text-rose-700">{inv.rejectionReason}</p>
                ) : null}
              </div>
              {inv.status === "approved" || inv.status === "ready_for_export" ? (
                <Button onClick={() => handleExport(inv.id, inv.invoiceNumber)} disabled={exportingId === inv.id}>
                  {exportingId === inv.id ? "Exportando..." : t("exportNow")}
                </Button>
              ) : null}
            </div>
          </Card>
        ))}
        {invoices.length === 0 && (
          <Card className="p-10 text-center text-sm text-slate-500">
            {t("noPurchaseOrdersFoundDescription")}
          </Card>
        )}
      </div>

      {result && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4" role="dialog" aria-modal="true">
          <Card className="w-full max-w-md p-6">
            {result.kind === "success" ? (
              <>
                <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-600">
                  Exportacion exitosa
                </p>
                <p className="mt-2 text-lg font-semibold text-slate-950">Factura {result.invoiceNumber}</p>
                <p className="mt-3 text-sm text-slate-600">
                  Creada en Business Central como <span className="font-semibold text-slate-900">{result.bcInvoiceNumber}</span>.
                </p>
                <p className="mt-1 text-sm text-slate-600">
                  {result.attached ? "El PDF se adjunto correctamente." : "No tenia PDF para adjuntar."}
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold uppercase tracking-[0.18em] text-rose-600">Error al exportar</p>
                <p className="mt-2 text-lg font-semibold text-slate-950">Factura {result.invoiceNumber}</p>
                <p className="mt-3 text-sm text-rose-700">{result.message}</p>
              </>
            )}
            <div className="mt-5 flex justify-end">
              <Button onClick={() => setResult(null)}>Cerrar</Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
