import { useMemo, useState } from "react";
import { useTranslation } from "@/i18n";
import { useSessionStore } from "@/store/session";
import { useDomainStore } from "@/store/domain";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import type { PortalUser, UserRole } from "@/store/types";

const ROLE_LABEL: Record<UserRole, string> = {
  superadmin: "Super admin",
  admin: "Administrador",
  approver: "Analista",
  supplier: "Proveedor",
  service_uploader: "Carga de facturas (interno)",
};

// Reconstruccion de `function VP()` — index-beautified.js:30017.
// "Crear usuario" invita de verdad (2026-08-20, ver invite-user Edge
// Function) — antes de esto solo se podia editar un perfil ya existente,
// porque crear el login real necesita la Admin API (service_role), que no
// se puede invocar de forma segura desde el navegador con la clave anon.
// "Eliminar" es exclusivo de superadmin -- primera capacidad que distingue
// de verdad ese rol de admin (ver docs/BITACORA.md, pedido de Jonatan de
// tener un superusuario real para incidencias).
export function Users() {
  const { t } = useTranslation();
  const session = useSessionStore((s) => s.session);
  const users = useDomainStore((s) => s.users);
  const suppliers = useDomainStore((s) => s.suppliers);
  const updateUser = useDomainStore((s) => s.updateUser);
  const createUser = useDomainStore((s) => s.createUser);
  const deleteUser = useDomainStore((s) => s.deleteUser);

  const isAdmin = session.role === "admin" || session.role === "superadmin";
  const isSuperadmin = session.role === "superadmin";
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<UserRole | "all">("all");
  const [editing, setEditing] = useState<PortalUser | null>(null);
  const [deleting, setDeleting] = useState<PortalUser | null>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const scoped = useMemo(() => (isAdmin ? users : users.filter((u) => u.companyId === session.companyId)), [isAdmin, users, session.companyId]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return scoped.filter((u) => {
      const matchesQuery = query.length === 0 || u.username.toLowerCase().includes(query) || u.email.toLowerCase().includes(query);
      const matchesRole = roleFilter === "all" || u.role === roleFilter;
      return matchesQuery && matchesRole;
    });
  }, [scoped, search, roleFilter]);

  async function handleSave(role: UserRole, companyId: string, isActive: boolean) {
    if (!editing || !session.userId) return;
    setSaving(true);
    try {
      await updateUser(editing.id, session.userId, { role, companyId: companyId || null, isActive });
      setEditing(null);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleting) return;
    setDeleteError(null);
    setSaving(true);
    try {
      await deleteUser(deleting.id);
      setDeleting(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "No fue posible eliminar el usuario.");
    } finally {
      setSaving(false);
    }
  }

  async function handleCreate(input: { email: string; role: UserRole; companyId: string; vendorId: string; username: string }) {
    setCreateError(null);
    setSaving(true);
    try {
      await createUser({
        email: input.email,
        role: input.role,
        companyId: input.companyId || null,
        vendorId: input.vendorId || null,
        username: input.username || undefined,
      });
      setCreating(false);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "No fue posible invitar al usuario.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">{t("users")}</h1>
          <p className="max-w-2xl text-sm leading-6 text-slate-600 sm:text-base">
            Gestión de accesos y roles. Crear un usuario le envía una invitación real por correo.
          </p>
        </div>
        {isAdmin && (
          <Button onClick={() => setCreating(true)}>Crear usuario</Button>
        )}
      </section>

      <Card className="p-4 sm:p-5">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por nombre o correo" className="flex-1" />
          <Select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value as UserRole | "all")} className="xl:w-[240px]">
            <option value="all">Todos los roles</option>
            {(Object.keys(ROLE_LABEL) as UserRole[]).map((role) => (
              <option key={role} value={role}>
                {ROLE_LABEL[role]}
              </option>
            ))}
          </Select>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left">
            <thead className="bg-slate-50/90 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              <tr>
                <th className="px-6 py-4">Usuario</th>
                <th className="px-6 py-4">Correo</th>
                <th className="px-6 py-4">Rol</th>
                <th className="px-6 py-4">Estado</th>
                <th className="px-6 py-4 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.length > 0 ? (
                filtered.map((u) => (
                  <tr key={u.id} className="transition hover:bg-slate-50/80">
                    <td className="px-6 py-4 font-semibold text-slate-950">{u.username || "-"}</td>
                    <td className="px-6 py-4 text-sm text-slate-600">{u.email}</td>
                    <td className="px-6 py-4 text-sm text-slate-600">{ROLE_LABEL[u.role]}</td>
                    <td className="px-6 py-4">
                      <span
                        className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ${
                          u.isActive ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"
                        }`}
                      >
                        {u.isActive ? "Activo" : "Inactivo"}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      {isAdmin && (
                        <Button variant="ghost" onClick={() => setEditing(u)}>
                          Editar
                        </Button>
                      )}
                      {isSuperadmin && u.id !== session.userId && (
                        <Button variant="ghost" onClick={() => setDeleting(u)}>
                          Eliminar
                        </Button>
                      )}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="px-6 py-14 text-center text-sm text-slate-500">
                    {t("emptyState")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Modal open={!!editing} onClose={() => setEditing(null)} title={`Editar usuario`}>
        {editing && (
          <EditUserForm
            key={editing.id}
            user={editing}
            saving={saving}
            onCancel={() => setEditing(null)}
            onSave={handleSave}
          />
        )}
      </Modal>

      <Modal
        open={creating}
        onClose={() => {
          setCreating(false);
          setCreateError(null);
        }}
        title="Crear usuario"
      >
        <CreateUserForm
          suppliers={suppliers}
          saving={saving}
          error={createError}
          onCancel={() => {
            setCreating(false);
            setCreateError(null);
          }}
          onCreate={handleCreate}
        />
      </Modal>

      <Modal
        open={!!deleting}
        onClose={() => {
          setDeleting(null);
          setDeleteError(null);
        }}
        title="Eliminar usuario"
      >
        {deleting && (
          <div className="space-y-4">
            <p className="text-sm text-slate-700">
              Vas a eliminar la cuenta de <strong>{deleting.email}</strong>. Esta acción no se puede deshacer — la
              persona ya no podrá iniciar sesión.
            </p>
            {deleteError && <p className="text-sm text-rose-600">{deleteError}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setDeleting(null);
                  setDeleteError(null);
                }}
                disabled={saving}
              >
                Cancelar
              </Button>
              <Button type="button" variant="danger" onClick={handleDelete} disabled={saving}>
                {saving ? "Eliminando..." : "Eliminar definitivamente"}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function CreateUserForm({
  suppliers,
  saving,
  error,
  onCancel,
  onCreate,
}: {
  suppliers: { id: string; vendorNumber: string; displayName: string }[];
  saving: boolean;
  error: string | null;
  onCancel: () => void;
  onCreate: (input: { email: string; role: UserRole; companyId: string; vendorId: string; username: string }) => void;
}) {
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<UserRole>("supplier");
  const [vendorId, setVendorId] = useState("");
  const companies = useDomainStore((s) => s.companies);
  const [companyId, setCompanyId] = useState("");

  const needsVendor = role === "supplier" || role === "service_uploader";

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        onCreate({ email, role, companyId, vendorId, username });
      }}
    >
      <div>
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Correo</label>
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="correo@dominio.com" required />
      </div>
      <div>
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Nombre (opcional)</label>
        <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Nombre para mostrar" />
      </div>
      <div>
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Rol</label>
        <Select value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
          {(Object.keys(ROLE_LABEL) as UserRole[]).map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </Select>
      </div>
      {needsVendor && (
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Proveedor</label>
          <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)} required>
            <option value="">Selecciona un proveedor</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.displayName} ({s.vendorNumber})
              </option>
            ))}
          </Select>
        </div>
      )}
      <div>
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Empresa</label>
        <Select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
          <option value="">Sin empresa (global)</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>
      {error && <p className="text-sm text-rose-600">{error}</p>}
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancelar
        </Button>
        <Button type="submit" disabled={saving || (needsVendor && !vendorId)}>
          {saving ? "Invitando..." : "Invitar"}
        </Button>
      </div>
    </form>
  );
}

function EditUserForm({
  user,
  saving,
  onCancel,
  onSave,
}: {
  user: PortalUser;
  saving: boolean;
  onCancel: () => void;
  onSave: (role: UserRole, companyId: string, isActive: boolean) => void;
}) {
  const [role, setRole] = useState<UserRole>(user.role);
  const [companyId, setCompanyId] = useState(user.companyId ?? "");
  const [isActive, setIsActive] = useState(user.isActive);
  const companies = useDomainStore((s) => s.companies);

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(role, companyId, isActive);
      }}
    >
      <div>
        <p className="mb-1 text-sm font-medium text-slate-700">{user.email}</p>
      </div>
      <div>
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Rol</label>
        <Select value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
          {(Object.keys(ROLE_LABEL) as UserRole[]).map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Empresa</label>
        <Select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
          <option value="">Sin empresa (global)</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
        Usuario activo
      </label>
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancelar
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? "Guardando..." : "Guardar"}
        </Button>
      </div>
    </form>
  );
}
