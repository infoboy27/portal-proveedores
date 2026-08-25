// Reset de password disparado por un admin/superadmin desde Users.tsx
// (2026-08-24, pedido explicito de Jonatan para la demo con Adsemble --
// antes de esto el reset se hacia a mano por script, sin registro de
// auditoria ni boton en el panel). Sigue el mismo patron que invite-user:
// valida el rol de quien llama server-side (nunca confia en el cliente),
// y registra el evento en security_audit_log.
//
// A diferencia de invite-user, NO usa auth.admin.generateLink -- esa
// llamada solo devuelve el link, no manda el correo. resetPasswordForEmail
// llama al endpoint publico /recover de GoTrue, que si dispara el correo
// real via el SMTP configurado, con la plantilla recovery.html ya de marca
// Adsemble (misma plantilla usada la semana pasada para el reset manual).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function admin() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

Deno.serve(async (req: Request) => {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ ok: false, error: "Falta el token del usuario que pide el reset" }), {
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
  if (!callerProfile || !["admin", "superadmin"].includes(callerProfile.role as string)) {
    return new Response(JSON.stringify({ ok: false, error: "Solo un administrador puede resetear passwords" }), {
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

  const { data: target } = await db.from("user_profiles").select("email").eq("id", body.userId).maybeSingle();
  if (!target?.email) {
    return new Response(JSON.stringify({ ok: false, error: "Usuario no encontrado" }), { status: 404 });
  }

  const siteUrl = Deno.env.get("SITE_URL");
  const { error: recoverErr } = await db.auth.resetPasswordForEmail(target.email, {
    redirectTo: siteUrl ? `${siteUrl}/set-password` : undefined,
  });
  if (recoverErr) {
    return new Response(JSON.stringify({ ok: false, error: recoverErr.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  await db.from("security_audit_log").insert({
    event_type: "password_reset_requested",
    actor_user_id: callerAuth.user.id,
    target_user_id: body.userId,
    target_email: target.email,
  });

  return new Response(JSON.stringify({ ok: true, email: target.email }), { headers: { "Content-Type": "application/json" } });
});
