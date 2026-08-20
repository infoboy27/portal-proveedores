// Logica compartida de aprovisionar un login nuevo: invita por correo real
// (Admin API, plantilla con marca Adsemble) + crea user_profiles +
// user_vendor_mapping si aplica. La usan:
//  - invite-user (disparado desde Users.tsx por un admin, valida su rol antes de llamar esto)
//  - bc-sync-vendors (disparado por la sync de BC, sin caller externo que autorizar)
//
// Separado de invite-user/index.ts para que bc-sync-vendors no tenga que
// simular ser "un admin llamando" -- solo comparten el como aprovisionar,
// no el quien puede pedirlo.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type PortalRole = "admin" | "superadmin" | "approver" | "supplier" | "service_uploader";

export interface ProvisionUserInput {
  email: string;
  role: PortalRole;
  companyId?: string | null;
  vendorId?: string | null;
  username?: string;
  siteUrl?: string;
  // Quien lo pidio -- null cuando lo dispara la sync de BC (bc-sync-vendors),
  // no un admin humano. Se registra en security_audit_log de cualquier forma;
  // el actor null es la senal de "automatico", no un dato faltante.
  actorUserId?: string | null;
}

export interface ProvisionUserResult {
  ok: boolean;
  userId?: string;
  error?: string;
}

// deno-lint-ignore no-explicit-any
export async function provisionInvitedUser(db: SupabaseClient<any>, input: ProvisionUserInput): Promise<ProvisionUserResult> {
  const email = input.email.trim().toLowerCase();

  const { data: invited, error: inviteErr } = await db.auth.admin.inviteUserByEmail(email, {
    redirectTo: input.siteUrl ? `${input.siteUrl}/set-password` : undefined,
  });
  if (inviteErr || !invited?.user) {
    return { ok: false, error: inviteErr?.message ?? "No se pudo invitar al usuario" };
  }

  const { error: profileErr } = await db.from("user_profiles").insert({
    id: invited.user.id,
    username: input.username?.trim() || email.split("@")[0],
    email,
    role: input.role,
    company_id: input.companyId ?? null,
    active: true,
  });
  if (profileErr) {
    await db.auth.admin.deleteUser(invited.user.id);
    return { ok: false, error: `No se pudo crear el perfil: ${profileErr.message}` };
  }

  if (input.vendorId) {
    const { error: mapErr } = await db.from("user_vendor_mapping").insert({
      user_id: invited.user.id,
      vendor_id: input.vendorId,
      company_id: input.companyId ?? null,
      is_primary: true,
    });
    if (mapErr) {
      console.error(`user_vendor_mapping insert fallo para ${invited.user.id}/${input.vendorId}: ${mapErr.message}`);
    }
  }

  await db.from("security_audit_log").insert({
    event_type: "user_invited",
    actor_user_id: input.actorUserId ?? null,
    target_user_id: invited.user.id,
    target_email: email,
    detail: { role: input.role, vendorId: input.vendorId ?? null, companyId: input.companyId ?? null },
  });

  return { ok: true, userId: invited.user.id };
}
