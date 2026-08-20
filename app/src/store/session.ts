import { create } from "zustand";
import type { SessionState } from "./types";

interface SessionStore {
  session: SessionState;
  setSession: (session: SessionState) => void;
  clearSession: () => void;
}

const emptySession: SessionState = {
  userId: null,
  role: null,
  companyId: null,
  supplierId: null,
  activeCompany: null,
  availableCompanies: [],
};

// Equivalente a `zt` en el bundle original (store de sesion via Zustand).
export const useSessionStore = create<SessionStore>((set) => ({
  session: emptySession,
  setSession: (session) => set({ session }),
  clearSession: () => set({ session: emptySession }),
}));
