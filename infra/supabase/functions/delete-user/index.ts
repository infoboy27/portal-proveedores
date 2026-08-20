// Eliminacion real de cuenta (2026-08-20, parte del panel de seguridad
// pedido por Jonatan: "deberia haber un superusuario para esos fines").
// Exclusivo de superadmin, no de admin -- es la primera capacidad que
// realmente distingue los dos roles (antes eran identicos en todo el
// codigo). Registra el evento en security_audit_log antes de borrar (para
// que el registro sobreviva aunque el usuario objetivo desaparezca).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function admin() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

Deno.serve(async (req: Request) => {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ ok: false, error: "Falta el token del usuario que borra" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const db = admin();

  const { data: callerAuth, error: callerAuthErr } = await db.auth.getUser(authHeader.replace("Bearer ", ""));
  if (callerAuthErr || !callerAuth.user) {
    return new Response(JSON.stringify({ ok: false, error: "Token invalido o expirado" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  const { data: callerProfile } = await db.from("user_profiles").select("role").eq("id", callerAuth.user.id).maybeSingle();
  if (!callerProfile || callerProfile.role !== "superadmin") {
    return new Response(JSON.stringify({ ok: false, error: "Solo un superadmin puede eliminar cuentas" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: { userId?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "Body invalido" }), { status: 400 });
  }
  if (!body.userId) {
    return new Response(JSON.stringify({ ok: false, error: "Falta userId" }), { status: 400 });
  }
  if (body.userId === callerAuth.user.id) {
    return new Response(JSON.stringify({ ok: false, error: "No puedes eliminar tu propia cuenta" }), { status: 400 });
  }

  const { data: target } = await db.from("user_profiles").select("email").eq("id", body.userId).maybeSingle();

  // Se registra ANTES de borrar -- target_user_id queda como referencia
  // historica aunque la fila de user_profiles desaparezca (on delete cascade
  // desde auth.users).
  await db.from("security_audit_log").insert({
    event_type: "user_deleted",
    actor_user_id: callerAuth.user.id,
    target_user_id: body.userId,
    target_email: target?.email ?? null,
  });

  const { error: deleteErr } = await db.auth.admin.deleteUser(body.userId);
  if (deleteErr) {
    return new Response(JSON.stringify({ ok: false, error: deleteErr.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
});
