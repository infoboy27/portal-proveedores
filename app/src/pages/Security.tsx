import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

const formatDate = (value: string) => (value ? new Date(value).toLocaleString("es-DO") : "-");

const EVENT_LABEL: Record<string, string> = {
  user_invited: "Usuario invitado",
  user_role_changed: "Rol cambiado",
  user_deactivated: "Usuario desactivado",
  user_reactivated: "Usuario reactivado",
  user_deleted: "Usuario eliminado",
  user_profile_updated: "Perfil actualizado",
  password_reset_requested: "Reset de password enviado",
  sync_interval_changed: "Intervalo de sync cambiado",
};

// Claves de system_settings (schema-v10.sql) en el orden que se muestran.
const SYNC_INTERVAL_KEYS: { key: string; label: string }[] = [
  { key: "sync_orders_interval_minutes", label: "Órdenes de compra" },
  { key: "sync_receipts_interval_minutes", label: "Recepciones" },
  { key: "sync_payments_interval_minutes", label: "Pagos" },
  { key: "sync_vendors_interval_minutes", label: "Proveedores" },
];

interface SyncIntervalRow {
  key: string;
  value_minutes: number;
  last_run_at: string | null;
}

interface AuditRow {
  id: string;
  event_type: string;
  target_email: string | null;
  created_at: string;
}

interface AuthEventRow {
  event_at: string;
  action: string;
  actor_email: string | null;
  ip_address: string | null;
}

// Panel de seguridad/incidencias (2026-08-20) — exclusivo de superadmin,
// pedido explicito de Jonatan tras el incidente de los 26 proveedores
// invitados por error: "deberia haber un superusuario para esos fines".
// Dos fuentes, complementarias (ver schema-v9.sql):
//  - security_audit_log: acciones de negocio (quien invito/cambio de rol/
//    desactivo/elimino a quien) — la llenan las RPCs/Edge Functions.
//  - rpc_recent_auth_events: auth.audit_log_entries de GoTrue (login/
//    logout/cambio de password) — YA lo llena Supabase Auth solo, esto solo
//    lo expone de forma controlada.
// No pasa por el domain store (fetchAll) a proposito: es sensible, poco
// frecuente, y solo la ve un rol — no tiene sentido cargarlo para todos.
export function Security() {
  const [auditLog, setAuditLog] = useState<AuditRow[]>([]);
  const [authEvents, setAuthEvents] = useState<AuthEventRow[]>([]);
  const [intervals, setIntervals] = useState<SyncIntervalRow[]>([]);
  const [intervalDrafts, setIntervalDrafts] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [intervalError, setIntervalError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadIntervals() {
    const { data, error: err } = await supabase
      .from("system_settings")
      .select("key, value_minutes, last_run_at")
      .in("key", SYNC_INTERVAL_KEYS.map((k) => k.key));
    if (err) {
      setIntervalError(err.message);
      return;
    }
    const rows = (data ?? []) as SyncIntervalRow[];
    setIntervals(rows);
    setIntervalDrafts(Object.fromEntries(rows.map((r) => [r.key, String(r.value_minutes)])));
  }

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      const [auditRes, authRes] = await Promise.all([
        supabase.from("security_audit_log").select("id, event_type, target_email, created_at").order("created_at", { ascending: false }).limit(100),
        supabase.rpc("rpc_recent_auth_events", { p_limit: 100 }),
      ]);
      if (auditRes.error) setError(auditRes.error.message);
      else if (authRes.error) setError(authRes.error.message);
      setAuditLog((auditRes.data ?? []) as AuditRow[]);
      setAuthEvents((authRes.data ?? []) as AuthEventRow[]);
      setLoading(false);
      await loadIntervals();
    }
    load();
  }, []);

  async function handleSaveInterval(key: string) {
    const minutes = Number(intervalDrafts[key]);
    setIntervalError(null);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      setIntervalError("El intervalo debe ser un número entero entre 1 y 1440 minutos.");
      return;
    }
    setSavingKey(key);
    try {
      const { error: err } = await supabase.rpc("rpc_update_sync_interval", { p_key: key, p_minutes: minutes });
      if (err) throw err;
      await loadIntervals();
    } catch (err) {
      setIntervalError(err instanceof Error ? err.message : "No se pudo actualizar el intervalo.");
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">Superadmin</p>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">Seguridad</h1>
        <p className="max-w-2xl text-sm leading-6 text-slate-600 sm:text-base">
          Quién hizo qué en la aplicación, y el historial de inicios de sesión.
        </p>
      </section>

      {error && <p className="text-sm text-rose-600">{error}</p>}

      <Card className="overflow-hidden p-0">
        <div className="border-b border-slate-100 px-5 py-5">
          <h2 className="text-lg font-semibold text-slate-950">Intervalos de sincronización con Business Central</h2>
          <p className="mt-1 text-sm text-slate-600">
            Cada cuántos minutos se trae órdenes, recepciones, pagos y proveedores. El piso real es el ciclo del
            servidor (1 min) — un valor menor a eso no corre más seguido que eso.
          </p>
        </div>
        <div className="divide-y divide-slate-100 px-5">
          {SYNC_INTERVAL_KEYS.map(({ key, label }) => {
            const row = intervals.find((r) => r.key === key);
            return (
              <div key={key} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-semibold text-slate-900">{label}</p>
                  <p className="text-xs text-slate-500">
                    Última corrida: {row?.last_run_at ? formatDate(row.last_run_at) : "todavía no ha corrido"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    max={1440}
                    value={intervalDrafts[key] ?? ""}
                    onChange={(e) => setIntervalDrafts((d) => ({ ...d, [key]: e.target.value }))}
                    className="w-24"
                  />
                  <span className="text-sm text-slate-500">min</span>
                  <Button
                    variant="ghost"
                    disabled={savingKey === key || intervalDrafts[key] === String(row?.value_minutes ?? "")}
                    onClick={() => handleSaveInterval(key)}
                  >
                    {savingKey === key ? "Guardando..." : "Guardar"}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
        {intervalError && <p className="px-5 pb-4 text-sm text-rose-600">{intervalError}</p>}
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="border-b border-slate-100 px-5 py-5">
          <h2 className="text-lg font-semibold text-slate-950">Acciones administrativas</h2>
          <p className="mt-1 text-sm text-slate-600">Invitaciones, cambios de rol, desactivaciones y eliminaciones.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left">
            <thead className="bg-slate-50/90 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              <tr>
                <th className="px-5 py-4">Cuándo</th>
                <th className="px-5 py-4">Qué</th>
                <th className="px-5 py-4">Sobre</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={3} className="px-5 py-10 text-center text-sm text-slate-500">
                    Cargando...
                  </td>
                </tr>
              ) : auditLog.length > 0 ? (
                auditLog.map((row) => (
                  <tr key={row.id}>
                    <td className="px-5 py-4 text-sm text-slate-600">{formatDate(row.created_at)}</td>
                    <td className="px-5 py-4 text-sm font-semibold text-slate-900">
                      {EVENT_LABEL[row.event_type] ?? row.event_type}
                    </td>
                    <td className="px-5 py-4 text-sm text-slate-600">{row.target_email ?? "-"}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={3} className="px-5 py-10 text-center text-sm text-slate-500">
                    Sin eventos todavía.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="border-b border-slate-100 px-5 py-5">
          <h2 className="text-lg font-semibold text-slate-950">Sesiones</h2>
          <p className="mt-1 text-sm text-slate-600">
            Quién entró y salió, y cuándo — registrado automáticamente por el sistema de autenticación.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left">
            <thead className="bg-slate-50/90 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              <tr>
                <th className="px-5 py-4">Cuándo</th>
                <th className="px-5 py-4">Evento</th>
                <th className="px-5 py-4">Usuario</th>
                <th className="px-5 py-4">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={4} className="px-5 py-10 text-center text-sm text-slate-500">
                    Cargando...
                  </td>
                </tr>
              ) : authEvents.length > 0 ? (
                authEvents.map((row, i) => (
                  <tr key={i}>
                    <td className="px-5 py-4 text-sm text-slate-600">{formatDate(row.event_at)}</td>
                    <td className="px-5 py-4 text-sm text-slate-900">{row.action}</td>
                    <td className="px-5 py-4 text-sm text-slate-600">{row.actor_email ?? "-"}</td>
                    <td className="px-5 py-4 text-sm text-slate-500">{row.ip_address || "-"}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4} className="px-5 py-10 text-center text-sm text-slate-500">
                    Sin eventos todavía.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
