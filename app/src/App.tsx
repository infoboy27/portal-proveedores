import { useEffect, useState } from "react";
import { RouterProvider } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useSessionStore } from "@/store/session";
import { useDomainStore } from "@/store/domain";
import { router } from "@/routes/router";
import type { Company, VendorMapping } from "@/store/types";

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

      const { data: mappingRows } = await supabase
        .from("user_vendor_mapping")
        .select("company_id, vendor_id, is_primary")
        .eq("user_id", userId)
        .order("is_primary", { ascending: false });

      const vendorMappings: VendorMapping[] = (mappingRows ?? [])
        .filter((m) => !!m.company_id)
        .map((m) => ({
          companyId: m.company_id as string,
          vendorId: m.vendor_id as string,
          isPrimary: !!m.is_primary,
        }));

      // Multiempresa (Fase 4/5, 2026-08-29): la RLS de `companies` ya
      // devuelve solo las empresas a las que este usuario tiene acceso
      // (portal_company_ids(), schema-v18.sql -- union de sus
      // user_vendor_mapping y su user_profiles.company_id) -- una sola
      // consulta sirve para todos los roles, no hace falta un camino
      // distinto por rol.
      //
      // A proposito SIN filtrar por disabled_at aqui (a diferencia de
      // domain.ts:fetchAll, que si lo filtra para el listado general) --
      // `disabled_at` controla si bc-sync-* procesa esa empresa, no si un
      // usuario que YA tiene un vinculo real a ella puede seguir viendola
      // en su propio selector. Encontrado en vivo probando esta fase:
      // pausar una empresa (ej. mantenimiento) no deberia esconderle a un
      // proveedor ya vinculado su propia relacion con esa empresa.
      const { data: companyRows } = await supabase
        .from("companies")
        .select("id, company_name")
        .order("company_name", { ascending: true });

      const role = (profile?.role as "admin" | "superadmin" | "approver" | "supplier" | "service_uploader") ?? null;
      const availableCompanies: Company[] = (companyRows ?? []).map((c) => ({
        companyId: c.id as string,
        companyName: c.company_name as string,
      }));

      // admin/superadmin ya ven todo sin importar la empresa (RLS los
      // exime por completo, ver schema-v3.sql) -- se les agrega una
      // opcion sintetica al principio del selector y arrancan ahi por
      // defecto, para no perder ese alcance ahora que el selector
      // realmente filtra client-side.
      if (role === "admin" || role === "superadmin") {
        availableCompanies.unshift({ companyId: "__all__", companyName: "Todas las empresas", isGlobal: true });
      }

      const primaryMapping = vendorMappings.find((m) => m.isPrimary) ?? vendorMappings[0];
      const defaultCompanyId = primaryMapping?.companyId ?? profile?.company_id ?? null;
      const activeCompany =
        availableCompanies.find((c) => c.isGlobal) ??
        availableCompanies.find((c) => c.companyId === defaultCompanyId) ??
        availableCompanies[0] ??
        null;

      // Key Players (2026-09-02), item 1/12/13: admin/superadmin arrancan
      // en alcance global por diseño (no se les pide elegir). Para el
      // resto de los roles, con 2+ empresas reales hay que confirmar
      // explicitamente antes de poder trabajar -- con 1 sola, se
      // autoselecciona sin friccion (nada que elegir de verdad).
      const realCompanyCount = availableCompanies.filter((c) => !c.isGlobal).length;
      const companyConfirmed = role === "admin" || role === "superadmin" || realCompanyCount <= 1;

      setSession({
        userId,
        role,
        // user_profiles.company_id es la fuente correcta para todos los
        // roles (2026-08-25: se descubrio que un approver recien creado no
        // veia nada en Aprobaciones -- companyId salia null porque solo se
        // leia de user_vendor_mapping, que unicamente existe para
        // proveedores). El mapping queda como respaldo, no como fuente
        // principal.
        companyId: profile?.company_id ?? defaultCompanyId,
        supplierId: vendorMappings.find((m) => m.companyId === activeCompany?.companyId)?.vendorId ?? primaryMapping?.vendorId ?? null,
        activeCompany,
        availableCompanies,
        vendorMappings,
        companyConfirmed,
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
