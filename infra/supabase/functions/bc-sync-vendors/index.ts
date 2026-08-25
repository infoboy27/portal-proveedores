// Sincroniza proveedores BC -> Supabase (API estandar, perfil completo:
// email, telefono) y, opcionalmente, invita a los proveedores nuevos.
//
// *** INCIDENTE 2026-08-20 (ver docs/BITACORA.md) ***
// La primera version hacia un select+insert/update SECUENCIAL por cada uno
// de los ~3,492 vendors del sandbox -> timeout del worker a mitad de
// camino, pero no antes de invitar por correo real a 26 proveedores reales
// sin aprobacion de Adsemble. Las 26 cuentas se borraron a mano.
//
// Dos salvaguardas nuevas, las dos a proposito redundantes entre si:
// 1. Upsert en bloque (una sola llamada a Supabase, no una por vendor) --
//    arregla el timeout, requiere el indice unico de schema-v8.sql.
// 2. `inviteNewVendors` en el body, default false. Aunque se corra por
//    error o por cron sin pensarlo, NUNCA manda invitaciones salvo que se
//    pida explicitamente. Cuando se pide, un limite duro
//    (MAX_INVITES_PER_RUN) evita que una corrida mande centenas/miles de
//    correos de una sola vez incluso si el llamador lo pidio -- fuerza un
//    rollout por lotes, nunca un blast.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { bcGetAll } from "../_shared/bc-client.ts";
import { provisionInvitedUser } from "../_shared/provision-user.ts";
import { markRan, shouldRun } from "../_shared/sync-throttle.ts";

const MAX_INVITES_PER_RUN = 10;
const THROTTLE_KEY = "sync_vendors_interval_minutes";

interface BcVendor {
  number: string;
  displayName: string;
  taxRegistrationNumber: string;
  email: string;
  blocked: string;
}

interface SyncVendorsRequest {
  inviteNewVendors?: boolean;
}

function admin() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

async function resolveCompanyId(db: ReturnType<typeof admin>): Promise<string> {
  const bcCompanyId = Deno.env.get("BC_COMPANY_ID")!;
  const { data, error } = await db.from("companies").select("id").eq("bc_code", bcCompanyId).single();
  if (error || !data) throw new Error(`No se encontro companies.bc_code = ${bcCompanyId}: ${error?.message}`);
  return data.id as string;
}

Deno.serve(async (req: Request) => {
  let body: SyncVendorsRequest = {};
  try {
    if (req.headers.get("content-length") !== "0") body = (await req.json()) ?? {};
  } catch {
    // body vacio/invalido -> se queda con el default seguro (sin invitar)
  }
  const inviteNewVendors = body.inviteNewVendors === true;

  try {
    const db = admin();

    if (!(await shouldRun(db, THROTTLE_KEY))) {
      return new Response(JSON.stringify({ ok: true, skipped: true, reason: "not due yet" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const companyId = await resolveCompanyId(db);
    const vendors = await bcGetAll<BcVendor>("/vendors");

    // Que vendor_number ya existian ANTES de este upsert -- se necesita
    // saber esto antes de escribir, porque despues del upsert ya no hay
    // forma de distinguir "nuevo" de "actualizado".
    const { data: existingRows, error: existingErr } = await db.from("vendors").select("vendor_number");
    if (existingErr) throw existingErr;
    const existingNumbers = new Set((existingRows ?? []).map((r) => r.vendor_number as string));

    const rows = vendors.map((v) => ({
      vendor_number: v.number,
      tax_registration_number: v.taxRegistrationNumber || null,
      company_name: v.displayName,
      email: v.email || null,
      status: v.blocked && v.blocked.trim() !== "" ? "blocked" : "active",
    }));

    // Upsert en bloque -- una sola llamada, no una por vendor (ver
    // incidente arriba). Requiere el indice unico de schema-v8.sql.
    const { error: upsertErr } = await db.from("vendors").upsert(rows, { onConflict: "vendor_number" });
    if (upsertErr) throw upsertErr;

    const newVendors = vendors.filter((v) => !existingNumbers.has(v.number) && v.email);

    let invited = 0;
    let inviteFailed = 0;
    let inviteSkippedCap = 0;
    const invitedEmails: string[] = [];

    if (inviteNewVendors) {
      const { data: vendorIdRows, error: vendorIdErr } = await db
        .from("vendors")
        .select("id, vendor_number")
        .in("vendor_number", newVendors.map((v) => v.number));
      if (vendorIdErr) throw vendorIdErr;
      const idByNumber = new Map((vendorIdRows ?? []).map((r) => [r.vendor_number as string, r.id as string]));

      const siteUrl = Deno.env.get("SITE_URL") ?? undefined;
      for (const v of newVendors) {
        if (invited >= MAX_INVITES_PER_RUN) {
          inviteSkippedCap = newVendors.length - newVendors.indexOf(v);
          break;
        }
        const vendorId = idByNumber.get(v.number);
        if (!vendorId) continue;

        const { data: existingMapping } = await db
          .from("user_vendor_mapping")
          .select("user_id")
          .eq("vendor_id", vendorId)
          .maybeSingle();
        if (existingMapping) continue;

        const result = await provisionInvitedUser(db, {
          email: v.email,
          role: "supplier",
          companyId,
          vendorId,
          username: v.displayName,
          siteUrl,
        });
        if (result.ok) {
          invited++;
          invitedEmails.push(v.email);
        } else {
          inviteFailed++;
          console.error(`No se pudo invitar a ${v.email} (vendor ${v.number}): ${result.error}`);
        }
      }
    }

    await markRan(db, THROTTLE_KEY);

    return new Response(
      JSON.stringify({
        ok: true,
        vendorsProcessed: vendors.length,
        newVendors: newVendors.length,
        inviteNewVendors,
        invited,
        invitedEmails,
        inviteFailed,
        inviteSkippedCap,
        maxInvitesPerRun: MAX_INVITES_PER_RUN,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
