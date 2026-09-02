import { create } from "zustand";
import type { Company, SessionState } from "./types";

interface SessionStore {
  session: SessionState;
  setSession: (session: SessionState) => void;
  clearSession: () => void;
  setActiveCompany: (company: Company) => void;
}

const emptySession: SessionState = {
  userId: null,
  role: null,
  companyId: null,
  supplierId: null,
  activeCompany: null,
  availableCompanies: [],
  vendorMappings: [],
  companyConfirmed: true,
};

// Equivalente a `zt` en el bundle original (store de sesion via Zustand).
export const useSessionStore = create<SessionStore>((set) => ({
  session: emptySession,
  setSession: (session) => set({ session }),
  clearSession: () => set({ session: emptySession }),
  // Cambiar de empresa activa (Fase 5, multiempresa, 2026-08-29): recalcula
  // supplierId a partir del vendor_id que le corresponde a ESTA empresa --
  // un proveedor vinculado a varias empresas tiene un vendor_id DISTINTO
  // por cada una (BC no comparte proveedores entre empresas), asi que
  // session.supplierId no puede quedarse fijo al cambiar de empresa. No
  // hace falta volver a pedir datos al backend: invoices/purchase_orders
  // ya llegaron con TODAS las empresas del usuario (RLS via
  // portal_vendor_ids(), que ya es multi-fila) -- las paginas ya filtran
  // por session.supplierId/companyId en un useMemo, asi que solo cambiar
  // el estado de sesion re-filtra la data que ya esta en el store.
  setActiveCompany: (company) =>
    set((state) => {
      const mapping = state.session.vendorMappings.find((m) => m.companyId === company.companyId);
      return {
        session: {
          ...state.session,
          activeCompany: company,
          companyId: company.isGlobal ? state.session.companyId : company.companyId,
          supplierId: mapping?.vendorId ?? null,
          // Elegir explicitamente (aunque sea re-elegir la misma) siempre
          // confirma -- es la unica forma de que el gate desaparezca.
          companyConfirmed: true,
        },
      };
    }),
}));
