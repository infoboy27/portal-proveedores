import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "@/i18n";
import { useSessionStore } from "@/store/session";
import { useDomainStore } from "@/store/domain";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import type { PurchaseOrder, PurchaseOrderConfirmationStatus, PurchaseOrderStatus } from "@/store/types";

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

const formatBytes = (bytes: number) => {
  // BC no calcula byteSize en el listado de "Documentos adjuntos"
  // (documentAttachments siempre devuelve 0) -- mostrar "0 KB" seria decir
  // que el archivo esta vacio, que es justo la confusion que queremos evitar
  // despues del bug de adjuntos de 2026-09-04. Tamaño desconocido = "-".
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

const CONFIRMATION_TONE: Record<PurchaseOrderConfirmationStatus, string> = {
  pending: "bg-slate-100 text-slate-700",
  confirmed: "bg-emerald-100 text-emerald-700",
  change_requested: "bg-amber-100 text-amber-700",
};

const PAGE_SIZE = 20;

// Reconstruccion de `function RP()` — index-beautified.js:29350.
//
// Key Players (2026-09-01, item 6): filtros del lado servidor. Antes esta
// pantalla dependia del store global (fetchAll -> TODAS las ordenes) y
// filtraba en memoria -- funcionaba con 21 ordenes, pero no escala, y el
// pedido explicito es no depender de traer todo al frontend. Ahora pagina
// y filtra en la base (fetchPurchaseOrdersPage), con debounce en la
// busqueda para no disparar una consulta por cada tecla.
//
// El aislamiento de proveedor sigue siendo RLS puro ("scoped read",
// schema-v3.sql) -- no se arma ningun filtro de vendor_id a mano para
// supplier/service_uploader, la base ya se encarga sin importar la forma
// de la query. El selector de proveedor solo aparece para quien puede ver
// mas de uno (admin/superadmin/approver).
export function OrdersList() {
  const { t } = useTranslation();
  const session = useSessionStore((s) => s.session);
  const suppliers = useDomainStore((s) => s.suppliers);
  const companies = useDomainStore((s) => s.companies);
  const fetchPurchaseOrdersPage = useDomainStore((s) => s.fetchPurchaseOrdersPage);
  const fetchPurchaseOrderStats = useDomainStore((s) => s.fetchPurchaseOrderStats);

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<PurchaseOrderStatus | "all">("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [vendorFilter, setVendorFilter] = useState("");
  const [page, setPage] = useState(0);

  const [rows, setRows] = useState<PurchaseOrder[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const isAdmin = session.role === "admin" || session.role === "superadmin";
  const isApprover = session.role === "approver";
  const canFilterByVendor = isAdmin || isApprover;
  const scopeCompanyId = session.activeCompany?.isGlobal ? null : session.activeCompany?.companyId ?? session.companyId;
  // Multiempresa (Fase 6, 2026-08-29): con "Todas las empresas" seleccionado,
  // las filas de distintas empresas quedan mezcladas -- se agrega la columna
  // solo en ese caso, para no ensuciar la tabla cuando ya esta acotada a una.
  const showCompanyColumn = isAdmin && !scopeCompanyId;
  const companiesById = useMemo(() => new Map(companies.map((c) => [c.id, c])), [companies]);
  const suppliersById = useMemo(() => new Map(suppliers.map((s) => [s.id, s])), [suppliers]);
  // Lista para el selector de proveedor -- ordenada por nombre, solo tiene
  // sentido para quien puede filtrar por mas de uno.
  const supplierOptions = useMemo(
    () => (canFilterByVendor ? [...suppliers].sort((a, b) => a.displayName.localeCompare(b.displayName)) : []),
    [suppliers, canFilterByVendor],
  );

  // Debounce de 350ms sobre la busqueda por numero de orden -- evita una
  // consulta por cada tecla.
  useEffect(() => {
    const id = setTimeout(() => {
      setSearch(searchInput);
      setPage(0);
    }, 350);
    return () => clearTimeout(id);
  }, [searchInput]);

  useEffect(() => {
    setPage(0);
  }, [statusFilter, dateFrom, dateTo, vendorFilter, scopeCompanyId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    fetchPurchaseOrdersPage({
      page,
      pageSize: PAGE_SIZE,
      orderNumber: search,
      status: statusFilter,
      dateFrom: dateFrom || null,
      dateTo: dateTo || null,
      vendorId: canFilterByVendor && vendorFilter ? vendorFilter : null,
      companyId: scopeCompanyId,
    })
      .then(({ rows, totalCount }) => {
        if (cancelled) return;
        setRows(rows);
        setTotalCount(totalCount);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "No se pudieron cargar las ordenes de compra.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchPurchaseOrdersPage, page, search, statusFilter, dateFrom, dateTo, vendorFilter, canFilterByVendor, scopeCompanyId]);

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const [stats, setStats] = useState({ active: 0, drafts: 0, pending: 0, totalValue: 0 });
  useEffect(() => {
    let cancelled = false;
    fetchPurchaseOrderStats(scopeCompanyId).then((s) => {
      if (!cancelled) setStats(s);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchPurchaseOrderStats, scopeCompanyId]);

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
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:flex-wrap">
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t("searchOrdersPlaceholder")}
            className="flex-1 xl:min-w-[220px]"
          />
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as PurchaseOrderStatus | "all")}
            className="xl:w-[220px]"
          >
            <option value="all">{t("allOrderStatuses")}</option>
            {(Object.keys(STATUS_LABEL) as PurchaseOrderStatus[]).map((status) => (
              <option key={status} value={status}>
                {STATUS_LABEL[status]}
              </option>
            ))}
          </Select>
          <div className="flex items-center gap-2">
            <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="xl:w-[160px]" />
            <span className="text-sm text-slate-400">a</span>
            <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="xl:w-[160px]" />
          </div>
          {canFilterByVendor && (
            <Select value={vendorFilter} onChange={(e) => setVendorFilter(e.target.value)} className="xl:w-[240px]">
              <option value="">{t("supplier")}: todos</option>
              {supplierOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.displayName}
                </option>
              ))}
            </Select>
          )}
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left">
            <thead className="bg-slate-50/90 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              <tr>
                <th className="px-6 py-4">{t("poNumber")}</th>
                {showCompanyColumn && <th className="px-6 py-4">Empresa</th>}
                <th className="px-6 py-4">{t("supplier")}</th>
                <th className="px-6 py-4">{t("orderDate")}</th>
                <th className="px-6 py-4">{t("amount")}</th>
                <th className="px-6 py-4">{t("status")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={showCompanyColumn ? 6 : 5} className="px-6 py-14 text-center text-sm text-slate-500">
                    Cargando ordenes...
                  </td>
                </tr>
              ) : loadError ? (
                <tr>
                  <td colSpan={showCompanyColumn ? 6 : 5} className="px-6 py-14 text-center text-sm text-rose-600">
                    {loadError}
                  </td>
                </tr>
              ) : rows.length > 0 ? (
                rows.map((po) => {
                  const supplier = suppliersById.get(po.vendorId);
                  return (
                    <tr key={po.id} className="transition hover:bg-slate-50/80">
                      <td className="px-6 py-4">
                        <Link to={`/orders/${po.id}`} className="font-semibold text-cyan-700 hover:text-cyan-800">
                          {po.orderNumber}
                        </Link>
                      </td>
                      {showCompanyColumn && (
                        <td className="px-6 py-4 text-sm text-slate-600">{companiesById.get(po.companyId)?.name ?? "-"}</td>
                      )}
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
                  <td colSpan={showCompanyColumn ? 6 : 5} className="px-6 py-14 text-center text-sm text-slate-500">
                    <p className="font-semibold text-slate-700">{t("noPurchaseOrdersFound")}</p>
                    <p className="mt-1">{t("noPurchaseOrdersFoundDescription")}</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {totalCount > 0 && (
          <div className="flex items-center justify-between border-t border-slate-100 px-6 py-4 text-sm text-slate-600">
            <p>
              {totalCount.toLocaleString()} orden{totalCount === 1 ? "" : "es"} · página {page + 1} de {totalPages}
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0 || loading}>
                Anterior
              </Button>
              <Button
                variant="ghost"
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1 || loading}
              >
                Siguiente
              </Button>
            </div>
          </div>
        )}
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
  const purchaseOrderReceipts = useDomainStore((s) => s.purchaseOrderReceipts);
  const invoices = useDomainStore((s) => s.invoices);
  const uploadInvoice = useDomainStore((s) => s.uploadInvoice);
  const fetchOrderAttachments = useDomainStore((s) => s.fetchOrderAttachments);
  const downloadOrderAttachment = useDomainStore((s) => s.downloadOrderAttachment);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const order = purchaseOrders.find((po) => po.id === orderId);
  const supplier = suppliers.find((s) => s.id === order?.vendorId);
  const lines = useMemo(
    () => purchaseOrderLines.filter((l) => l.orderId === orderId).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)),
    [purchaseOrderLines, orderId],
  );
  const receipts = useMemo(
    () => purchaseOrderReceipts.filter((r) => r.orderId === orderId),
    [purchaseOrderReceipts, orderId],
  );
  const linkedInvoices = useMemo(() => invoices.filter((inv) => inv.purchaseOrderId === orderId), [invoices, orderId]);
  // Ordenes con varias facturas (2026-09-03, pedido real: ordenes con
  // varias lineas que reciben una factura por linea, o repartidas en el
  // tiempo por ser un contrato) -- ya no es "1 Orden de Compra = 1
  // Factura" a secas (esa regla original de Key Players, 2026-09-01, item
  // 1, quedo reemplazada). La garantia real es el trigger de la base
  // (check_one_active_invoice_per_po, schema-v33.sql), esto solo controla
  // si se ofrece el boton de carga: admite una factura nueva mientras
  // quede saldo sin facturar contra order.amount.
  const invoicedTotal = useMemo(
    () => linkedInvoices.filter((inv) => inv.status !== "rejected").reduce((sum, inv) => sum + inv.total, 0),
    [linkedInvoices],
  );
  const remainingBalance = order ? order.amount - invoicedTotal : 0;
  // order.amount null/0 (dato incompleto de BC) no bloquea -- mismo
  // criterio conservador que el trigger de la base.
  const isFullyInvoiced = useMemo(
    () => !!order && order.amount > 0 && remainingBalance <= 0,
    [order, remainingBalance],
  );

  // Pedido de Jonatan (2026-09-02, "Cambios solicitados por Key Players",
  // item 6): no se puede cargar factura contra una orden que el proveedor
  // todavia no confirmo, ni mientras tenga un cambio solicitado sin
  // resolver. admin/superadmin quedan exentos (correccion de errores real
  // de operacion, mismo criterio que el resto de este archivo). La
  // garantia real es el trigger check_po_confirmed_for_invoice
  // (schema-v27.sql) -- esto es solo para el mensaje claro antes de subir.
  const isAdminRole = session.role === "admin" || session.role === "superadmin";
  const uploadBlockedReason =
    isAdminRole || !order || order.confirmationStatus === "confirmed"
      ? null
      : order.confirmationStatus === "change_requested"
        ? "No puede cargar una factura mientras exista una solicitud de cambio pendiente para esta orden."
        : "No puede cargar una factura porque esta orden de compra todavia no ha sido confirmada.";
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

  // Adjuntos de la orden en BC (Key Players, 2026-09-01, item 5) -- no vive
  // en el store global de dominio a proposito (ver comentario en
  // domain.ts:fetchOrderAttachments), se pide en vivo cada vez que se abre
  // el detalle de esta orden puntual.
  const [attachments, setAttachments] = useState<
    { id: string; fileName: string; byteSize: number; lastModifiedDateTime: string; source?: "document" | "incoming" }[] | null
  >(null);
  const [attachmentsError, setAttachmentsError] = useState<string | null>(null);
  const [loadingAttachments, setLoadingAttachments] = useState(false);
  const [downloadingAttachmentId, setDownloadingAttachmentId] = useState<string | null>(null);

  useEffect(() => {
    if (!orderId) return;
    let cancelled = false;
    setLoadingAttachments(true);
    setAttachmentsError(null);
    fetchOrderAttachments(orderId)
      .then((rows) => {
        if (!cancelled) setAttachments(rows);
      })
      .catch((err) => {
        if (!cancelled) setAttachmentsError(err instanceof Error ? err.message : "No se pudieron cargar los adjuntos.");
      })
      .finally(() => {
        if (!cancelled) setLoadingAttachments(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orderId, fetchOrderAttachments]);

  async function handleOpenAttachment(attachmentId: string, fileName: string, mode: "view" | "download") {
    setDownloadingAttachmentId(attachmentId);
    try {
      await downloadOrderAttachment(orderId, attachmentId, fileName, mode);
    } catch (err) {
      setAttachmentsError(err instanceof Error ? err.message : "No se pudo abrir el adjunto.");
    } finally {
      setDownloadingAttachmentId(null);
    }
  }

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
                {/* 2026-09-02 (Key Players): una vez confirmada, "Confirmar
                    orden" se deshabilita -- no tiene sentido volver a
                    confirmar y generaba entradas duplicadas en el historial.
                    Mismo criterio mientras hay un cambio solicitado pendiente
                    de revisar -- el proveedor ya actuo, no debe poder volver
                    a confirmar hasta que el estado cambie. */}
                <Button
                  onClick={handleConfirmOrder}
                  disabled={confirming || order.confirmationStatus === "confirmed" || order.confirmationStatus === "change_requested"}
                >
                  {confirming ? t("confirmingOrder") : t("confirmOrderAction")}
                </Button>
                {/* Mismo pedido: una vez la orden esta confirmada, o mientras
                    hay un cambio solicitado sin resolver, ya no se puede
                    volver a solicitar otro -- se oculta el boton. */}
                {order.confirmationStatus === "pending" && (
                  <Button variant="ghost" onClick={() => setShowChangeForm((v) => !v)} disabled={confirming}>
                    {t("requestChangeAction")}
                  </Button>
                )}
              </div>
              {showChangeForm && order.confirmationStatus === "pending" && (
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
              <p className="mt-1 text-sm text-slate-600">
                {uploadBlockedReason
                  ? uploadBlockedReason
                  : isFullyInvoiced
                    ? "Esta orden de compra ya tiene facturado el total de su monto. Elimine o espere a que se resuelva una factura existente para poder cargar otra."
                    : t("uploadInvoiceDescription")}
              </p>
              {uploadError && <p className="mt-2 text-sm text-rose-700">{uploadError}</p>}
            </div>
            <Button onClick={() => fileInputRef.current?.click()} disabled={uploading || isFullyInvoiced || !!uploadBlockedReason}>
              {uploading ? "..." : t("uploadInvoice")}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,.pdf,image/jpeg,.jpg,.jpeg,image/png,.png"
              className="hidden"
              onChange={handleFile}
            />
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
          <h2 className="text-lg font-semibold text-slate-950">Recepciones</h2>
          <p className="mt-1 text-sm text-slate-600">
            Recepciones de mercancia/servicio registradas en Business Central contra esta orden.
          </p>
        </div>
        {receipts.length === 0 ? (
          <div className="p-5">
            <p className="font-semibold text-slate-800">Sin recepciones todavia</p>
            <p className="mt-1 text-sm text-slate-500">Esta orden no tiene recepciones sincronizadas desde BC.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left">
              <thead className="bg-slate-50/90 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                <tr>
                  <th className="px-5 py-4">Numero</th>
                  <th className="px-5 py-4">Fecha</th>
                  <th className="px-5 py-4">Envio del proveedor</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {receipts.map((r) => (
                  <tr key={r.id}>
                    <td className="px-5 py-4 text-sm font-semibold text-slate-900">{r.receiptNumber}</td>
                    <td className="px-5 py-4 text-sm text-slate-600">{formatDate(r.postingDate)}</td>
                    <td className="px-5 py-4 text-sm text-slate-600">{r.vendorShipmentNo || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="border-b border-slate-100 px-5 py-5">
          <h2 className="text-lg font-semibold text-slate-950">Datos adjuntos</h2>
          <p className="mt-1 text-sm text-slate-600">
            Documentos adjuntos a esta orden en Business Central (Pedido → Datos adjuntos).
          </p>
        </div>
        {loadingAttachments ? (
          <div className="p-5 text-sm text-slate-500">Cargando adjuntos...</div>
        ) : attachmentsError ? (
          <div className="p-5 text-sm text-rose-700">{attachmentsError}</div>
        ) : !attachments || attachments.length === 0 ? (
          <div className="p-5">
            <p className="font-semibold text-slate-800">Sin adjuntos todavia</p>
            <p className="mt-1 text-sm text-slate-500">Esta orden no tiene documentos adjuntos en Business Central.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left">
              <thead className="bg-slate-50/90 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                <tr>
                  <th className="px-5 py-4">Archivo</th>
                  <th className="px-5 py-4">Tipo</th>
                  <th className="px-5 py-4">Tamaño</th>
                  <th className="px-5 py-4"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {attachments.map((att) => {
                  const ext = att.fileName.includes(".") ? att.fileName.split(".").pop()!.toUpperCase() : "-";
                  return (
                    <tr key={att.id}>
                      <td className="px-5 py-4 text-sm font-medium text-slate-900">{att.fileName}</td>
                      <td className="px-5 py-4 text-sm text-slate-600">{ext}</td>
                      <td className="px-5 py-4 text-sm text-slate-600">{formatBytes(att.byteSize)}</td>
                      <td className="px-5 py-4 text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="ghost"
                            onClick={() => handleOpenAttachment(att.id, att.fileName, "view")}
                            disabled={downloadingAttachmentId === att.id}
                          >
                            Ver
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => handleOpenAttachment(att.id, att.fileName, "download")}
                            disabled={downloadingAttachmentId === att.id}
                          >
                            {downloadingAttachmentId === att.id ? "..." : "Descargar"}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="border-b border-slate-100 px-5 py-5">
          <h2 className="text-lg font-semibold text-slate-950">{t("invoicesLinkedToOrder")}</h2>
          {linkedInvoices.length > 0 && (
            <p className="mt-1 text-sm text-slate-600">
              Facturado: {formatCurrency(invoicedTotal)} de {formatCurrency(order.amount)} · Disponible:{" "}
              {formatCurrency(remainingBalance)}
            </p>
          )}
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
