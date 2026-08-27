import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "@/i18n";
import { useSessionStore } from "@/store/session";
import { useDomainStore } from "@/store/domain";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { PaymentStatusBadge } from "@/components/ui/PaymentStatusBadge";
import type { InvoiceStatus } from "@/store/types";

const formatCurrency = (value: number) =>
  new Intl.NumberFormat("es-DO", { style: "currency", currency: "DOP" }).format(value);
// new Date("YYYY-MM-DD") parses as UTC midnight; formatting it in a
// negative-UTC-offset timezone (e.g. es-DO, UTC-4) then shows the previous
// day. Parse the date-only string as local calendar components instead.
const formatDate = (value: string | null) => {
  if (!value) return "-";
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("es-DO");
};

// Reconstruccion de `function jP()` — index-beautified.js:27385.
// Simplificado: se omite el flujo de carga con modal de "factura duplicada
// detectada" (bundle original usa un dialogo de confirmacion antes de subir
// cuando ya existe una factura para la misma orden).
export function InvoicesList() {
  const { t } = useTranslation();
  const session = useSessionStore((s) => s.session);
  const invoices = useDomainStore((s) => s.invoices);
  const purchaseOrders = useDomainStore((s) => s.purchaseOrders);
  const suppliers = useDomainStore((s) => s.suppliers);
  const uploadInvoice = useDomainStore((s) => s.uploadInvoice);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<InvoiceStatus | "all">("all");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const NO_ORDER = "__none__";
  const [selectedOrderId, setSelectedOrderId] = useState<string>("");

  const isAdmin = session.role === "admin" || session.role === "superadmin";
  const scopeCompanyId = session.activeCompany?.isGlobal ? null : session.activeCompany?.companyId ?? session.companyId;
  const isSupplier = session.role === "supplier";
  const canUpload = session.role === "admin" || session.role === "superadmin" || isSupplier;

  // Ordenes del proveedor donde tiene sentido cargar una factura -- "las que
  // tenga la orden de compra" (pedido de Jonatan, plan 2026-08-26). Se
  // excluyen "draft" (todavia no es real en BC) y "closed" (ya se
  // liquido). "partially_invoiced" se incluye a proposito: es el estado
  // normal cuando ya se cargo una factura y falta otra sobre la misma
  // orden (varias facturas por PO).
  const openOrdersForSupplier = useMemo(() => {
    if (!isSupplier || !session.supplierId) return [];
    return purchaseOrders.filter(
      (po) => po.vendorId === session.supplierId && (po.status === "open" || po.status === "partially_invoiced"),
    );
  }, [purchaseOrders, isSupplier, session.supplierId]);

  const scoped = useMemo(
    () =>
      invoices.filter((inv) => {
        if (isAdmin) return scopeCompanyId ? inv.companyId === scopeCompanyId : true;
        if (isSupplier) return !!session.supplierId && inv.supplierId === session.supplierId;
        return inv.companyId === session.companyId;
      }),
    [invoices, isAdmin, scopeCompanyId, isSupplier, session.supplierId, session.companyId],
  );

  const ordersById = useMemo(() => new Map(purchaseOrders.map((po) => [po.id, po])), [purchaseOrders]);
  const suppliersById = useMemo(() => new Map(suppliers.map((s) => [s.id, s])), [suppliers]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return scoped.filter((inv) => {
      const order = ordersById.get(inv.purchaseOrderId ?? "");
      const supplier = suppliersById.get(inv.supplierId ?? "");
      const matchesQuery =
        query.length === 0 ||
        inv.invoiceNumber.toLowerCase().includes(query) ||
        (inv.filename ?? "").toLowerCase().includes(query) ||
        order?.orderNumber.toLowerCase().includes(query) ||
        supplier?.displayName.toLowerCase().includes(query) ||
        inv.vendorName.toLowerCase().includes(query);
      const matchesStatus = statusFilter === "all" || inv.status === statusFilter;
      return matchesQuery && matchesStatus;
    });
  }, [scoped, search, statusFilter, ordersById, suppliersById]);

  const stats = useMemo(
    () => ({
      total: scoped.length,
      pending: scoped.filter((inv) => inv.status === "pending_approval").length,
      exported: scoped.filter((inv) => inv.status === "exported" || inv.status === "processed").length,
      errors: scoped.filter((inv) => inv.status === "export_error").length,
    }),
    [scoped],
  );

  // El proveedor debe elegir explicitamente una orden o "Sin orden de
  // compra" antes de poder subir -- antes esto se mandaba `null` siempre
  // sin preguntar, y la factura quedaba sin vincular sin que nadie lo
  // decidiera (plan de observaciones de usuarios, 2026-08-26).
  const requiresOrderChoice = isSupplier && openOrdersForSupplier.length > 0;
  const canPickFile = !requiresOrderChoice || selectedOrderId !== "";

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    if (!file || !session.userId) return;
    setUploading(true);
    setUploadError(null);
    try {
      const purchaseOrderId = selectedOrderId && selectedOrderId !== NO_ORDER ? selectedOrderId : null;
      const invoiceId = (
        await uploadInvoice({
          companyId: scopeCompanyId ?? session.companyId ?? "",
          purchaseOrderId,
          vendorId: isSupplier ? (session.supplierId ?? null) : null,
          invoiceNumber: "",
          vendorName: "",
          vendorTaxId: "",
          file,
          uploadedByUserId: session.userId,
        })
      ).invoiceId;
      setSelectedOrderId("");
      window.location.href = `/invoices/${invoiceId}?uploaded=1`;
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "No se pudo subir la factura.");
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">{t("invoicesTitle")}</h1>
          <p className="max-w-2xl text-sm leading-6 text-slate-600 sm:text-base">{t("invoicesDescription")}</p>
        </div>
        {canUpload && (
          <div className="flex flex-col items-end gap-2">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
              {uploading && (
                <div className="flex items-center gap-2 text-sm font-semibold text-cyan-700" role="status" aria-live="polite">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-cyan-200 border-t-cyan-700" />
                  Subiendo factura...
                </div>
              )}
              {requiresOrderChoice && (
                <Select
                  value={selectedOrderId}
                  onChange={(e) => setSelectedOrderId(e.target.value)}
                  className="sm:w-64"
                  disabled={uploading}
                >
                  <option value="">Selecciona la orden de compra...</option>
                  {openOrdersForSupplier.map((po) => (
                    <option key={po.id} value={po.id}>
                      {po.orderNumber} — {formatCurrency(po.amount)}
                    </option>
                  ))}
                  <option value={NO_ORDER}>Sin orden de compra</option>
                </Select>
              )}
              <Button onClick={() => fileInputRef.current?.click()} disabled={uploading || !canPickFile}>
                {t("uploadInvoice")}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf,.pdf,image/jpeg,.jpg,.jpeg,image/png,.png"
                className="hidden"
                onChange={handleFile}
              />
            </div>
            {uploadError && <p className="max-w-xs text-right text-sm text-rose-600">{uploadError}</p>}
          </div>
        )}
      </section>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: t("totalInvoices"), value: stats.total.toLocaleString() },
          { label: t("pendingInvoices"), value: stats.pending.toLocaleString() },
          ...(!isSupplier
            ? [
                { label: t("exportedInvoices"), value: stats.exported.toLocaleString() },
                { label: t("invoiceErrors"), value: stats.errors.toLocaleString() },
              ]
            : []),
        ].map((stat) => (
          <Card key={stat.label} className="rounded-[24px] border border-white/70 bg-white/90 p-5 shadow-[0_18px_55px_rgba(15,23,42,0.06)]">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">{stat.label}</p>
            <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">{stat.value}</p>
          </Card>
        ))}
      </div>

      <Card className="p-4 sm:p-5">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("searchApprovalsPlaceholder")} className="flex-1" />
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as InvoiceStatus | "all")} className="xl:w-[260px]">
            <option value="all">{t("allOrderStatuses")}</option>
            <option value="draft">draft</option>
            <option value="uploaded">uploaded</option>
            <option value="pending_approval">pending_approval</option>
            <option value="approved">approved</option>
            <option value="ready_for_export">ready_for_export</option>
            <option value="exported">exported</option>
            <option value="processed">processed</option>
            <option value="rejected">rejected</option>
            <option value="export_error">export_error</option>
          </Select>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left">
            <thead className="bg-slate-50/90 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              <tr>
                <th className="px-6 py-4">{t("invoices")}</th>
                <th className="px-6 py-4">{t("purchaseOrder")}</th>
                <th className="px-6 py-4">{t("supplierName")}</th>
                <th className="px-6 py-4">{t("invoiceDate")}</th>
                <th className="px-6 py-4">{t("total")}</th>
                <th className="px-6 py-4">{t("status")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.length > 0 ? (
                filtered.map((inv) => {
                  const order = ordersById.get(inv.purchaseOrderId ?? "");
                  const supplier = suppliersById.get(inv.supplierId ?? "");
                  return (
                    <tr key={inv.id} className="transition hover:bg-slate-50/80">
                      <td className="px-6 py-4">
                        <Link to={`/invoices/${inv.id}`} className="font-semibold text-cyan-700 hover:text-cyan-800">
                          {inv.invoiceNumber || inv.id.slice(0, 8)}
                        </Link>
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-600">{order?.orderNumber ?? t("unlinkedOrder")}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">{supplier?.displayName ?? inv.vendorName ?? "-"}</td>
                      <td className="px-6 py-4 text-sm text-slate-600">{formatDate(inv.invoiceDate)}</td>
                      <td className="px-6 py-4 font-semibold text-slate-950">{formatCurrency(inv.total)}</td>
                      <td className="px-6 py-4">
                        <StatusBadge status={inv.status} />
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={6} className="px-6 py-14 text-center text-sm text-slate-500">
                    {t("noInvoicesFoundDescription") ?? t("noPurchaseOrdersFoundDescription")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// Reconstruccion de `function CP()` — index-beautified.js:28035.
// Simplificado respecto al original: se omite el formulario para agregar
// lineas de factura manualmente y la edicion inline de campos extraidos por
// OCR (ver bundle original ~28167-28260). Se muestran las lineas existentes
// en modo lectura y las acciones principales del ciclo de vida (confirmar,
// aprobar, rechazar) segun el rol.
export function InvoiceDetail() {
  const { t } = useTranslation();
  const { invoiceId = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showUploadedBanner, setShowUploadedBanner] = useState(searchParams.get("uploaded") === "1");
  const session = useSessionStore((s) => s.session);
  const invoices = useDomainStore((s) => s.invoices);
  const purchaseOrders = useDomainStore((s) => s.purchaseOrders);
  const suppliers = useDomainStore((s) => s.suppliers);
  const invoiceLines = useDomainStore((s) => s.invoiceLines);
  const approveInvoice = useDomainStore((s) => s.approveInvoice);
  const rejectInvoice = useDomainStore((s) => s.rejectInvoice);
  const confirmInvoiceForApproval = useDomainStore((s) => s.confirmInvoiceForApproval);
  const updateInvoiceData = useDomainStore((s) => s.updateInvoiceData);
  const setInvoicePaymentDueDate = useDomainStore((s) => s.setInvoicePaymentDueDate);
  const markInvoicePaid = useDomainStore((s) => s.markInvoicePaid);
  const downloadInvoiceFile = useDomainStore((s) => s.downloadInvoiceFile);

  const [rejectReason, setRejectReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [paymentDueDateInput, setPaymentDueDateInput] = useState("");
  const [savingPaymentDueDate, setSavingPaymentDueDate] = useState(false);
  const [markPaidDateInput, setMarkPaidDateInput] = useState("");
  const [markPaidReferenceInput, setMarkPaidReferenceInput] = useState("");
  const [markingPaid, setMarkingPaid] = useState(false);
  const [markPaidError, setMarkPaidError] = useState<string | null>(null);
  const [invoiceNumberInput, setInvoiceNumberInput] = useState("");
  const [invoiceDateInput, setInvoiceDateInput] = useState("");
  const [invoiceTaxNumberInput, setInvoiceTaxNumberInput] = useState("");
  const [invoiceTotalInput, setInvoiceTotalInput] = useState("");
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const invoice = invoices.find((inv) => inv.id === invoiceId);
  const order = purchaseOrders.find((po) => po.id === invoice?.purchaseOrderId);
  const supplier = suppliers.find((s) => s.id === invoice?.supplierId);
  const lines = useMemo(() => invoiceLines.filter((l) => l.invoiceId === invoiceId), [invoiceLines, invoiceId]);
  // Puede haber varias facturas sobre la misma orden (plan de observaciones
  // de usuarios, 2026-08-26) -- se muestra cuanto ya se facturo de otras
  // facturas de esta orden para que el proveedor vea el saldo disponible.
  const otherInvoicesOnOrderTotal = useMemo(() => {
    if (!order) return 0;
    return invoices
      .filter((inv) => inv.id !== invoiceId && inv.purchaseOrderId === order.id && inv.status !== "rejected")
      .reduce((sum, inv) => sum + inv.total, 0);
  }, [invoices, order, invoiceId]);

  useEffect(() => {
    if (searchParams.get("uploaded") === "1") {
      setSearchParams((prev) => {
        prev.delete("uploaded");
        return prev;
      }, { replace: true });
    }
    // Solo al montar -- limpia el ?uploaded=1 de la URL una vez leido, para
    // que un refresh no vuelva a mostrar el banner de exito.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setPaymentDueDateInput(invoice?.paymentDueDate ?? "");
  }, [invoice?.paymentDueDate]);

  useEffect(() => {
    setInvoiceNumberInput(invoice?.invoiceNumber ?? "");
    setInvoiceDateInput(invoice?.invoiceDate ?? "");
    setInvoiceTaxNumberInput(invoice?.invoiceTaxNumber ?? "");
    setInvoiceTotalInput(invoice?.total ? String(invoice.total) : "");
  }, [invoice?.id]);

  if (!invoice) {
    return (
      <Card className="p-10 text-center">
        <p className="font-semibold text-slate-800">{t("notAvailable")}</p>
        <p className="mt-1 text-sm text-slate-500">{t("noInvoicesFoundDescription")}</p>
      </Card>
    );
  }

  const validationLabel =
    invoice.validInvoiceTaxNumber === true ? t("validated") : invoice.validInvoiceTaxNumber === false ? t("notValidated") : t("pending");
  const validationTone =
    invoice.validInvoiceTaxNumber === true
      ? "bg-emerald-100 text-emerald-700"
      : invoice.validInvoiceTaxNumber === false
        ? "bg-rose-100 text-rose-700"
        : "bg-slate-100 text-slate-700";

  const isApprover = session.role === "admin" || session.role === "superadmin" || session.role === "approver";
  const canConfirm = session.role === "supplier" && invoice.status === "uploaded";
  const canDecide = isApprover && invoice.status === "pending_approval";
  // PROVINFORM (informal) e INT (extranjero) no manejan NCF dominicano --
  // categoria sincronizada desde BC (vendorPostingSetups), no inventada por
  // el portal. Por defecto (vacio/desconocido) se sigue exigiendo NCF.
  const ncfRequired = !["PROVINFORM", "INT"].includes(supplier?.vendorPostingGroup ?? "");

  async function handleApprove() {
    if (!session.userId) return;
    setBusy(true);
    try {
      await approveInvoice(invoice!.id, session.userId);
    } finally {
      setBusy(false);
    }
  }
  async function handleReject() {
    if (!session.userId || !rejectReason.trim()) return;
    setBusy(true);
    try {
      await rejectInvoice(invoice!.id, session.userId, rejectReason.trim());
    } finally {
      setBusy(false);
    }
  }
  async function handleConfirm() {
    if (!session.userId) return;
    if (!invoiceNumberInput.trim()) {
      setConfirmError("El numero de factura es obligatorio.");
      return;
    }
    if (!invoiceDateInput) {
      setConfirmError("La fecha de factura es obligatoria.");
      return;
    }
    // Corte de recepcion de facturas: dia 25 de cada mes (confirmado con
    // Jonatan 2026-08-26). Se parsea como componentes locales, no
    // new Date(string), por el mismo motivo que formatDate arriba.
    const [, , dayStr] = invoiceDateInput.split("-");
    if (Number(dayStr) > 25) {
      setConfirmError(
        "El corte de recepcion de facturas es el dia 25 de cada mes. Debes subir esta factura con fecha del mes siguiente.",
      );
      return;
    }
    if (ncfRequired && !invoiceTaxNumberInput.trim()) {
      setConfirmError("El Comprobante Fiscal (NCF) es obligatorio para este proveedor.");
      return;
    }
    const totalAmount = Number(invoiceTotalInput);
    if (!invoiceTotalInput.trim() || !Number.isFinite(totalAmount) || totalAmount <= 0) {
      setConfirmError("El total de la factura debe ser un numero mayor a cero.");
      return;
    }
    setConfirmError(null);
    setBusy(true);
    try {
      await updateInvoiceData(invoice!.id, {
        invoiceNumber: invoiceNumberInput.trim(),
        invoiceDate: invoiceDateInput,
        invoiceTaxNumber: invoiceTaxNumberInput.trim(),
        totalAmount,
      });
      await confirmInvoiceForApproval(invoice!.id, session.userId);
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : "No fue posible confirmar la factura.");
    } finally {
      setBusy(false);
    }
  }
  async function handleDownload() {
    if (!invoice?.filePath) return;
    setDownloadError(null);
    setDownloading(true);
    try {
      const url = await downloadInvoiceFile(invoice.filePath);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : "No fue posible descargar el archivo.");
    } finally {
      setDownloading(false);
    }
  }
  async function handleSavePaymentDueDate() {
    setSavingPaymentDueDate(true);
    try {
      await setInvoicePaymentDueDate(invoice!.id, paymentDueDateInput || null);
    } finally {
      setSavingPaymentDueDate(false);
    }
  }
  async function handleMarkPaid() {
    if (!session.userId || !markPaidDateInput) return;
    setMarkPaidError(null);
    setMarkingPaid(true);
    try {
      await markInvoicePaid(invoice!.id, session.userId, markPaidDateInput, markPaidReferenceInput.trim() || null);
    } catch (err) {
      setMarkPaidError(err instanceof Error ? err.message : "No fue posible registrar el pago.");
    } finally {
      setMarkingPaid(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-slate-500">{t("invoices")}</p>
          <h1 className="text-2xl font-semibold text-slate-950">{invoice.invoiceNumber || invoice.id.slice(0, 8)}</h1>
        </div>
        <div className="flex items-center gap-2">
          {invoice.filePath && (
            <Button variant="ghost" onClick={handleDownload} disabled={downloading}>
              {downloading ? "..." : "Descargar PDF"}
            </Button>
          )}
          <Link to="/invoices">
            <Button variant="ghost">{t("backToOrders")}</Button>
          </Link>
        </div>
      </div>
      {downloadError && <p className="text-sm text-rose-600">{downloadError}</p>}

      {showUploadedBanner && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
          <p className="text-sm font-semibold text-emerald-800">Factura subida correctamente.</p>
          <button
            type="button"
            onClick={() => setShowUploadedBanner(false)}
            className="text-sm font-semibold text-emerald-700 hover:text-emerald-900"
          >
            Cerrar
          </button>
        </div>
      )}

      <Card className="p-5">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">{t("supplierName")}</p>
            <p className="mt-2 font-semibold text-slate-900">{supplier?.displayName ?? invoice.vendorName ?? "-"}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">{t("purchaseOrder")}</p>
            <p className="mt-2 font-semibold text-slate-900">{order?.orderNumber ?? t("unlinkedOrder")}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">{t("invoiceTaxNumber")}</p>
            <p className="mt-2 font-semibold text-slate-900">{invoice.invoiceTaxNumber || "-"}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">{t("invoiceDate")}</p>
            <p className="mt-2 font-semibold text-slate-900">{formatDate(invoice.invoiceDate)}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">{t("total")}</p>
            <p className="mt-2 font-semibold text-slate-900">{formatCurrency(invoice.total)}</p>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <StatusBadge status={invoice.status} />
          <PaymentStatusBadge invoice={invoice} />
          <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${validationTone}`}>
            {t("validationStatus")}: {validationLabel}
          </span>
        </div>
        {invoice.rejectionReason && invoice.status === "rejected" && (
          <p className="mt-3 text-sm text-rose-700">{invoice.rejectionReason}</p>
        )}
        {invoice.exportErrorReason && invoice.status === "export_error" && (
          <p className="mt-3 text-sm text-rose-700">{invoice.exportErrorReason}</p>
        )}
      </Card>

      {isApprover && invoice.status === "processed" && (
        <Card className="p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-slate-950">Pagos</h2>
            <PaymentStatusBadge invoice={invoice} />
          </div>
          <p className="mt-1 text-sm text-slate-500">
            Registro manual — Business Central no expone los movimientos de cuentas por pagar de este tenant, asi
            que el estado de pago no se sincroniza automaticamente.
          </p>

          <div className="mt-4">
            <label className="text-xs uppercase tracking-[0.18em] text-slate-500">Fecha posible de pago</label>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <Input
                type="date"
                value={paymentDueDateInput}
                onChange={(e) => setPaymentDueDateInput(e.target.value)}
                className="max-w-xs"
              />
              <Button onClick={handleSavePaymentDueDate} disabled={savingPaymentDueDate}>
                {savingPaymentDueDate ? "..." : t("save")}
              </Button>
            </div>
          </div>

          {invoice.paidAt ? (
            <div className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
              <p className="text-sm font-semibold text-emerald-800">Pagada el {formatDate(invoice.paidAt)}</p>
              {invoice.paymentReference && (
                <p className="mt-1 text-sm text-emerald-700">Referencia: {invoice.paymentReference}</p>
              )}
              <p className="mt-1 text-xs text-emerald-600">
                {invoice.paymentSource === "bc"
                  ? "Sincronizado automaticamente desde Business Central"
                  : "Registrado manualmente en el portal"}
              </p>
            </div>
          ) : (
            <div className="mt-5 border-t border-slate-100 pt-4">
              <label className="text-xs uppercase tracking-[0.18em] text-slate-500">Marcar como pagada</label>
              <div className="mt-1 flex flex-wrap items-center gap-3">
                <Input
                  type="date"
                  value={markPaidDateInput}
                  onChange={(e) => setMarkPaidDateInput(e.target.value)}
                  className="max-w-xs"
                />
                <Input
                  value={markPaidReferenceInput}
                  onChange={(e) => setMarkPaidReferenceInput(e.target.value)}
                  placeholder="Referencia (opcional)"
                  className="max-w-xs"
                />
                <Button onClick={handleMarkPaid} disabled={markingPaid || !markPaidDateInput}>
                  {markingPaid ? "..." : "Marcar como pagada"}
                </Button>
              </div>
              {markPaidError && <p className="mt-2 text-sm text-rose-700">{markPaidError}</p>}
            </div>
          )}
        </Card>
      )}

      {(canConfirm || canDecide) && (
        <Card className="p-5">
          <h2 className="text-lg font-semibold text-slate-950">{t("actions")}</h2>
          {canConfirm && (
            <div className="mt-4 space-y-3">
              <p className="text-sm text-slate-500">
                Completa estos datos antes de confirmar — son los que viajan a Business Central al exportar.
              </p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <label className="text-xs uppercase tracking-[0.18em] text-slate-500">{t("invoiceNumber")}</label>
                  <Input
                    value={invoiceNumberInput}
                    onChange={(e) => setInvoiceNumberInput(e.target.value)}
                    placeholder={t("invoiceNumber")}
                    className="mt-1"
                  />
                </div>
                <div>
                  <label className="text-xs uppercase tracking-[0.18em] text-slate-500">{t("invoiceDate")}</label>
                  <Input
                    type="date"
                    value={invoiceDateInput}
                    onChange={(e) => setInvoiceDateInput(e.target.value)}
                    className="mt-1"
                  />
                </div>
                <div>
                  <label className="text-xs uppercase tracking-[0.18em] text-slate-500">
                    {t("invoiceTaxNumber")} (NCF){!ncfRequired && " — opcional"}
                  </label>
                  <Input
                    value={invoiceTaxNumberInput}
                    onChange={(e) => setInvoiceTaxNumberInput(e.target.value)}
                    placeholder="E31..."
                    className="mt-1"
                  />
                  {!ncfRequired && (
                    <p className="mt-1 text-xs text-slate-500">Proveedor informal/extranjero: no requiere NCF.</p>
                  )}
                </div>
                <div>
                  <label className="text-xs uppercase tracking-[0.18em] text-slate-500">{t("invoiceTotalLabel")}</label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={invoiceTotalInput}
                    onChange={(e) => setInvoiceTotalInput(e.target.value)}
                    placeholder="0.00"
                    className="mt-1"
                  />
                  {order && (
                    <p className="mt-1 text-xs text-slate-500">
                      {t("purchaseOrder")}: {formatCurrency(order.amount)}
                      {otherInvoicesOnOrderTotal > 0 && (
                        <>
                          {" "}
                          · Ya facturado: {formatCurrency(otherInvoicesOnOrderTotal)} · Disponible:{" "}
                          {formatCurrency(order.amount - otherInvoicesOnOrderTotal)}
                        </>
                      )}
                    </p>
                  )}
                </div>
              </div>
              {confirmError && <p className="text-sm text-rose-700">{confirmError}</p>}
            </div>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {canConfirm && (
              <Button onClick={handleConfirm} disabled={busy}>
                {t("confirmData")}
              </Button>
            )}
            {canDecide && (
              <>
                <Button onClick={handleApprove} disabled={busy}>
                  Aprobar
                </Button>
                <Input
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder={t("reason")}
                  className="max-w-xs"
                />
                <Button variant="danger" onClick={handleReject} disabled={busy || !rejectReason.trim()}>
                  Rechazar
                </Button>
              </>
            )}
          </div>
        </Card>
      )}

      <Card id="lines" className="overflow-hidden p-0">
        <div className="border-b border-slate-100 px-5 py-5">
          <h2 className="text-lg font-semibold text-slate-950">{t("invoicesLinkedToOrder")}</h2>
        </div>
        {lines.length === 0 ? (
          <div className="p-5 text-sm text-slate-500">{t("noOrderLines")}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left">
              <thead className="bg-slate-50/90 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                <tr>
                  <th className="px-5 py-4">{t("description")}</th>
                  <th className="px-5 py-4">{t("quantity")}</th>
                  <th className="px-5 py-4">{t("unitPrice")}</th>
                  <th className="px-5 py-4">{t("lineAmount")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {lines.map((line) => (
                  <tr key={line.id}>
                    <td className="px-5 py-4 text-sm text-slate-900">{line.description ?? "-"}</td>
                    <td className="px-5 py-4 text-sm text-slate-600">{line.quantity ?? "-"}</td>
                    <td className="px-5 py-4 text-sm text-slate-600">{line.price != null ? formatCurrency(line.price) : "-"}</td>
                    <td className="px-5 py-4 text-sm font-semibold text-slate-900">
                      {line.amount != null ? formatCurrency(line.amount) : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
