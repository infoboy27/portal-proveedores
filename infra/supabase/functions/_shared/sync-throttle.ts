// Throttle de sync parametrizable (2026-08-24) -- ver schema-v10.sql. El
// crontab del servidor corre cada 5 min (el "tick" fino); cada job de sync
// llama shouldRun() al entrar y sale temprano si todavia no le toca segun
// el intervalo configurado en system_settings. markRan() se llama al
// terminar exitosamente, nunca si el sync tiro error -- asi un fallo no
// hace que el proximo tick lo salte creyendo que ya corrio.
// deno-lint-ignore no-explicit-any
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export async function shouldRun(db: SupabaseClient<any>, key: string): Promise<boolean> {
  const { data } = await db.from("system_settings").select("value_minutes, last_run_at").eq("key", key).maybeSingle();
  if (!data) return true; // parametro no configurado -- no bloquear el sync por eso
  if (!data.last_run_at) return true;
  const dueAt = new Date(data.last_run_at).getTime() + data.value_minutes * 60_000;
  return Date.now() >= dueAt;
}

export async function markRan(db: SupabaseClient<any>, key: string): Promise<void> {
  await db.from("system_settings").update({ last_run_at: new Date().toISOString() }).eq("key", key);
}
