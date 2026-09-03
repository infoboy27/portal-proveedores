// Onboarding real (2026-08-20): antes de esto, crear un login nuevo requeria
// la clave de servicio corrida a mano fuera de la app -- "Crear usuario" en
// Users.tsx solo editaba un perfil ya existente (ver comentario historico en
// domain.ts:updateUser). Esta funcion es el unico camino para crear un login
// nuevo desde la app: valida server-side que quien llama sea admin/superadmin
// (nunca confia en el rol que mande el cliente), y delega el aprovisionamiento
// a _shared/provision-user.ts (mismo helper que usa bc-sync-vendors para el
// alta automatica de proveedores).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { provisionInvitedUser, type PortalRole } from "../_shared/provision-user.ts";

const VALID_ROLES: PortalRole[] = ["admin", "superadmin", "approver", "supplier", "service_uploader"];
const VENDOR_SCOPED_ROLES: PortalRole[] = ["supplier", "service_uploader"];

interface InviteRequest {
  email: string;
  role: PortalRole;
  companyId?: string | null;
  vendorId?: string | null;
  username?: string;
}

function admin() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

Deno.serve(async (req: Request) => {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ ok: false, error: "Falta el token del usuario que invita" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const db = admin();

  // Revalida el rol de quien llama contra la base -- nunca contra lo que
  // mande el body de la request.
  const { data: callerAuth, error: callerAuthErr } = await db.auth.getUser(authHeader.replace("Bearer ", ""));
  if (callerAuthErr || !callerAuth.user) {
    return new Response(JSON.stringify({ ok: false, error: "Token invalido o expirado" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  const { data: callerProfile } = await db.from("user_profiles").select("role").eq("id", callerAuth.user.id).maybeSingle();
  if (!callerProfile || !["admin", "superadmin"].includes(callerProfile.role as string)) {
    return new Response(JSON.stringify({ ok: false, error: "Solo un administrador puede invitar usuarios" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  const callerRole = callerProfile.role as string;

  let body: InviteRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "Body invalido" }), { status: 400 });
  }

  if (!body.email?.trim() || !body.role) {
    return new Response(JSON.stringify({ ok: false, error: "Faltan email y/o role" }), { status: 400 });
  }
  if (!VALID_ROLES.includes(body.role)) {
    return new Response(JSON.stringify({ ok: false, error: `Rol invalido: ${body.role}` }), { status: 400 });
  }
  if (VENDOR_SCOPED_ROLES.includes(body.role) && !body.vendorId) {
    return new Response(
      JSON.stringify({ ok: false, error: "vendorId es obligatorio para proveedor / rol interno de facturas recurrentes" }),
      { status: 400 },
    );
  }

  // Key Players (2026-09-03), item 4: un admin (no superadmin) solo puede
  // invitar analistas ("approver") dentro de sus empresas asignadas --
  // hallazgo real: sin esto, un admin podia invitar a otro usuario como
  // admin o superadmin, o asignarlo a cualquier empresa. Mismo criterio
  // que rpc_update_user_profile (schema-v29.sql).
  if (callerRole === "admin") {
    if (body.role !== "approver") {
      return new Response(JSON.stringify({ ok: false, error: "Un administrador solo puede invitar analistas" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (!body.companyId) {
      return new Response(JSON.stringify({ ok: false, error: "companyId es obligatorio" }), { status: 400 });
    }
    const { data: assignment } = await db
      .from("admin_company_assignments")
      .select("company_id")
      .eq("user_id", callerAuth.user.id)
      .eq("company_id", body.companyId)
      .maybeSingle();
    if (!assignment) {
      return new Response(JSON.stringify({ ok: false, error: "No tenes autorizacion sobre esa empresa" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  const result = await provisionInvitedUser(db, {
    email: body.email,
    role: body.role,
    companyId: body.companyId,
    vendorId: body.vendorId,
    username: body.username,
    siteUrl: Deno.env.get("SITE_URL") ?? undefined,
    actorUserId: callerAuth.user.id,
  });

  return new Response(JSON.stringify(result), {
    status: result.ok ? 200 : 500,
    headers: { "Content-Type": "application/json" },
  });
});
