// Multiempresa (Fase 2, 2026-08-29): lista de empresas que el sync debe
// procesar en esta corrida. "Activa" reusa el campo que ya existia
// (companies.disabled_at nullable = activa) -- no hizo falta una columna
// nueva. bc_code ya guarda el GUID real de la empresa en Business Central
// (confirmado: la fila de Adsemble tiene bc_code = el mismo valor que
// antes vivia en la variable de entorno BC_COMPANY_ID).
// deno-lint-ignore no-explicit-any
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface ActiveCompany {
  id: string; // companies.id (uuid interno del portal)
  bcCompanyId: string; // companies.bc_code (GUID real de la empresa en BC)
  name: string;
}

// deno-lint-ignore no-explicit-any
export async function getActiveCompanies(db: SupabaseClient<any>): Promise<ActiveCompany[]> {
  const { data, error } = await db
    .from("companies")
    .select("id, bc_code, company_name")
    .is("disabled_at", null)
    .not("bc_code", "is", null)
    .neq("bc_code", "");
  if (error) throw new Error(`No se pudo leer companies activas: ${error.message}`);
  return (data ?? []).map((c: { id: string; bc_code: string; company_name: string }) => ({
    id: c.id,
    bcCompanyId: c.bc_code,
    name: c.company_name,
  }));
}
