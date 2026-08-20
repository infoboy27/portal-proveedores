import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "@/i18n";
import { useDomainStore } from "@/store/domain";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";

const formatCurrency = (value: number) =>
  new Intl.NumberFormat("es-DO", { style: "currency", currency: "DOP" }).format(value);

// Insights por empresa — version simplificada de `my()` (bundle original,
// index-beautified.js:25703), que ademas calcula salud/ultima actividad.
function useCompanyInsights() {
  const companies = useDomainStore((s) => s.companies);
  const invoices = useDomainStore((s) => s.invoices);
  const purchaseOrders = useDomainStore((s) => s.purchaseOrders);
  const suppliers = useDomainStore((s) => s.suppliers);
  const users = useDomainStore((s) => s.users);

  return useMemo(
    () =>
      companies.map((company) => {
        const companyInvoices = invoices.filter((inv) => inv.companyId === company.id);
        const companyOrders = purchaseOrders.filter((po) => po.companyId === company.id);
        const companySuppliers = suppliers.filter((s) => s.status !== "inactive");
        const companyUsers = users.filter((u) => u.companyId === company.id);
        const pendingApprovalCount = companyInvoices.filter((inv) => inv.status === "pending_approval").length;
        const openOrderCount = companyOrders.filter((po) => po.status !== "closed").length;
        const openInvoices = companyInvoices.filter((inv) => inv.status !== "exported");
        return {
          company,
          invoiceCount: companyInvoices.length,
          pendingApprovalCount,
          openOrderCount,
          openInvoiceValue: openInvoices.reduce((sum, inv) => sum + inv.total, 0),
          supplierCount: companySuppliers.length,
          userCount: companyUsers.length,
          health: (pendingApprovalCount > 0 || openOrderCount > 0 ? "attention" : "active") as "attention" | "active",
        };
      }),
    [companies, invoices, purchaseOrders, suppliers, users],
  );
}

// Reconstruccion de `function vP()` — index-beautified.js:26537.
export function CompaniesList() {
  const { t } = useTranslation();
  const insights = useCompanyInsights();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "attention" | "operational">("all");

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return insights.filter((row) => {
      const matchesQuery = query.length === 0 || row.company.name.toLowerCase().includes(query);
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "attention" ? row.health === "attention" : row.health !== "attention");
      return matchesQuery && matchesStatus;
    });
  }, [insights, search, statusFilter]);

  const totals = useMemo(
    () => ({
      activeCompanies: insights.length,
      withPending: insights.filter((r) => r.pendingApprovalCount > 0).length,
      openOrders: insights.reduce((sum, r) => sum + r.openOrderCount, 0),
      openValue: insights.reduce((sum, r) => sum + r.openInvoiceValue, 0),
    }),
    [insights],
  );

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">{t("globalAdministration")}</p>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">{t("companiesTitle")}</h1>
        <p className="max-w-2xl text-sm leading-6 text-slate-600 sm:text-base">{t("companiesPanelDescription")}</p>
      </section>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: "Empresas activas", value: totals.activeCompanies.toLocaleString() },
          { label: "Con facturas pendientes", value: totals.withPending.toLocaleString() },
          { label: "Ordenes abiertas", value: totals.openOrders.toLocaleString() },
          { label: "Monto pendiente", value: formatCurrency(totals.openValue) },
        ].map((stat) => (
          <Card key={stat.label} className="rounded-[24px] border border-white/70 bg-white/90 p-5 shadow-[0_18px_55px_rgba(15,23,42,0.06)]">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">{stat.label}</p>
            <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">{stat.value}</p>
          </Card>
        ))}
      </div>

      <Card className="p-4 sm:p-5">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("searchCompaniesPlaceholder")} className="flex-1" />
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)} className="xl:w-[260px]">
            <option value="all">{t("allCompanyStatuses")}</option>
            <option value="attention">{t("companiesRequiringAttention")}</option>
            <option value="operational">{t("companiesOperational")}</option>
          </Select>
        </div>
      </Card>

      {filtered.length === 0 ? (
        <Card className="p-10 text-center text-sm text-slate-500">{t("noCompaniesFound")}</Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {filtered.map((row) => (
            <Card key={row.company.id} className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <span
                    className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${
                      row.health === "attention" ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"
                    }`}
                  >
                    {row.health === "attention" ? t("requiresAttention") : t("operational")}
                  </span>
                  <h2 className="mt-2 text-lg font-semibold text-slate-950">{row.company.name}</h2>
                </div>
                <Link to={`/companies/${row.company.id}`}>
                  <Button variant="ghost">Ver</Button>
                </Link>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div>
                  <p className="text-slate-500">{t("totalInvoices")}</p>
                  <p className="font-semibold text-slate-900">{row.invoiceCount}</p>
                </div>
                <div>
                  <p className="text-slate-500">{t("pendingApprovalsStat")}</p>
                  <p className="font-semibold text-slate-900">{row.pendingApprovalCount}</p>
                </div>
                <div>
                  <p className="text-slate-500">Ordenes</p>
                  <p className="font-semibold text-slate-900">{row.openOrderCount}</p>
                </div>
                <div>
                  <p className="text-slate-500">{t("totalValue")}</p>
                  <p className="font-semibold text-slate-900">{formatCurrency(row.openInvoiceValue)}</p>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// Reconstruccion de `function iP()` — index-beautified.js:25757.
// Simplificado: el original usa tabs (summary/invoices/orders/suppliers/
// users/activity); aqui se muestran las secciones apiladas en una sola vista.
export function CompanyDetail() {
  const { t } = useTranslation();
  const { companyId = "" } = useParams();
  const insights = useCompanyInsights();
  const invoices = useDomainStore((s) => s.invoices);
  const purchaseOrders = useDomainStore((s) => s.purchaseOrders);

  const row = insights.find((r) => r.company.id === companyId);

  if (!row) {
    return (
      <Card className="p-10 text-center">
        <p className="font-semibold text-slate-800">{t("companyNotFound")}</p>
        <p className="mt-1 text-sm text-slate-500">{t("companyNotFoundDescription")}</p>
        <Link to="/companies" className="mt-4 inline-block">
          <Button variant="ghost">{t("backToCompanies")}</Button>
        </Link>
      </Card>
    );
  }

  const companyInvoices = invoices.filter((inv) => inv.companyId === companyId).slice(0, 10);
  const companyOrders = purchaseOrders.filter((po) => po.companyId === companyId).slice(0, 10);

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <Link to="/companies">
          <Button variant="ghost">{t("backToCompanies")}</Button>
        </Link>
        <div className="rounded-[32px] bg-gradient-to-br from-slate-950 via-slate-900 to-cyan-900 p-6 text-white">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                row.health === "attention" ? "bg-amber-100 text-amber-700" : "bg-emerald-100 text-emerald-700"
              }`}
            >
              {row.health === "attention" ? t("requiresAttention") : t("operational")}
            </span>
            <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs font-semibold text-white/85">
              {t("companyCode")} {row.company.id.slice(0, 8)}
            </span>
          </div>
          <h1 className="mt-3 text-2xl font-semibold sm:text-3xl">{row.company.name}</h1>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: t("totalInvoices"), value: row.invoiceCount.toLocaleString() },
          { label: t("pendingApprovalsStat"), value: row.pendingApprovalCount.toLocaleString() },
          { label: "Proveedores", value: row.supplierCount.toLocaleString() },
          { label: "Usuarios", value: row.userCount.toLocaleString() },
        ].map((stat) => (
          <Card key={stat.label} className="p-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">{stat.label}</p>
            <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">{stat.value}</p>
          </Card>
        ))}
      </div>

      <Card className="overflow-hidden p-0">
        <div className="border-b border-slate-100 px-5 py-5">
          <h2 className="text-lg font-semibold text-slate-950">{t("invoices")}</h2>
        </div>
        <div className="divide-y divide-slate-100">
          {companyInvoices.length === 0 ? (
            <p className="p-5 text-sm text-slate-500">{t("emptyState")}</p>
          ) : (
            companyInvoices.map((inv) => (
              <Link key={inv.id} to={`/invoices/${inv.id}`} className="flex items-center justify-between px-5 py-4 hover:bg-slate-50/80">
                <span className="font-semibold text-cyan-700">{inv.invoiceNumber || inv.id.slice(0, 8)}</span>
                <span className="text-sm text-slate-600">{formatCurrency(inv.total)}</span>
              </Link>
            ))
          )}
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="border-b border-slate-100 px-5 py-5">
          <h2 className="text-lg font-semibold text-slate-950">{t("purchaseOrdersTitle")}</h2>
        </div>
        <div className="divide-y divide-slate-100">
          {companyOrders.length === 0 ? (
            <p className="p-5 text-sm text-slate-500">{t("emptyState")}</p>
          ) : (
            companyOrders.map((po) => (
              <Link key={po.id} to={`/orders/${po.id}`} className="flex items-center justify-between px-5 py-4 hover:bg-slate-50/80">
                <span className="font-semibold text-cyan-700">{po.orderNumber}</span>
                <span className="text-sm text-slate-600">{formatCurrency(po.amount)}</span>
              </Link>
            ))
          )}
        </div>
      </Card>
    </div>
  );
}
