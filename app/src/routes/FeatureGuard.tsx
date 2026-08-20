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
    "payments.read",
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
    "payments.read",
    "audit.read",
    "companies.manage",
    "users.manage",
    "suppliers.manage",
  ],
  approver: ["orders.read", "invoices.read", "approvals.review", "payments.read", "audit.read"],
  supplier: ["orders.read", "invoices.read", "payments.read"],
  // Rol interno para cargar facturas de proveedores recurrentes de
  // servicios (compromiso enviado a Adsemble) — mismos permisos que
  // supplier, ya que sube facturas desde OrderDetail igual que un proveedor.
  service_uploader: ["orders.read", "invoices.read", "payments.read"],
};

export function FeatureGuard({ requiredFeature }: { requiredFeature?: string; children?: ReactNode }) {
  const role = useSessionStore((s) => s.session.role);

  if (!role) return <Navigate to="/login" replace />;

  if (requiredFeature && !ROLE_FEATURES[role]?.includes(requiredFeature)) {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
