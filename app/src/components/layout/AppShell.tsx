import { useMemo } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useSessionStore } from "@/store/session";
import { useTranslation } from "@/i18n";
import { supabase } from "@/lib/supabase";
import { ROLE_FEATURES } from "@/routes/FeatureGuard";
import { Select } from "@/components/ui/Select";
import { IdleSessionGuard } from "@/components/IdleSessionGuard";
import logoAdsemble from "@/assets/logo-adsemble.jpg";

const NAV_ITEMS: { to: string; labelKey: string; feature?: string }[] = [
  { to: "/", labelKey: "roleAwareDashboard" },
  { to: "/orders", labelKey: "purchaseOrdersTitle", feature: "orders.read" },
  { to: "/invoices", labelKey: "invoices", feature: "invoices.read" },
  { to: "/approvals", labelKey: "pendingApprovalsTitle", feature: "approvals.review" },
  { to: "/payments", labelKey: "paymentsTitle", feature: "payments.read" },
  { to: "/exports", labelKey: "exportsTitle", feature: "exports.read" },
  { to: "/audit", labelKey: "auditTitle", feature: "audit.read" },
  { to: "/companies", labelKey: "companiesTitle", feature: "companies.manage" },
  { to: "/users", labelKey: "users", feature: "users.manage" },
  { to: "/suppliers", labelKey: "suppliers", feature: "suppliers.manage" },
  { to: "/security", labelKey: "securityTitle", feature: "security.manage" },
];

// Key Players (2026-09-02), item 1/12/13: con 2+ empresas reales, el
// usuario tiene que elegir explicitamente antes de ver cualquier dato --
// App.tsx ya calculo companyConfirmed=false para este caso. Bloquea toda
// la app (nada de datos de ninguna empresa se muestra "por defecto")
// hasta que se confirme una eleccion real.
function CompanyGate({
  companies,
  onConfirm,
}: {
  companies: import("@/store/types").Company[];
  onConfirm: (company: import("@/store/types").Company) => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <img src={logoAdsemble} alt="Adsemble" className="mb-4 h-10 w-auto" />
        <h1 className="text-lg font-semibold text-slate-950">Seleccione una empresa para continuar</h1>
        <p className="mt-1 text-sm text-slate-600">
          Tenes acceso a mas de una empresa. Elegi con cual vas a trabajar ahora.
        </p>
        <div className="mt-5 space-y-2">
          {companies.map((c) => (
            <button
              key={c.companyId}
              type="button"
              onClick={() => onConfirm(c)}
              className="flex w-full items-center gap-3 rounded-xl border border-slate-200 px-4 py-3 text-left text-sm font-medium text-slate-800 hover:border-slate-400 hover:bg-slate-50"
            >
              <span className="h-4 w-4 shrink-0 rounded-full border border-slate-300" />
              {c.companyName}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Equivalente a `rx` (shell) en el bundle original.
export function AppShell() {
  const { t } = useTranslation();
  const role = useSessionStore((s) => s.session.role);
  const activeCompany = useSessionStore((s) => s.session.activeCompany);
  const availableCompanies = useSessionStore((s) => s.session.availableCompanies);
  const companyConfirmed = useSessionStore((s) => s.session.companyConfirmed);
  const setActiveCompany = useSessionStore((s) => s.setActiveCompany);

  const visibleNavItems = useMemo(
    () => NAV_ITEMS.filter((item) => !item.feature || (role && ROLE_FEATURES[role]?.includes(item.feature))),
    [role],
  );

  if (!companyConfirmed) {
    return (
      <>
        <IdleSessionGuard />
        <CompanyGate companies={availableCompanies} onConfirm={setActiveCompany} />
      </>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <IdleSessionGuard />
      <div className="flex">
        <aside className="hidden w-64 shrink-0 border-r border-slate-200 bg-white/80 p-4 md:block">
          <img src={logoAdsemble} alt="Adsemble" className="mb-4 h-10 w-auto px-2" />
          <p className="mb-6 px-2 text-lg font-semibold text-slate-950">Portal Proveedores</p>
          {/* Selector de empresa (multiempresa, Fase 5, 2026-08-29) -- solo
              se muestra si hay algo entre lo cual elegir. La mayoria de los
              usuarios hoy trabaja con una sola empresa (Adsemble es la
              unica activa en produccion todavia), asi que para ellos esto
              queda oculto sin cambiar nada de lo que ya veian. */}
          {availableCompanies.length > 1 && (
            <div className="mb-4 px-2">
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Empresa
              </label>
              <Select
                value={activeCompany?.companyId ?? ""}
                onChange={(e) => {
                  const next = availableCompanies.find((c) => c.companyId === e.target.value);
                  if (next) setActiveCompany(next);
                }}
                className="text-sm"
              >
                {availableCompanies.map((c) => (
                  <option key={c.companyId} value={c.companyId}>
                    {c.companyName}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <nav className="space-y-1">
            {visibleNavItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) =>
                  `block rounded-xl px-3 py-2 text-sm font-medium ${
                    isActive ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
                  }`
                }
              >
                {t(item.labelKey)}
              </NavLink>
            ))}
          </nav>
          <p className="mt-8 px-2 text-xs uppercase tracking-widest text-slate-400">{role}</p>
          <button
            type="button"
            onClick={() => supabase.auth.signOut()}
            className="mt-2 w-full rounded-xl px-3 py-2 text-left text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            {t("signOut")}
          </button>
        </aside>
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
