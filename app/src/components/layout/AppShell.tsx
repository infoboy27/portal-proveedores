import { useMemo } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useSessionStore } from "@/store/session";
import { useTranslation } from "@/i18n";
import { supabase } from "@/lib/supabase";
import { ROLE_FEATURES } from "@/routes/FeatureGuard";
import logoAdsemble from "@/assets/logo-adsemble.jpg";

const NAV_ITEMS: { to: string; labelKey: string; feature?: string }[] = [
  { to: "/", labelKey: "roleAwareDashboard" },
  { to: "/orders", labelKey: "purchaseOrdersTitle", feature: "orders.read" },
  { to: "/invoices", labelKey: "invoices", feature: "invoices.read" },
  { to: "/approvals", labelKey: "pendingApprovalsTitle", feature: "approvals.review" },
  { to: "/exports", labelKey: "exportsTitle", feature: "exports.read" },
  { to: "/audit", labelKey: "auditTitle", feature: "audit.read" },
  { to: "/companies", labelKey: "companiesTitle", feature: "companies.manage" },
  { to: "/users", labelKey: "users", feature: "users.manage" },
  { to: "/suppliers", labelKey: "suppliers", feature: "suppliers.manage" },
];

// Equivalente a `rx` (shell) en el bundle original.
export function AppShell() {
  const { t } = useTranslation();
  const role = useSessionStore((s) => s.session.role);

  const visibleNavItems = useMemo(
    () => NAV_ITEMS.filter((item) => !item.feature || (role && ROLE_FEATURES[role]?.includes(item.feature))),
    [role],
  );

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="flex">
        <aside className="hidden w-64 shrink-0 border-r border-slate-200 bg-white/80 p-4 md:block">
          <img src={logoAdsemble} alt="Adsemble" className="mb-4 h-10 w-auto px-2" />
          <p className="mb-6 px-2 text-lg font-semibold text-slate-950">Portal Proveedores</p>
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
