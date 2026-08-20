import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "@/i18n";
import { useSessionStore } from "@/store/session";
import { useDomainStore } from "@/store/domain";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatCard } from "@/components/ui/StatCard";
import { StatusBadge } from "@/components/ui/StatusBadge";

// Reconstruccion de `function xP()` (Dashboard) del bundle original.
// TODO: falta reconstruir la vista especifica de proveedor (`yP` en el bundle,
// se muestra cuando role === "supplier"). Por ahora todos los roles ven esta vista.

const formatCurrency = (value: number) =>
  new Intl.NumberFormat("es-DO", { style: "currency", currency: "DOP" }).format(value);

export function Dashboard() {
  const { t } = useTranslation();
  const session = useSessionStore((s) => s.session);
  const purchaseOrders = useDomainStore((s) => s.purchaseOrders);
  const invoices = useDomainStore((s) => s.invoices);
  const users = useDomainStore((s) => s.users);

  const isAdmin = session.role === "admin" || session.role === "superadmin";
  const isSupplier = session.role === "supplier";
  const isGlobalApprover =
    session.role === "approver" &&
    !!(session.activeCompany?.isGlobal || session.availableCompanies.some((c) => c.isGlobal)) &&
    !session.companyId;
  const seesAll = isAdmin || isGlobalApprover;

  const scopedOrders = useMemo(
    () =>
      purchaseOrders.filter((po) => {
        if (seesAll) return true;
        if (isSupplier) return !!session.supplierId && po.vendorId === session.supplierId;
        return po.companyId === session.companyId;
      }),
    [purchaseOrders, seesAll, isSupplier, session.companyId, session.supplierId],
  );
  const scopedInvoices = useMemo(
    () =>
      invoices.filter((inv) => {
        if (seesAll) return true;
        if (isSupplier) return !!session.supplierId && inv.supplierId === session.supplierId;
        return inv.companyId === session.companyId;
      }),
    [invoices, seesAll, isSupplier, session.companyId, session.supplierId],
  );

  const pendingApprovals = scopedInvoices.filter((inv) => inv.status === "pending_approval").length;
  const exportErrors = scopedInvoices.filter((inv) => inv.status === "export_error").length;
  const readyForErp = scopedInvoices.filter((inv) => inv.status === "ready_for_export" || inv.status === "approved").length;
  const companyLabel = session.activeCompany?.companyName ?? session.companyId ?? t("multiCompany");
  const openInvoiceValue = scopedInvoices
    .filter((inv) => inv.status !== "exported")
    .reduce((sum, inv) => sum + inv.total, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-3xl font-semibold text-slate-900">{t("roleAwareDashboard")}</h1>
        {isAdmin && (
          <Link to="/exports">
            <Button variant="ghost">{t("viewErpExports") ?? "Ver exportaciones"}</Button>
          </Link>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Link to="/orders">
          <StatCard title={t("purchaseOrdersStat")} value={String(scopedOrders.length)} description={t("purchaseOrdersStatDescription")} />
        </Link>
        {isAdmin && (
          <>
            <StatCard title={t("pendingApprovalsStat")} value={String(pendingApprovals)} description={t("pendingApprovalsStatDescription")} />
            <StatCard title={t("readyForErpStat")} value={String(readyForErp)} description={t("readyForErpStatDescription")} />
            <StatCard
              title={t("managedUsersStat")}
              value={String(users.filter((u) => isAdmin || u.companyId === session.companyId).length)}
              description={t("managedUsersStatDescription")}
            />
          </>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-slate-950">{t("recentInvoices")}</h2>
            <Link to="/invoices">
              <Button variant="ghost">{t("fullList")}</Button>
            </Link>
          </div>
          <div className="space-y-3">
            {scopedInvoices.slice(0, 4).map((inv) => {
              const order = scopedOrders.find((po) => po.id === inv.purchaseOrderId);
              return (
                <div key={inv.id} className="rounded-2xl border border-slate-200 p-4">
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div>
                      <p className="font-semibold text-slate-950">{inv.invoiceNumber}</p>
                      <p className="text-sm text-slate-500">{order?.orderNumber ?? t("unlinkedOrder")}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={inv.status} />
                      <span className="text-sm font-semibold text-slate-700">{formatCurrency(inv.total)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        {isAdmin && (
          <Card className="p-5">
            <h2 className="text-lg font-semibold text-slate-950">{t("companyContext")}</h2>
            <div className="mt-4 space-y-3 text-sm text-slate-600">
              <div className="flex items-center justify-between">
                <span>{t("company")}</span>
                <span className="font-semibold text-slate-900">{companyLabel}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>{t("exportErrors")}</span>
                <span className="font-semibold text-rose-700">{exportErrors}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>{t("openInvoiceValue")}</span>
                <span className="font-semibold text-slate-900">{formatCurrency(openInvoiceValue)}</span>
              </div>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
