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
import { getActiveCompanies } from "../_shared/companies.ts";
import { provisionInvitedUser } from "../_shared/provision-user.ts";
import { markRan, shouldRun } from "../_shared/sync-throttle.ts";

// MAX_INVITES_PER_RUN se mantiene como tope TOTAL de la corrida, sumando
// las empresas que se procesen -- no un tope por empresa. Sigue siendo la
// misma salvaguarda del incidente de 2026-08-20: nunca mandar mas de 10
// invitaciones reales en una sola invocacion, sin importar cuantas
// empresas se sincronicen en ese momento.
const MAX_INVITES_PER_RUN = 10;
const THROTTLE_KEY = "sync_vendors_interval_minutes";

interface BcVendor {
  number: string;
  displayName: string;
  taxRegistrationNumber: string;
  email: string;
  blocked: string;
}

// vendorPostingGroup viene de la API custom vendorPostingSetups (ya existia
// para Gen. Bus. Posting Group / Vendor Posting Group, ver
// infra/business-central/src/VendorPostingSetupAPI.al) -- NO de la API
// estandar de /vendors, que no la expone. Confirmado en vivo 2026-08-26
// contra el sandbox: los valores reales que usa Adsemble son CPPROV
// (proveedor formal, NCF obligatorio), PROVINFORM (informal, NCF opcional)
// e INT (extranjero, NCF opcional) -- ver plan de observaciones de usuarios.
interface BcVendorPostingSetup {
  number: string;
  vendorPostingGroup: string;
}

interface SyncVendorsRequest {
  inviteNewVendors?: boolean;
}

function admin() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

// PostgREST codifica ".in(col, [...])" como query string en la URL
// (?col=in.(a,b,c,...)) -- con miles de valores (una empresa grande tiene
// ~3,400 vendor_number) la URL supera el limite del proxy y responde "414
// URI too long" en vez del error real de la consulta. Encontrado en vivo
// 2026-08-29 activando JUAN FABIAN (nunca sincronizada, ~3,400 vendors
// nuevos de una vez) -- el mismo patron sin batch ya existia en el bloque
// de invitaciones, solo que nunca corrio con una empresa grande antes.
function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}
const IN_BATCH_SIZE = 200;

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

    const companies = await getActiveCompanies(db);
    const siteUrl = Deno.env.get("SITE_URL") ?? undefined;

    let vendorsProcessed = 0;
    let newVendorsTotal = 0;
    let autoLinkedTotal = 0;
    let invited = 0;
    let inviteFailed = 0;
    let inviteSkippedCap = 0;
    const invitedEmails: string[] = [];
    const perCompany: unknown[] = [];

    // Un throttle para toda la corrida (no uno por empresa): las empresas
    // activas se procesan todas dentro de la misma invocacion, asi que no
    // hay una marca de tiempo compartida que se puedan pisar entre si.
    for (const company of companies) {
      const vendors = await bcGetAll<BcVendor>(company.bcCompanyId, "/vendors");
      const postingSetups = await bcGetAll<BcVendorPostingSetup>(company.bcCompanyId, "/vendorPostingSetups", "custom");
      const postingGroupByNumber = new Map(postingSetups.map((p) => [p.number, p.vendorPostingGroup || null]));

      // Que vendor_number ya existian ANTES de este upsert, DENTRO de esta
      // empresa -- el mismo numero puede existir ya en OTRA empresa sin
      // que eso signifique que ya existe en esta (schema-v16.sql).
      const { data: existingRows, error: existingErr } = await db
        .from("vendors")
        .select("vendor_number")
        .eq("company_id", company.id);
      if (existingErr) throw existingErr;
      const existingNumbers = new Set((existingRows ?? []).map((r) => r.vendor_number as string));

      const rows = vendors.map((v) => ({
        vendor_number: v.number,
        tax_registration_number: v.taxRegistrationNumber || null,
        company_name: v.displayName,
        email: v.email || null,
        status: v.blocked && v.blocked.trim() !== "" ? "blocked" : "active",
        vendor_posting_group: postingGroupByNumber.get(v.number) ?? null,
        company_id: company.id,
      }));

      // Upsert en bloque -- una sola llamada, no una por vendor (ver
      // incidente arriba). Requiere el indice unico de schema-v16.sql
      // (company_id, vendor_number).
      const { error: upsertErr } = await db.from("vendors").upsert(rows, { onConflict: "company_id,vendor_number" });
      if (upsertErr) throw upsertErr;

      // Auto-vinculo por RNC (Fase 3, 2026-08-29 -- decision de Jonatan:
      // automatico, sin aprobacion manual). Si un proveedor recien creado
      // en ESTA empresa comparte RNC con un proveedor de OTRA empresa que
      // YA tiene cuenta de portal, se agrega esta empresa a esa MISMA
      // cuenta -- no se crea usuario nuevo ni se manda correo, solo una
      // fila mas en user_vendor_mapping. Es la mitad "una cuenta, varias
      // empresas" de resolve-login-identifier. Si el RNC coincide con MAS
      // de una cuenta distinta (dato inconsistente real), no se adivina --
      // se deja sin vincular y se loguea para revision manual.
      let companyAutoLinked = 0;
      const newlyCreatedNumbers = new Set(vendors.filter((v) => !existingNumbers.has(v.number)).map((v) => v.number));
      if (newlyCreatedNumbers.size > 0) {
        const newRowsWithDigits: { id: string; vendor_number: string; tax_registration_number_digits: string | null }[] = [];
        for (const batch of chunk(Array.from(newlyCreatedNumbers), IN_BATCH_SIZE)) {
          const { data, error } = await db
            .from("vendors")
            .select("id, vendor_number, tax_registration_number_digits")
            .eq("company_id", company.id)
            .in("vendor_number", batch);
          if (error) throw error;
          newRowsWithDigits.push(...(data ?? []));
        }

        const digitsToLink = Array.from(
          new Set(newRowsWithDigits.map((r) => r.tax_registration_number_digits).filter((d): d is string => !!d)),
        );

        if (digitsToLink.length > 0) {
          const otherVendors: { id: string; tax_registration_number_digits: string | null }[] = [];
          for (const batch of chunk(digitsToLink, IN_BATCH_SIZE)) {
            const { data, error } = await db
              .from("vendors")
              .select("id, tax_registration_number_digits")
              .neq("company_id", company.id)
              .in("tax_registration_number_digits", batch);
            if (error) throw error;
            otherVendors.push(...(data ?? []));
          }

          if (otherVendors.length > 0) {
            const otherMappings: { vendor_id: string; user_id: string }[] = [];
            for (const batch of chunk(otherVendors.map((v) => v.id), IN_BATCH_SIZE)) {
              const { data, error } = await db
                .from("user_vendor_mapping")
                .select("vendor_id, user_id")
                .in("vendor_id", batch)
                .eq("is_primary", true);
              if (error) throw error;
              otherMappings.push(...(data ?? []));
            }

            const userIdByVendorId = new Map((otherMappings ?? []).map((m) => [m.vendor_id as string, m.user_id as string]));
            const usersByDigits = new Map<string, Set<string>>();
            for (const ov of otherVendors) {
              const uid = userIdByVendorId.get(ov.id as string);
              if (!uid) continue;
              const digits = ov.tax_registration_number_digits as string;
              if (!usersByDigits.has(digits)) usersByDigits.set(digits, new Set());
              usersByDigits.get(digits)!.add(uid);
            }

            const linkRows: { user_id: string; vendor_id: string; company_id: string; is_primary: boolean }[] = [];
            for (const nr of newRowsWithDigits ?? []) {
              const digits = nr.tax_registration_number_digits as string | null;
              if (!digits) continue;
              const candidateUsers = usersByDigits.get(digits);
              if (!candidateUsers || candidateUsers.size === 0) continue;
              if (candidateUsers.size > 1) {
                console.error(
                  `RNC ${digits}: ${candidateUsers.size} cuentas de portal distintas en otras empresas -- no se auto-vincula ${nr.vendor_number} (empresa ${company.name}), revisar manualmente`,
                );
                continue;
              }
              linkRows.push({
                user_id: Array.from(candidateUsers)[0],
                vendor_id: nr.id as string,
                company_id: company.id,
                is_primary: true,
              });
            }

            if (linkRows.length > 0) {
              const { error: linkErr } = await db.from("user_vendor_mapping").insert(linkRows);
              if (linkErr) throw linkErr;
              companyAutoLinked = linkRows.length;
            }
          }
        }
      }

      const newVendors = vendors.filter((v) => !existingNumbers.has(v.number) && v.email);
      let companyInvited = 0;
      let companyInviteFailed = 0;
      let companyInviteSkippedCap = 0;

      if (inviteNewVendors) {
        const vendorIdRows: { id: string; vendor_number: string }[] = [];
        for (const batch of chunk(newVendors.map((v) => v.number), IN_BATCH_SIZE)) {
          const { data, error } = await db
            .from("vendors")
            .select("id, vendor_number")
            .eq("company_id", company.id)
            .in("vendor_number", batch);
          if (error) throw error;
          vendorIdRows.push(...(data ?? []));
        }
        const idByNumber = new Map(vendorIdRows.map((r) => [r.vendor_number, r.id]));

        for (const v of newVendors) {
          if (invited >= MAX_INVITES_PER_RUN) {
            companyInviteSkippedCap = newVendors.length - newVendors.indexOf(v);
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
            companyId: company.id,
            vendorId,
            username: v.displayName,
            siteUrl,
          });
          if (result.ok) {
            invited++;
            companyInvited++;
            invitedEmails.push(v.email);
          } else {
            inviteFailed++;
            companyInviteFailed++;
            console.error(`No se pudo invitar a ${v.email} (vendor ${v.number}, empresa ${company.name}): ${result.error}`);
          }
        }
      }

      vendorsProcessed += vendors.length;
      newVendorsTotal += newVendors.length;
      autoLinkedTotal += companyAutoLinked;
      inviteSkippedCap += companyInviteSkippedCap;
      perCompany.push({
        company: company.name,
        vendorsProcessed: vendors.length,
        newVendors: newVendors.length,
        autoLinked: companyAutoLinked,
        invited: companyInvited,
        inviteFailed: companyInviteFailed,
        inviteSkippedCap: companyInviteSkippedCap,
      });
    }

    await markRan(db, THROTTLE_KEY);

    return new Response(
      JSON.stringify({
        ok: true,
        companiesProcessed: companies.length,
        vendorsProcessed,
        newVendors: newVendorsTotal,
        autoLinked: autoLinkedTotal,
        inviteNewVendors,
        invited,
        invitedEmails,
        inviteFailed,
        inviteSkippedCap,
        maxInvitesPerRun: MAX_INVITES_PER_RUN,
        perCompany,
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
