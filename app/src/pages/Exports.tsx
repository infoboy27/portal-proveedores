import { useMemo, useState } from "react";
import { useTranslation } from "@/i18n";
import { useSessionStore } from "@/store/session";
import { useDomainStore } from "@/store/domain";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ExportStatusBadge } from "@/components/ui/ExportStatusBadge";
import type { Invoice } from "@/store/types";

type ExportResult =
  | { kind: "success"; invoiceNumber: string; orderNumber: string; attached: boolean }
  | { kind: "error"; invoiceNumber: string; message: string };

interface BatchResultItem {
  invoiceId: string;
  invoiceNumber: string;
  kind: "success" | "error";
  orderNumber?: string;
  message?: string;
}

// Reconstruccion de `function wP()` (Monitoreo de exportaciones) del bundle
// original, index-beautified.js:27330.
//
// Fase A: "Exportar ahora" llama de verdad a Business Central via la Edge
// Function bc-export-invoice (ver domain.ts:exportInvoice). El boton se
// muestra para facturas "approved" — el flujo actual de aprobacion nunca
// produce el estado "ready_for_export" (definido en types.ts pero sin
// ninguna transicion que lo alcance), asi que se acepta tambien "approved"
// como disparador, igual que ya hace el conteo de Dashboard.tsx.
//
// 2026-09-02: dejo de crear una Factura de Compra en BC -- solo completa
// la seccion General de la Orden de Compra (fecha/Nº factura/NCF) y
// adjunta el PDF ahi. Ver el comentario grande en bc-export-invoice/index.ts.
//
// 2026-09-02 (QA): fila sin numero visible para facturas recien cargadas
// (invoiceNumber aun vacio) -- mismo fallback a los primeros 8 caracteres
// del id que ya usa Invoices.tsx.
//
// 2026-09-02 (Key Players, item 9): seleccion individual/multiple +
// exportacion en lote. Cada factura se exporta con su propia llamada a
// exportInvoice (mismo camino de siempre, uno por uno) -- nunca se crea
// una numeracion compartida, cada resultado queda atado a su propio
// invoiceId/invoiceNumber/orderNumber. Un error en una no detiene el
// resto del lote (se sigue con las demas, se reporta cada una por
// separado, y se puede reintentar solo las fallidas).

function formatUpdated(value: string) {
  if (!value) return "";
  return new Date(value).toLocaleString("es-DO");
}

function canExport(inv: Invoice) {
  // "export_error" tiene que poder reintentarse (2026-09-03) -- ver el
  // mismo comentario en bc-export-invoice/index.ts:EXPORTABLE_STATUSES.
  return inv.status === "approved" || inv.status === "ready_for_export" || inv.status === "export_error";
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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchResults, setBatchResults] = useState<BatchResultItem[] | null>(null);

  const exportable = useMemo(() => invoices.filter(canExport), [invoices]);
  const allSelected = exportable.length > 0 && exportable.every((inv) => selectedIds.has(inv.id));
  const someSelected = exportable.some((inv) => selectedIds.has(inv.id));

  function toggleSelectAll() {
    setSelectedIds(allSelected ? new Set() : new Set(exportable.map((inv) => inv.id)));
  }

  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleExport(invoiceId: string, invoiceNumber: string) {
    if (!session.userId) return;
    setExportingId(invoiceId);
    try {
      const { orderNumber, attached } = await exportInvoice(invoiceId, session.userId);
      setResult({ kind: "success", invoiceNumber, orderNumber, attached });
    } catch (err) {
      setResult({ kind: "error", invoiceNumber, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setExportingId(null);
    }
  }

  async function runBatch(ids: string[]) {
    if (!session.userId || ids.length === 0) return;
    setBatchRunning(true);
    const targets = invoices.filter((inv) => ids.includes(inv.id));
    const results: BatchResultItem[] = [];
    for (const inv of targets) {
      const invoiceNumber = inv.invoiceNumber || inv.id.slice(0, 8);
      try {
        const { orderNumber, attached } = await exportInvoice(inv.id, session.userId);
        results.push({ invoiceId: inv.id, invoiceNumber, kind: "success", orderNumber, message: attached ? undefined : "sin PDF adjunto" });
      } catch (err) {
        results.push({ invoiceId: inv.id, invoiceNumber, kind: "error", message: err instanceof Error ? err.message : String(err) });
      }
    }
    setBatchResults(results);
    setSelectedIds(new Set());
    setBatchRunning(false);
  }

  function retryFailed() {
    if (!batchResults) return;
    const failedIds = batchResults.filter((r) => r.kind === "error").map((r) => r.invoiceId);
    setBatchResults(null);
    void runBatch(failedIds);
  }

  const batchSuccessCount = batchResults?.filter((r) => r.kind === "success").length ?? 0;
  const batchErrorCount = batchResults?.filter((r) => r.kind === "error").length ?? 0;

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

      {exportable.length > 0 && (
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleSelectAll}
              className="h-4 w-4 rounded border-slate-300"
            />
            Seleccionar todos ({exportable.length} exportables)
          </label>
          <Button onClick={() => void runBatch(Array.from(selectedIds))} disabled={!someSelected || batchRunning}>
            {batchRunning ? "Exportando lote..." : `Exportar seleccionadas (${selectedIds.size})`}
          </Button>
        </Card>
      )}

      <div className="grid gap-4">
        {invoices.map((inv) => (
          <Card key={inv.id} className="p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex items-start gap-3">
                {canExport(inv) && (
                  <input
                    type="checkbox"
                    checked={selectedIds.has(inv.id)}
                    onChange={() => toggleOne(inv.id)}
                    className="mt-1 h-4 w-4 rounded border-slate-300"
                    aria-label={`Seleccionar factura ${inv.invoiceNumber || inv.id.slice(0, 8)}`}
                  />
                )}
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-slate-950">{inv.invoiceNumber || inv.id.slice(0, 8)}</p>
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
              </div>
              {canExport(inv) ? (
                <Button onClick={() => handleExport(inv.id, inv.invoiceNumber)} disabled={exportingId === inv.id || batchRunning}>
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
                  Orden de Compra <span className="font-semibold text-slate-900">{result.orderNumber}</span> actualizada
                  en Business Central con la fecha, Nº factura y NCF.
                </p>
                <p className="mt-1 text-sm text-slate-600">
                  {result.attached ? "El PDF se adjunto a la orden correctamente." : "No tenia PDF para adjuntar."}
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

      {batchResults && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4" role="dialog" aria-modal="true">
          <Card className="w-full max-w-lg p-6">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-600">
              Exportacion completada — {batchSuccessCount} exitosas, {batchErrorCount} con error
            </p>
            <div className="mt-4 max-h-80 space-y-2 overflow-y-auto">
              {batchResults.map((r) => (
                <div
                  key={r.invoiceId}
                  className={`flex items-start justify-between gap-3 rounded-lg border p-3 text-sm ${
                    r.kind === "success" ? "border-emerald-200 bg-emerald-50" : "border-rose-200 bg-rose-50"
                  }`}
                >
                  <div>
                    <p className="font-semibold text-slate-900">
                      {r.kind === "success" ? "✓" : "✕"} {r.invoiceNumber}
                    </p>
                    {r.kind === "success" ? (
                      <p className="text-xs text-slate-600">
                        Orden {r.orderNumber}
                        {r.message ? ` — ${r.message}` : ""}
                      </p>
                    ) : (
                      <p className="text-xs text-rose-700">{r.message}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              {batchErrorCount > 0 && (
                <Button variant="ghost" onClick={retryFailed} disabled={batchRunning}>
                  Reintentar fallidas ({batchErrorCount})
                </Button>
              )}
              <Button onClick={() => setBatchResults(null)}>Cerrar</Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
