import { useMemo, useState } from "react";
import { useTranslation } from "@/i18n";
import { useSessionStore } from "@/store/session";
import { useDomainStore } from "@/store/domain";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/StatusBadge";

// Reconstruccion de `function YI()` (modulo de Aprobaciones) del bundle original.
// Regla de negocio confirmada: "alto valor" = total >= 10,000.
// Scope: admin/superadmin ven todo (o la empresa activa); approver ve su empresa,
// o todas si tiene una compania marcada isGlobal y no hay companyId fijo.
const HIGH_VALUE_THRESHOLD = 10_000;

const formatCurrency = (value: number) =>
  new Intl.NumberFormat("es-DO", { style: "currency", currency: "DOP" }).format(value);

export function Approvals() {
  const { t } = useTranslation();
  const session = useSessionStore((s) => s.session);
  const invoices = useDomainStore((s) => s.invoices);
  const purchaseOrders = useDomainStore((s) => s.purchaseOrders);
  const suppliers = useDomainStore((s) => s.suppliers);
  const approveInvoice = useDomainStore((s) => s.approveInvoice);
  const rejectInvoice = useDomainStore((s) => s.rejectInvoice);

  const [search, setSearch] = useState("");
  const [valueFilter, setValueFilter] = useState<"all" | "high">("all");
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const isAdmin = session.role === "admin" || session.role === "superadmin";
  const scopeCompanyId = session.activeCompany?.isGlobal ? null : session.activeCompany?.companyId ?? session.companyId;
  const isGlobalApprover = isAdmin || (session.role === "approver" && !!session.availableCompanies.some((c) => c.isGlobal));
  const allCompanies = isGlobalApprover && !scopeCompanyId;

  const pendingInvoices = useMemo(
    () =>
      invoices.filter(
        (inv) => inv.status === "pending_approval" && (isGlobalApprover ? allCompanies || inv.companyId === scopeCompanyId : inv.companyId === session.companyId),
      ),
    [invoices, isGlobalApprover, allCompanies, scopeCompanyId, session.companyId],
  );

  const ordersById = useMemo(() => new Map(purchaseOrders.map((po) => [po.id, po])), [purchaseOrders]);
  const suppliersById = useMemo(() => new Map(suppliers.map((s) => [s.id, s])), [suppliers]);
  const suppliersByTaxId = useMemo(() => new Map(suppliers.map((s) => [s.taxRegistrationNumber, s])), [suppliers]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return pendingInvoices.filter((inv) => {
      const order = ordersById.get(inv.purchaseOrderId ?? "");
      const supplier = suppliersById.get(inv.supplierId ?? "") ?? (inv.taxId ? suppliersByTaxId.get(inv.taxId) : undefined);
      const matchesQuery =
        query.length === 0 ||
        inv.invoiceNumber.toLowerCase().includes(query) ||
        order?.orderNumber.toLowerCase().includes(query) ||
        supplier?.displayName.toLowerCase().includes(query);
      const matchesValue = valueFilter === "all" || inv.total >= HIGH_VALUE_THRESHOLD;
      return matchesQuery && matchesValue;
    });
  }, [pendingInvoices, search, valueFilter, ordersById, suppliersById, suppliersByTaxId]);

  const stats = useMemo(
    () => ({
      pending: pendingInvoices.length,
      highValue: pendingInvoices.filter((inv) => inv.total >= HIGH_VALUE_THRESHOLD).length,
      totalAmount: pendingInvoices.reduce((sum, inv) => sum + inv.total, 0),
    }),
    [pendingInvoices],
  );

  async function handleApprove(invoiceId: string) {
    if (!session.userId) return;
    await approveInvoice(invoiceId, session.userId);
  }

  async function handleReject(invoiceId: string) {
    if (!session.userId) return;
    const reason = reasons[invoiceId]?.trim();
    if (!reason) return;
    await rejectInvoice(invoiceId, session.userId, reason);
  }

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">
          {t("pendingApprovalsTitle")}
        </h1>
        <p className="max-w-2xl text-sm leading-6 text-slate-600 sm:text-base">{t("approvalsDescription")}</p>
      </section>

      <div className="grid gap-4 md:grid-cols-3">
        {[
          { label: t("pendingReview"), value: stats.pending.toLocaleString() },
          { label: t("highValue"), value: stats.highValue.toLocaleString() },
          { label: t("approvalTotal"), value: formatCurrency(stats.totalAmount) },
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
            placeholder={t("searchApprovalsPlaceholder")}
            className="flex-1"
          />
          <Select
            value={valueFilter}
            onChange={(e) => setValueFilter(e.target.value as "all" | "high")}
            className="xl:w-[240px]"
          >
            <option value="all">{t("pendingReview")}</option>
            <option value="high">{t("highValue")}</option>
          </Select>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-left">
            <thead className="bg-slate-50/90 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              <tr>
                <th className="px-5 py-4">{t("invoices")}</th>
                <th className="px-5 py-4">{t("purchaseOrder")}</th>
                <th className="px-5 py-4">{t("supplierName")}</th>
                <th className="px-5 py-4">{t("total")}</th>
                <th className="px-5 py-4">{t("reason")}</th>
                <th className="px-5 py-4 text-right">{t("actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.length > 0 ? (
                filtered.map((inv) => {
                  const order = ordersById.get(inv.purchaseOrderId ?? "");
                  const supplier =
                    suppliersById.get(inv.supplierId ?? "") ?? (inv.taxId ? suppliersByTaxId.get(inv.taxId) : undefined);
                  return (
                    <tr key={inv.id}>
                      <td className="px-5 py-4">
                        <p className="font-semibold text-slate-950">{inv.invoiceNumber}</p>
                        <StatusBadge status={inv.status} />
                      </td>
                      <td className="px-5 py-4 text-sm text-slate-700">{order?.orderNumber ?? t("unlinkedOrder")}</td>
                      <td className="px-5 py-4 text-sm text-slate-700">{supplier?.displayName ?? "—"}</td>
                      <td className="px-5 py-4 text-sm font-semibold text-slate-900">{formatCurrency(inv.total)}</td>
                      <td className="px-5 py-4">
                        <Input
                          value={reasons[inv.id] ?? ""}
                          onChange={(e) => setReasons((prev) => ({ ...prev, [inv.id]: e.target.value }))}
                          placeholder={t("reason")}
                        />
                      </td>
                      <td className="px-5 py-4 text-right">
                        <div className="flex justify-end gap-2">
                          <Button variant="primary" onClick={() => handleApprove(inv.id)}>
                            {t("approve") ?? "Aprobar"}
                          </Button>
                          <Button variant="danger" onClick={() => handleReject(inv.id)}>
                            {t("reject") ?? "Rechazar"}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={6} className="px-5 py-10 text-center text-sm text-slate-500">
                    {t("noPurchaseOrdersFoundDescription")}
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
