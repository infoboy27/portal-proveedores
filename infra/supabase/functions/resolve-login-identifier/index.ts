// Permite que un proveedor entre con su RNC/cedula ademas de su correo
// (pedido explicito 2026-08-20: "que se puedan loguear los suplidores
// usando RNC, CEDULA O email que esta registrado en BC"). Supabase Auth
// solo soporta login por correo -- esta funcion resuelve el identificador
// al correo real antes de que Login.tsx llame signInWithPassword.
//
// Publica (igual que el resto de las funciones, FUNCTIONS_VERIFY_JWT=false)
// porque se necesita ANTES de tener sesion. Siempre responde 200 con un
// mensaje generico cuando no hay match, para no facilitar enumeracion de
// RNCs validos mas alla de lo que ya es publico (registro DGII).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function admin() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

const GENERIC_NOT_FOUND = { ok: false, error: "No se encontro una cuenta con ese usuario, RNC o cedula." };

Deno.serve(async (req: Request) => {
  let body: { identifier?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "Body invalido" }), { status: 400 });
  }

  const identifier = (body.identifier ?? "").trim();
  if (!identifier) {
    return new Response(JSON.stringify({ ok: false, error: "Falta identifier" }), { status: 400 });
  }

  // Ya es un correo -- se usa tal cual, no hace falta resolver nada.
  if (identifier.includes("@")) {
    return new Response(JSON.stringify({ ok: true, email: identifier.toLowerCase() }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // RNC/cedula: normaliza quitando guiones/espacios, busca el vendor por
  // ese numero, y el usuario proveedor primario mapeado a ese vendor.
  //
  // Se compara contra tax_registration_number_digits (columna generada,
  // schema-v13.sql) y no contra tax_registration_number crudo -- BC guarda
  // el RNC con guiones (ej. "131-00000-1"), asi que comparar el numero ya
  // normalizado contra el texto crudo casi nunca calzaba.
  const normalized = identifier.replace(/[^0-9]/g, "");
  if (!normalized) {
    return new Response(JSON.stringify(GENERIC_NOT_FOUND), { headers: { "Content-Type": "application/json" } });
  }

  const db = admin();
  const { data: vendor } = await db
    .from("vendors")
    .select("id")
    .eq("tax_registration_number_digits", normalized)
    .maybeSingle();
  if (!vendor) {
    return new Response(JSON.stringify(GENERIC_NOT_FOUND), { headers: { "Content-Type": "application/json" } });
  }

  const { data: mapping } = await db
    .from("user_vendor_mapping")
    .select("user_id")
    .eq("vendor_id", vendor.id)
    .eq("is_primary", true)
    .maybeSingle();
  if (!mapping) {
    return new Response(JSON.stringify(GENERIC_NOT_FOUND), { headers: { "Content-Type": "application/json" } });
  }

  const { data: profile } = await db.from("user_profiles").select("email").eq("id", mapping.user_id).maybeSingle();
  if (!profile?.email) {
    return new Response(JSON.stringify(GENERIC_NOT_FOUND), { headers: { "Content-Type": "application/json" } });
  }

  return new Response(JSON.stringify({ ok: true, email: profile.email }), {
    headers: { "Content-Type": "application/json" },
  });
});
