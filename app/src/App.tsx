import { useEffect, useState } from "react";
import { RouterProvider } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useSessionStore } from "@/store/session";
import { useDomainStore } from "@/store/domain";
import { router } from "@/routes/router";

const queryClient = new QueryClient();

function AuthBootstrap({ children }: { children: React.ReactNode }) {
  const setSession = useSessionStore((s) => s.setSession);
  const clearSession = useSessionStore((s) => s.clearSession);
  const fetchAll = useDomainStore((s) => s.fetchAll);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    async function loadProfile(userId: string) {
      const { data: profile } = await supabase
        .from("user_profiles")
        .select("id, username, email, role, company_id")
        .eq("id", userId)
        .maybeSingle();

      const { data: mapping } = await supabase
        .from("user_vendor_mapping")
        .select("company_id, vendor_id, is_primary")
        .eq("user_id", userId)
        .order("is_primary", { ascending: false });

      setSession({
        userId,
        role: (profile?.role as "admin" | "superadmin" | "approver" | "supplier") ?? null,
        // user_profiles.company_id es la fuente correcta para todos los
        // roles (2026-08-25: se descubrio que un approver recien creado no
        // veia nada en Aprobaciones -- companyId salia null porque solo se
        // leia de user_vendor_mapping, que unicamente existe para
        // proveedores). El mapping queda como respaldo, no como fuente
        // principal.
        companyId: profile?.company_id ?? mapping?.[0]?.company_id ?? null,
        supplierId: mapping?.[0]?.vendor_id ?? null,
        activeCompany: null,
        availableCompanies: [],
      });
      await fetchAll();
    }

    supabase.auth.getSession().then(({ data }) => {
      if (data.session?.user) {
        loadProfile(data.session.user.id).finally(() => setReady(true));
      } else {
        setReady(true);
      }
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        loadProfile(session.user.id);
      } else {
        clearSession();
      }
    });

    return () => listener.subscription.unsubscribe();
  }, [setSession, clearSession, fetchAll]);

  if (!ready) return null;
  return <>{children}</>;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthBootstrap>
        <RouterProvider router={router} />
      </AuthBootstrap>
    </QueryClientProvider>
  );
}
