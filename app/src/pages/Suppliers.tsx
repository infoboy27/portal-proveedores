import { useMemo, useState } from "react";
import { useTranslation } from "@/i18n";
import { useSessionStore } from "@/store/session";
import { useDomainStore } from "@/store/domain";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";

// Reconstruccion de `function zP()` — index-beautified.js:29713.
export function Suppliers() {
  const { t } = useTranslation();
  const session = useSessionStore((s) => s.session);
  const suppliers = useDomainStore((s) => s.suppliers);
  const [search, setSearch] = useState("");

  const isAdmin = session.role === "admin" || session.role === "superadmin";
  const scoped = useMemo(() => (isAdmin ? suppliers : suppliers), [isAdmin, suppliers]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return scoped.filter(
      (s) =>
        query.length === 0 ||
        s.displayName.toLowerCase().includes(query) ||
        s.vendorNumber.toLowerCase().includes(query) ||
        (s.email ?? "").toLowerCase().includes(query),
    );
  }, [scoped, search]);

  const stats = [
    { label: t("totalSuppliers"), value: scoped.length.toLocaleString() },
    { label: t("activeSuppliers"), value: scoped.filter((s) => !s.blocked).length.toLocaleString() },
    { label: t("blockedSuppliers"), value: scoped.filter((s) => s.blocked).length.toLocaleString() },
    { label: t("suppliersWithEmail"), value: scoped.filter((s) => !!s.email?.trim()).length.toLocaleString() },
  ];

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">{t("suppliersListTitle")}</h1>
        <p className="max-w-2xl text-sm leading-6 text-slate-600 sm:text-base">{t("suppliersListDescription")}</p>
      </section>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.label} className="rounded-[24px] border border-white/70 bg-white/90 p-5 shadow-[0_18px_55px_rgba(15,23,42,0.06)]">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">{stat.label}</p>
            <p className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">{stat.value}</p>
          </Card>
        ))}
      </div>

      <Card className="p-4 sm:p-5">
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("searchSuppliersPlaceholder")} />
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left">
            <thead className="bg-slate-50/90 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              <tr>
                <th className="px-6 py-4">{t("supplier")}</th>
                <th className="px-6 py-4">{t("email")}</th>
                <th className="px-6 py-4">{t("taxId")}</th>
                <th className="px-6 py-4">{t("status")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.length > 0 ? (
                filtered.map((s) => (
                  <tr key={s.id} className="transition hover:bg-slate-50/80">
                    <td className="px-6 py-4">
                      <p className="max-w-[560px] truncate text-sm font-semibold text-slate-950" title={s.displayName}>
                        {s.displayName}
                      </p>
                      <p className="text-xs text-slate-500">{s.vendorNumber}</p>
                    </td>
                    <td className="px-6 py-4 text-sm text-slate-600">{s.email ?? "-"}</td>
                    <td className="px-6 py-4 text-sm text-slate-600">{s.taxRegistrationNumber}</td>
                    <td className="px-6 py-4">
                      <span
                        className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${
                          s.blocked ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700"
                        }`}
                      >
                        {t(s.blocked ? "inactive" : "active")}
                      </span>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4} className="px-6 py-14 text-center text-sm text-slate-500">
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
