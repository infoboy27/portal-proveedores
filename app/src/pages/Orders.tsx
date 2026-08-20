import { useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "@/i18n";
import { useSessionStore } from "@/store/session";
import { useDomainStore } from "@/store/domain";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import type { PurchaseOrderConfirmationStatus, PurchaseOrderStatus } from "@/store/types";

const formatCurrency = (value: number) =>
  new Intl.NumberFormat("es-DO", { style: "currency", currency: "DOP" }).format(value);
const formatDate = (value: string | null) => (value ? new Date(value).toLocaleDateString("es-DO") : "-");

const STATUS_LABEL: Record<PurchaseOrderStatus, string> = {
  draft: "Borrador",
  open: "Abierta",
  in_review: "En revision",
  partially_invoiced: "Parcialmente facturada",
  closed: "Cerrada",
};
const STATUS_TONE: Record<PurchaseOrderStatus, string> = {
  draft: "bg-slate-100 text-slate-700",
  open: "bg-emerald-100 text-emerald-700",
  in_review: "bg-amber-100 text-amber-700",
  partially_invoiced: "bg-sky-100 text-sky-700",
  closed: "bg-slate-200 text-slate-700",
};

const CONFIRMATION_TONE: Record<PurchaseOrderConfirmationStatus, string> = {
  pending: "bg-slate-100 text-slate-700",
  confirmed: "bg-emerald-100 text-emerald-700",
  change_requested: "bg-amber-100 text-amber-700",
};

// Reconstruccion de `function RP()` — index-beautified.js:29350.
export function OrdersList() {
  const { t } = useTranslation();
  const session = useSessionStore((s) => s.session);
  const purchaseOrders = useDomainStore((s) => s.purchaseOrders);
  const suppliers = useDomainStore((s) => s.suppliers);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<PurchaseOrderStatus | "all">("all");

  const isAdmin = session.role === "admin" || session.role === "superadmin";
  const isSupplier = session.role === "supplier";
  const scopeCompanyId = session.activeCompany?.isGlobal ? null : session.activeCompany?.companyId ?? session.companyId;

  const scoped = useMemo(
    () =>
      purchaseOrders.filter((po) => {
        if (isAdmin) return scopeCompanyId ? po.companyId === scopeCompanyId : true;
        if (isSupplier) return !!session.supplierId && po.vendorId === session.supplierId;
        return po.companyId === session.companyId;
      }),
    [purchaseOrders, isAdmin, isSupplier, scopeCompanyId, session.companyId, session.supplierId],
  );

  const suppliersById = useMemo(() => new Map(suppliers.map((s) => [s.id, s])), [suppliers]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return scoped.filter((po) => {
      const supplier = suppliersById.get(po.vendorId);
      const matchesQuery =
        query.length === 0 ||
        po.orderNumber.toLowerCase().includes(query) ||
        po.description.toLowerCase().includes(query) ||
        supplier?.displayName.toLowerCase().includes(query);
      const matchesStatus = statusFilter === "all" || po.status === statusFilter;
      return matchesQuery && matchesStatus;
    });
  }, [scoped, search, statusFilter, suppliersById]);

  const stats = useMemo(
    () => ({
      active: scoped.filter((po) => po.status !== "closed").length,
      drafts: scoped.filter((po) => po.status === "draft").length,
      pending: scoped.filter((po) => po.status === "in_review").length,
      totalValue: scoped.reduce((sum, po) => sum + po.amount, 0),
    }),
    [scoped],
  );

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">{t("purchaseOrdersTitle")}</h1>
          <p className="max-w-2xl text-sm leading-6 text-slate-600 sm:text-base">{t("purchaseOrdersDescription")}</p>
        </div>
      </section>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: t("totalActive"), value: stats.active.toLocaleString() },
          { label: t("drafts"), value: stats.drafts.toLocaleString() },
          { label: t("pendingApprovalShort"), value: stats.pending.toLocaleString() },
          { label: t("totalValue"), value: formatCurrency(stats.totalValue) },
        ].map((stat) => (
          <Card key={stat.label} className="p-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">{stat.label}</p>
            <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">{stat.value}</p>
          </Card>
        ))}
      </div>

      <Card className="p-4 sm:p-5">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("searchOrdersPlaceholder")}
            className="flex-1"
          />
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as PurchaseOrderStatus | "all")}
            className="xl:w-[260px]"
          >
            <option value="all">{t("allOrderStatuses")}</option>
            {(Object.keys(STATUS_LABEL) as PurchaseOrderStatus[]).map((status) => (
              <option key={status} value={status}>
                {STATUS_LABEL[status]}
              </option>
            ))}
          </Select>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left">
            <thead className="bg-slate-50/90 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              <tr>
                <th className="px-6 py-4">{t("poNumber")}</th>
                <th className="px-6 py-4">{t("supplier")}</th>
                <th className="px-6 py-4">{t("orderDate")}</th>
                <th className="px-6 py-4">{t("amount")}</th>
                <th className="px-6 py-4">{t("status")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.length > 0 ? (
                filtered.map((po) => {
                  const supplier = suppliersById.get(po.vendorId);
                  return (
                    <tr key={po.id} className="transition hover:bg-slate-50/80">
                      <td className="px-6 py-4">
                        <Link to={`/orders/${po.id}`} className="font-semibold text-cyan-700 hover:text-cyan-800">
                          {po.orderNumber}
                        </Link>
                      </td>
                      <td className="px-6 py-4">
                        <p className="font-medium text-slate-950">{supplier?.displayName ?? "-"}</p>
                        <p className="text-xs text-slate-500">{supplier?.vendorNumber}</p>
                      </td>
                      <td className="px-6 py-4 text-sm text-slate-600">{formatDate(po.orderDate)}</td>
                      <td className="px-6 py-4 font-semibold text-slate-950">{formatCurrency(po.amount)}</td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${STATUS_TONE[po.status]}`}>
                          {STATUS_LABEL[po.status]}
                        </span>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={5} className="px-6 py-14 text-center text-sm text-slate-500">
                    <p className="font-semibold text-slate-700">{t("noPurchaseOrdersFound")}</p>
                    <p className="mt-1">{t("noPurchaseOrdersFoundDescription")}</p>
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

// Reconstruccion de `function PP()` — index-beautified.js:28589.
// Simplificado respecto al original: se omite el modal de "factura
// duplicada detectada" y el formulario de confirmacion de datos OCR
// (ver bundle original ~28642-28713) — la carga aqui va directa a
// `uploadInvoice`.
export function OrderDetail() {
  const { t } = useTranslation();
  const { orderId = "" } = useParams();
  const session = useSessionStore((s) => s.session);
  const purchaseOrders = useDomainStore((s) => s.purchaseOrders);
  const suppliers = useDomainStore((s) => s.suppliers);
  const purchaseOrderLines = useDomainStore((s) => s.purchaseOrderLines);
  const invoices = useDomainStore((s) => s.invoices);
  const uploadInvoice = useDomainStore((s) => s.uploadInvoice);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const order = purchaseOrders.find((po) => po.id === orderId);
  const supplier = suppliers.find((s) => s.id === order?.vendorId);
  const lines = useMemo(
    () => purchaseOrderLines.filter((l) => l.orderId === orderId).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)),
    [purchaseOrderLines, orderId],
  );
  const linkedInvoices = useMemo(() => invoices.filter((inv) => inv.purchaseOrderId === orderId), [invoices, orderId]);
  const confirmPurchaseOrder = useDomainStore((s) => s.confirmPurchaseOrder);

  const canUpload =
    session.role === "admin" ||
    session.role === "superadmin" ||
    session.role === "supplier" ||
    session.role === "service_uploader";
  // Mismos roles que pueden cargar factura: el proveedor (o quien carga en
  // su nombre) es quien confirma la orden o pide un cambio.
  const canConfirmOrder = canUpload;

  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [showChangeForm, setShowChangeForm] = useState(false);
  const [changeReason, setChangeReason] = useState("");
  const [newExpectedDate, setNewExpectedDate] = useState("");

  async function handleConfirmOrder() {
    if (!order || !session.userId) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      await confirmPurchaseOrder(order.id, session.userId, "confirmed");
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : t("unableToConfirmPurchaseOrder"));
    } finally {
      setConfirming(false);
    }
  }

  async function handleRequestChange() {
    if (!order || !session.userId || !changeReason.trim()) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      await confirmPurchaseOrder(order.id, session.userId, "change_requested", {
        reason: changeReason.trim(),
        newExpectedDate: newExpectedDate || null,
      });
      setShowChangeForm(false);
      setChangeReason("");
      setNewExpectedDate("");
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : t("unableToConfirmPurchaseOrder"));
    } finally {
      setConfirming(false);
    }
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    if (!file || !order || !session.userId) return;
    setUploading(true);
    setUploadError(null);
    try {
      await uploadInvoice({
        companyId: order.companyId,
        purchaseOrderId: order.id,
        vendorId: order.vendorId,
        invoiceNumber: "",
        vendorName: supplier?.displayName ?? "",
        vendorTaxId: supplier?.taxRegistrationNumber ?? "",
        file,
        uploadedByUserId: session.userId,
      });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : t("pdfUploadError"));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  if (!order || !supplier) {
    return (
      <Card className="p-10 text-center">
        <p className="font-semibold text-slate-800">{t("orderNotFound")}</p>
        <p className="mt-1 text-sm text-slate-500">{t("orderNotFoundDescription")}</p>
        <Link to="/orders" className="mt-4 inline-block">
          <Button variant="ghost">{t("backToOrders")}</Button>
        </Link>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.22em] text-slate-500">{order.orderNumber}</p>
          <h1 className="text-2xl font-semibold text-slate-950">{order.description || order.orderNumber}</h1>
        </div>
        <Link to="/orders">
          <Button variant="ghost">{t("backToOrders")}</Button>
        </Link>
      </div>

      <Card className="p-5">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">{t("supplier")}</p>
            <p className="mt-2 font-semibold text-slate-900">{supplier.displayName}</p>
            <p className="text-sm text-slate-500">{supplier.vendorNumber}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">{t("orderDate")}</p>
            <p className="mt-2 font-semibold text-slate-900">{formatDate(order.orderDate)}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">{t("total")}</p>
            <p className="mt-2 font-semibold text-slate-900">{formatCurrency(order.amount)}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">{t("status")}</p>
            <span className={`mt-2 inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${STATUS_TONE[order.status]}`}>
              {STATUS_LABEL[order.status]}
            </span>
          </div>
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">{t("confirmationSectionTitle")}</h2>
            <p className="mt-1 text-sm text-slate-600">{t("confirmationSectionDescription")}</p>
            <span
              className={`mt-3 inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${CONFIRMATION_TONE[order.confirmationStatus]}`}
            >
              {t(
                order.confirmationStatus === "confirmed"
                  ? "confirmationConfirmed"
                  : order.confirmationStatus === "change_requested"
                    ? "confirmationChangeRequested"
                    : "confirmationPending",
              )}
            </span>
            {confirmError && <p className="mt-2 text-sm text-rose-700">{confirmError}</p>}
          </div>
          {canConfirmOrder && (
            <div className="flex flex-col gap-2 sm:items-end">
              <div className="flex gap-2">
                <Button onClick={handleConfirmOrder} disabled={confirming}>
                  {confirming ? t("confirmingOrder") : t("confirmOrderAction")}
                </Button>
                <Button variant="ghost" onClick={() => setShowChangeForm((v) => !v)} disabled={confirming}>
                  {t("requestChangeAction")}
                </Button>
              </div>
              {showChangeForm && (
                <div className="w-full max-w-sm space-y-2 rounded-lg border border-slate-200 p-3 sm:w-80">
                  <Input
                    type="date"
                    value={newExpectedDate}
                    onChange={(e) => setNewExpectedDate(e.target.value)}
                    placeholder={t("newExpectedDateLabel")}
                  />
                  <Input
                    value={changeReason}
                    onChange={(e) => setChangeReason(e.target.value)}
                    placeholder={t("changeRequestReasonPlaceholder")}
                  />
                  <Button onClick={handleRequestChange} disabled={confirming || !changeReason.trim()} className="w-full">
                    {confirming ? t("confirmingOrder") : t("requestChangeAction")}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      {canUpload && (
        <Card className="p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-950">{t("uploadInvoice")}</h2>
              <p className="mt-1 text-sm text-slate-600">{t("uploadInvoiceDescription")}</p>
              {uploadError && <p className="mt-2 text-sm text-rose-700">{uploadError}</p>}
            </div>
            <Button onClick={() => fileInputRef.current?.click()} disabled={uploading}>
              {uploading ? "..." : t("uploadInvoice")}
            </Button>
            <input ref={fileInputRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={handleFile} />
          </div>
        </Card>
      )}

      <Card className="overflow-hidden p-0">
        <div className="border-b border-slate-100 px-5 py-5">
          <h2 className="text-lg font-semibold text-slate-950">{t("orderLinesTitle")}</h2>
          <p className="mt-1 text-sm text-slate-600">{t("orderLinesDescription")}</p>
        </div>
        {lines.length === 0 ? (
          <div className="p-5">
            <p className="font-semibold text-slate-800">{t("noOrderLines")}</p>
            <p className="mt-1 text-sm text-slate-500">{t("noOrderLinesDescription")}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left">
              <thead className="bg-slate-50/90 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                <tr>
                  <th className="px-5 py-4">{t("line")}</th>
                  <th className="px-5 py-4">{t("description")}</th>
                  <th className="px-5 py-4">{t("quantity")}</th>
                  <th className="px-5 py-4">{t("unitPrice")}</th>
                  <th className="px-5 py-4">{t("lineAmount")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {lines.map((line, idx) => (
                  <tr key={line.id}>
                    <td className="px-5 py-4 text-sm text-slate-600">{idx + 1}</td>
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

      <Card className="overflow-hidden p-0">
        <div className="border-b border-slate-100 px-5 py-5">
          <h2 className="text-lg font-semibold text-slate-950">{t("invoicesLinkedToOrder")}</h2>
        </div>
        {linkedInvoices.length === 0 ? (
          <div className="p-5">
            <p className="font-semibold text-slate-800">{t("noInvoicesYet")}</p>
            <p className="mt-1 text-sm text-slate-500">{t("noInvoicesYetDescription")}</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {linkedInvoices.map((inv) => (
              <Link
                key={inv.id}
                to={`/invoices/${inv.id}`}
                className="flex items-center justify-between px-5 py-4 hover:bg-slate-50/80"
              >
                <span className="font-semibold text-cyan-700">{inv.invoiceNumber || inv.id.slice(0, 8)}</span>
                <span className="text-sm text-slate-600">{formatCurrency(inv.total)}</span>
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
