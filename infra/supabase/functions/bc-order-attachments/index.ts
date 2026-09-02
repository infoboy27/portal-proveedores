// Adjuntos de la Orden de Compra en Business Central (Key Players,
// 2026-09-01, item 5). Lectura -- lista los archivos que el equipo de
// Adsemble ya adjunto en BC sobre la orden (ver captura de Jonatan,
// datosadjuntos.png) y permite descargar/ver cada uno. Usa /attachments,
// un sub-recurso de la API ESTANDAR v2.0 (confirmado en vivo contra
// purchaseOrders reales) -- no depende de ninguna extension AL propia, a
// diferencia de purchaseOrderFiscals.
//
// No usa RLS via anon-key -- mismo patron que invite-user/delete-user/
// reset-user-password: valida el rol/alcance de quien llama a mano contra
// la base con el cliente service_role, nunca confia en lo que mande el
// cliente. El "alcance" aca es el mismo que ya define "scoped read" de
// purchase_orders (schema-v3.sql): admin/superadmin ven cualquier orden;
// approver solo las de su empresa; supplier/service_uploader solo las de
// sus propios vendor_id (via user_vendor_mapping).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { bcListAttachments, bcGetAttachmentContent } from "../_shared/bc-client.ts";

interface RequestBody {
  orderId: string;
  action?: "list" | "download";
  attachmentId?: string;
  fileName?: string; // solo para action=download, para el Content-Disposition
}

function admin() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

Deno.serve(async (req: Request) => {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ ok: false, error: "Falta el token de quien pide los adjuntos" }), { status: 401 });
  }

  const db = admin();
  const { data: callerAuth, error: callerAuthErr } = await db.auth.getUser(authHeader.replace("Bearer ", ""));
  if (callerAuthErr || !callerAuth.user) {
    return new Response(JSON.stringify({ ok: false, error: "Token invalido o expirado" }), { status: 401 });
  }

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "Body invalido" }), { status: 400 });
  }
  if (!body.orderId) {
    return new Response(JSON.stringify({ ok: false, error: "Falta orderId" }), { status: 400 });
  }

  const { data: order, error: orderErr } = await db
    .from("purchase_orders")
    .select("id, bc_id, order_number, company_id, vendor_id")
    .eq("id", body.orderId)
    .maybeSingle();
  if (orderErr || !order) {
    return new Response(JSON.stringify({ ok: false, error: "Orden de compra no encontrada" }), { status: 404 });
  }

  const { data: callerProfile } = await db
    .from("user_profiles")
    .select("role, company_id")
    .eq("id", callerAuth.user.id)
    .maybeSingle();
  const role = callerProfile?.role as string | undefined;

  let authorized = role === "admin" || role === "superadmin";
  if (!authorized && role === "approver") {
    authorized = order.company_id === callerProfile?.company_id;
  }
  if (!authorized && (role === "supplier" || role === "service_uploader")) {
    const { data: mapping } = await db
      .from("user_vendor_mapping")
      .select("vendor_id")
      .eq("user_id", callerAuth.user.id)
      .eq("vendor_id", order.vendor_id)
      .maybeSingle();
    authorized = !!mapping;
  }
  if (!authorized) {
    return new Response(JSON.stringify({ ok: false, error: "No tenes acceso a esta orden de compra" }), { status: 403 });
  }

  if (!order.bc_id) {
    return new Response(
      JSON.stringify({ ok: false, error: "Esta orden todavia no esta sincronizada con Business Central (falta bc_id)" }),
      { status: 422 },
    );
  }

  const { data: companyRow, error: companyErr } = await db
    .from("companies")
    .select("bc_code")
    .eq("id", order.company_id)
    .maybeSingle();
  if (companyErr || !companyRow?.bc_code) {
    return new Response(JSON.stringify({ ok: false, error: "No se encontro el codigo de BC para la empresa de la orden" }), {
      status: 500,
    });
  }
  const bcCompanyId = companyRow.bc_code as string;
  const parentPath = `/purchaseOrders(${order.bc_id})`;

  try {
    if (body.action === "download") {
      if (!body.attachmentId) {
        return new Response(JSON.stringify({ ok: false, error: "Falta attachmentId" }), { status: 400 });
      }
      const bcRes = await bcGetAttachmentContent(bcCompanyId, parentPath, body.attachmentId);
      const contentType = bcRes.headers.get("content-type") ?? "application/octet-stream";
      const fileName = body.fileName ?? "adjunto";
      return new Response(bcRes.body, {
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${fileName.replace(/"/g, "")}"`,
        },
      });
    }

    const attachments = await bcListAttachments(bcCompanyId, parentPath);
    return new Response(
      JSON.stringify({
        ok: true,
        attachments: attachments.map((a) => ({
          id: a.id,
          fileName: a.fileName,
          byteSize: a.byteSize,
          lastModifiedDateTime: a.lastModifiedDateTime,
        })),
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`bc-order-attachments (${order.order_number}): ${reason}`);
    return new Response(JSON.stringify({ ok: false, error: reason }), { status: 500 });
  }
});
