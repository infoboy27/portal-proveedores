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
import {
  bcListAttachments,
  bcGetAttachmentContent,
  bcListDocumentAttachments,
  bcGetDocumentAttachmentContent,
} from "../_shared/bc-client.ts";

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
      // Los dos mecanismos de adjuntos de BC conviven aca (ver el comentario
      // grande en _shared/bc-client.ts): desde 2026-09-04 el portal escribe
      // en documentAttachments (tabla 1173), pero siguen existiendo adjuntos
      // viejos en /attachments (Incoming Documents) y el equipo de Adsemble
      // puede adjuntar por cualquiera de los dos desde BC. El frontend manda
      // solo el id, asi que probamos el mecanismo nuevo primero y caemos al
      // viejo si ese id no vive ahi -- sin tener que cambiar el contrato.
      let bcRes: Response;
      try {
        bcRes = await bcGetDocumentAttachmentContent(bcCompanyId, parentPath, body.attachmentId);
      } catch {
        bcRes = await bcGetAttachmentContent(bcCompanyId, parentPath, body.attachmentId);
      }
      const contentType = bcRes.headers.get("content-type") ?? "application/octet-stream";
      const fileName = body.fileName ?? "adjunto";
      return new Response(bcRes.body, {
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${fileName.replace(/"/g, "")}"`,
        },
      });
    }

    // Se listan los DOS mecanismos y se muestran juntos: el equipo de
    // Adsemble no distingue (ni tiene por que) entre "Documentos adjuntos" y
    // "Documentos entrantes" al mirar una orden -- quiere ver los archivos.
    // Si uno de los dos falla (el de Incoming Documents viene fallando en
    // ordenes puntuales, justamente), no se cae el listado entero: se
    // devuelve lo que si se pudo leer.
    const [documentAttachments, incomingAttachments] = await Promise.all([
      bcListDocumentAttachments(bcCompanyId, parentPath).catch((err) => {
        console.error(`documentAttachments (${order.order_number}): ${err}`);
        return [];
      }),
      bcListAttachments(bcCompanyId, parentPath).catch((err) => {
        console.error(`attachments/incoming (${order.order_number}): ${err}`);
        return [];
      }),
    ]);

    return new Response(
      JSON.stringify({
        ok: true,
        attachments: [
          // byteSize viene siempre 0 en documentAttachments -- BC no lo
          // calcula en esa vista. Se manda tal cual y la UI lo muestra como
          // "-" en vez de inventar un "0 KB" que seria mentira.
          ...documentAttachments.map((a) => ({
            id: a.id,
            fileName: a.fileName,
            byteSize: a.byteSize,
            lastModifiedDateTime: a.lastModifiedDateTime,
            source: "document" as const,
          })),
          ...incomingAttachments.map((a) => ({
            id: a.id,
            fileName: a.fileName,
            byteSize: a.byteSize,
            lastModifiedDateTime: a.lastModifiedDateTime,
            source: "incoming" as const,
          })),
        ],
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`bc-order-attachments (${order.order_number}): ${reason}`);
    return new Response(JSON.stringify({ ok: false, error: reason }), { status: 500 });
  }
});
