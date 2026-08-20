import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Card } from "@/components/ui/Card";

const formatDate = (value: string) => (value ? new Date(value).toLocaleString("es-DO") : "-");

const EVENT_LABEL: Record<string, string> = {
  user_invited: "Usuario invitado",
  user_role_changed: "Rol cambiado",
  user_deactivated: "Usuario desactivado",
  user_reactivated: "Usuario reactivado",
  user_deleted: "Usuario eliminado",
  user_profile_updated: "Perfil actualizado",
};

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    }
    load();
  }, []);

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
