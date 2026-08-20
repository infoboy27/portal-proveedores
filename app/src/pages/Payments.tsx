import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "@/i18n";
import { useSessionStore } from "@/store/session";
import { useDomainStore } from "@/store/domain";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { PaymentStatusBadge } from "@/components/ui/PaymentStatusBadge";

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

// Dias 13-15: "consulta de pagos y estado de cuenta". Un estado de cuenta
// completo (saldo inicial, notas de credito, saldo corriente) necesita
// vendor ledger entries de BC, que no estan confirmados para este tenant
// (ver docs/BUSINESS_CENTRAL_INTEGRATION.md §7) — por la regla de no
// inventar endpoints, esta pantalla muestra lo que SI existe hoy: el
// estado de pago manual por factura procesada. Se amplia a estado de
// cuenta completo cuando se confirme el acceso a esos datos en BC.
export function Payments() {
  const { t } = useTranslation();
  const session = useSessionStore((s) => s.session);
  const invoices = useDomainStore((s) => s.invoices);
  const purchaseOrders = useDomainStore((s) => s.purchaseOrders);
  const suppliers = useDomainStore((s) => s.suppliers);

  const [search, setSearch] = useState("");
  const [paidFilter, setPaidFilter] = useState<"all" | "pending" | "paid">("all");

  const isAdmin = session.role === "admin" || session.role === "superadmin";
  const isSupplier = session.role === "supplier" || session.role === "service_uploader";
  const scopeCompanyId = session.activeCompany?.isGlobal ? null : session.activeCompany?.companyId ?? session.companyId;

  const processed = useMemo(
    () =>
      invoices.filter((inv) => {
        if (inv.status !== "processed") return false;
        if (isAdmin) return scopeCompanyId ? inv.companyId === scopeCompanyId : true;
        if (isSupplier) return !!session.supplierId && inv.supplierId === session.supplierId;
        return inv.companyId === session.companyId;
      }),
    [invoices, isAdmin, isSupplier, scopeCompanyId, session.supplierId, session.companyId],
  );

  const ordersById = useMemo(() => new Map(purchaseOrders.map((po) => [po.id, po])), [purchaseOrders]);
  const suppliersById = useMemo(() => new Map(suppliers.map((s) => [s.id, s])), [suppliers]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return processed.filter((inv) => {
      const order = ordersById.get(inv.purchaseOrderId ?? "");
      const supplier = suppliersById.get(inv.supplierId ?? "");
      const matchesQuery =
        query.length === 0 ||
        inv.invoiceNumber.toLowerCase().includes(query) ||
        order?.orderNumber.toLowerCase().includes(query) ||
        supplier?.displayName.toLowerCase().includes(query);
      const matchesPaid = paidFilter === "all" || (paidFilter === "paid" ? !!inv.paidAt : !inv.paidAt);
      return matchesQuery && matchesPaid;
    });
  }, [processed, search, paidFilter, ordersById, suppliersById]);

  const stats = useMemo(() => {
    const paid = processed.filter((inv) => inv.paidAt);
    const pending = processed.filter((inv) => !inv.paidAt);
    return {
      totalProcessed: processed.length,
      pendingCount: pending.length,
      paidCount: paid.length,
      pendingAmount: pending.reduce((sum, inv) => sum + inv.total, 0),
    };
  }, [processed]);

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">Pagos</h1>
        <p className="max-w-2xl text-sm leading-6 text-slate-600 sm:text-base">
          Estado de pago de las facturas ya procesadas en Business Central. El saldo/estado de cuenta completo
          (notas de credito, saldo corriente) queda pendiente de confirmar acceso a los movimientos de cuentas por
          pagar en BC — ver la bitacora del proyecto.
        </p>
      </section>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: "Facturas procesadas", value: stats.totalProcessed.toLocaleString() },
          { label: "Pendientes de pago", value: stats.pendingCount.toLocaleString() },
          { label: "Pagadas", value: stats.paidCount.toLocaleString() },
          { label: "Monto pendiente de pago", value: formatCurrency(stats.pendingAmount) },
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
            placeholder="Buscar factura, orden o proveedor"
            className="flex-1"
          />
          <Select value={paidFilter} onChange={(e) => setPaidFilter(e.target.value as typeof paidFilter)} className="xl:w-[240px]">
            <option value="all">Todos</option>
            <option value="pending">Pendientes de pago</option>
            <option value="paid">Pagadas</option>
          </Select>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1000px] text-left">
            <thead className="bg-slate-50/90 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              <tr>
                <th className="px-5 py-4">{t("invoices")}</th>
                <th className="px-5 py-4">{t("purchaseOrder")}</th>
                <th className="px-5 py-4">{t("supplierName")}</th>
                <th className="px-5 py-4">{t("total")}</th>
                <th className="px-5 py-4">Fecha posible de pago</th>
                <th className="px-5 py-4">Estado de pago</th>
                <th className="px-5 py-4">Origen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.length > 0 ? (
                filtered.map((inv) => {
                  const order = ordersById.get(inv.purchaseOrderId ?? "");
                  const supplier = suppliersById.get(inv.supplierId ?? "");
                  return (
                    <tr key={inv.id} className="transition hover:bg-slate-50/80">
                      <td className="px-5 py-4">
                        <Link to={`/invoices/${inv.id}`} className="font-semibold text-cyan-700 hover:text-cyan-800">
                          {inv.invoiceNumber || inv.id.slice(0, 8)}
                        </Link>
                      </td>
                      <td className="px-5 py-4 text-sm text-slate-700">{order?.orderNumber ?? t("unlinkedOrder")}</td>
                      <td className="px-5 py-4 text-sm text-slate-700">{supplier?.displayName ?? inv.vendorName ?? "-"}</td>
                      <td className="px-5 py-4 text-sm font-semibold text-slate-900">{formatCurrency(inv.total)}</td>
                      <td className="px-5 py-4 text-sm text-slate-600">{formatDate(inv.paymentDueDate)}</td>
                      <td className="px-5 py-4">
                        <PaymentStatusBadge invoice={inv} />
                      </td>
                      <td className="px-5 py-4 text-xs text-slate-500">
                        {inv.paymentSource === "bc" ? "Business Central" : inv.paymentSource === "manual" ? "Manual" : "-"}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-sm text-slate-500">
                    No hay facturas procesadas dentro del alcance actual.
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
