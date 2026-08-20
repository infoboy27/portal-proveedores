import type { ReactNode } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { useSessionStore } from "@/store/session";

// Equivalente a `gn` en el bundle original: cada ruta privada exige un
// requiredFeature explicito (permisos por feature-flag, no solo por rol).
// Ver: Portal-proveedores/PLAN-RECONSTRUCCION.md, seccion "Sistema de permisos".

export const ROLE_FEATURES: Record<string, string[]> = {
  superadmin: [
    "orders.read",
    "invoices.read",
    "approvals.review",
    "exports.read",
    "audit.read",
    "companies.manage",
    "users.manage",
    "suppliers.manage",
  ],
  admin: [
    "orders.read",
    "invoices.read",
    "approvals.review",
    "exports.read",
    "audit.read",
    "companies.manage",
    "users.manage",
    "suppliers.manage",
  ],
  approver: ["orders.read", "invoices.read", "approvals.review", "audit.read"],
  supplier: ["orders.read", "invoices.read"],
};

export function FeatureGuard({ requiredFeature }: { requiredFeature?: string; children?: ReactNode }) {
  const role = useSessionStore((s) => s.session.role);

  if (!role) return <Navigate to="/login" replace />;

  if (requiredFeature && !ROLE_FEATURES[role]?.includes(requiredFeature)) {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
