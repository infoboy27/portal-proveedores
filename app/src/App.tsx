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

      // Solo superadmin ve todo sin importar la empresa (RLS lo exime por
      // completo, ver schema-v3.sql) -- se le agrega una opcion sintetica
      // al principio del selector y arranca ahi por defecto.
      //
      // Key Players (2026-09-03), item 4: `admin` YA NO tiene ese mismo
      // alcance global -- companyRows arriba ya viene acotado solo a sus
      // empresas asignadas (admin_company_assignments, RLS de
      // "companies" en schema-v29.sql), asi que no se le agrega la
      // opcion sintetica: elige entre sus empresas reales, igual que
      // aprobador/proveedor.
      // 2026-09-07: `admin` y `approver` recuperan la opcion sintetica, pero
      // NO significa lo mismo que para superadmin. Para ellos "Todas las
      // empresas" quiere decir "todas LAS MIAS": companyRows ya viene
      // acotado por RLS a sus empresas asignadas, y las consultas siguen
      // pasando por esa misma RLS. Es decir, no revierte el item 4 de Key
      // Players (que quito el alcance ilimitado del admin) -- sigue sin ver
      // ni una empresa que no tenga asignada.
      //
      // Lo pidio el equipo al armar el piloto: una analista con las siete
      // empresas del grupo tenia que ir cambiando de empresa una por una,
      // con siete bandejas de aprobacion separadas en vez de una sola. Las
      // pantallas ya estaban preparadas para esto (isGlobalApprover en
      // Approvals.tsx y Dashboard.tsx); lo unico que faltaba era darles la
      // opcion. El proveedor sigue sin ella a proposito: trabaja sobre sus
      // propias facturas y el contexto de empresa ahi si tiene que ser
      // explicito.
      const canWorkAcrossCompanies =
        role === "superadmin" || ((role === "admin" || role === "approver") && availableCompanies.length > 1);
      if (canWorkAcrossCompanies) {
        availableCompanies.unshift({ companyId: "__all__", companyName: "Todas las empresas", isGlobal: true });
      }

      const primaryMapping = vendorMappings.find((m) => m.isPrimary) ?? vendorMappings[0];
      const defaultCompanyId = primaryMapping?.companyId ?? profile?.company_id ?? null;
      const activeCompany =
        availableCompanies.find((c) => c.isGlobal) ??
        availableCompanies.find((c) => c.companyId === defaultCompanyId) ??
        availableCompanies[0] ??
        null;

      // Key Players (2026-09-02/03), item 1/12/13: solo superadmin
      // arranca en alcance global por diseño (no se le pide elegir). El
      // resto de los roles -- admin incluido desde el item 4 -- con 2+
      // empresas reales tiene que confirmar explicitamente antes de
      // trabajar; con 1 sola, se autoselecciona sin friccion.
      const realCompanyCount = availableCompanies.filter((c) => !c.isGlobal).length;
      let companyConfirmed = role === "superadmin" || realCompanyCount <= 1;

      // La eleccion sobrevive a recargas (2026-09-07). Sin esto, el gate
      // reaparecia solo: loadProfile recalcula companyConfirmed desde cero,
      // y se ejecuta en cada recarga completa de pagina -- por ejemplo
      // despues de subir una factura, que hace window.location.href.
      // Reportado por Jonatan: "de repente me pone a seleccionar la
      // empresa... muchas veces usando la app lo hace tambien".
      //
      // Se guarda por usuario para que dos cuentas en el mismo navegador no
      // se pisen, y se descarta si esa empresa ya no esta entre las suyas
      // (le quitaron el acceso, la desactivaron, cambio de rol).
      let restored: Company | null = null;
      if (!companyConfirmed) {
        try {
          const saved = localStorage.getItem(`portal-empresa-activa:${userId}`);
          if (saved) restored = availableCompanies.find((c) => c.companyId === saved) ?? null;
        } catch {
          // Modo privado o almacenamiento bloqueado: se pide elegir, nada mas.
        }
        if (restored) companyConfirmed = true;
      }

      // El proveedor de la empresa que REALMENTE queda activa.
      //
      // Bug real y grave (2026-09-08): esto se calculaba sobre
      // `activeCompany` -- la empresa por defecto -- mientras la sesion se
      // quedaba con `restored ?? activeCompany`. Cuando habia empresa
      // recordada (o sea, siempre, desde que se agrego esa memoria el
      // 2026-09-07), la sesion terminaba con la empresa X y el proveedor de
      // la empresa Y. Consecuencias vistas en produccion:
      //   - Las facturas se guardaban con company_id de X y vendor_id de Y.
      //   - El listado del proveedor filtra por vendor_id, asi que con una
      //     empresa seleccionada le mostraba las facturas de la otra.
      //   - Y por eso el equipo volvia a subir la misma factura: no la veia
      //     donde correspondia.
      // 9 facturas de produccion quedaron mal, todas creadas despues de ese
      // despliegue.
      //
      // Ademas se quita el fallback silencioso a primaryMapping cuando hay
      // una empresa concreta activa: si no hay vinculo para esa empresa, el
      // valor correcto es null (y la carga se bloquea con un mensaje), no el
      // proveedor de otra empresa.
      const finalActiveCompany = restored ?? activeCompany;
      const supplierIdForActiveCompany =
        finalActiveCompany && !finalActiveCompany.isGlobal
          ? (vendorMappings.find((m) => m.companyId === finalActiveCompany.companyId)?.vendorId ?? null)
          : (primaryMapping?.vendorId ?? null);

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
        supplierId: supplierIdForActiveCompany,
        // La empresa recordada gana sobre el default calculado: si el
        // usuario ya eligio, se respeta su eleccion.
        activeCompany: finalActiveCompany,
        availableCompanies,
        vendorMappings,
        companyConfirmed,
      });
      await fetchAll();
    }

    // Quien esta cargado ahora mismo. Ver el comentario del listener abajo.
    let loadedUserId: string | null = null;

    supabase.auth.getSession().then(({ data }) => {
      if (data.session?.user) {
        // Marcarlo aca tambien evita la carga duplicada: el listener de
        // abajo dispara igual con la sesion inicial.
        loadedUserId = data.session.user.id;
        loadProfile(data.session.user.id).finally(() => setReady(true));
      } else {
        setReady(true);
      }
    });

    // Solo se recarga el perfil cuando cambia QUIEN esta logueado
    // (2026-09-07). onAuthStateChange no dispara unicamente al entrar y
    // salir: tambien en cada refresco de token y al volver el foco a la
    // pestaña. Cada una de esas veces se volvia a ejecutar loadProfile, que
    // recalcula companyConfirmed desde cero, y el usuario terminaba de
    // vuelta en "Seleccione una empresa" en medio del trabajo -- justo el
    // sintoma reportado: "si dejo de usar el mouse un momento, de inmediato
    // me manda a esa pantalla".
    //
    // Un refresco de token no cambia nada del perfil, asi que recargarlo no
    // aportaba nada; lo unico que hacia era tirar el estado de la sesion.
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      const userId = session?.user?.id ?? null;
      if (userId) {
        if (userId === loadedUserId) return;
        loadedUserId = userId;
        loadProfile(userId);
      } else {
        loadedUserId = null;
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
