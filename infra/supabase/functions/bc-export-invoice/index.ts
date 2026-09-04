// Sincroniza una factura aprobada del portal con la Orden de Compra
// correspondiente en Business Central -- SOLO la seccion General de la
// orden (fecha, Nº factura, NCF) + el PDF como adjunto ahi mismo. Invocada
// desde el boton "Exportar ahora" (Exports.tsx).
//
// Cambio de diseño (2026-09-02, pedido explicito de Jonatan): "El portal
// solo debe alimentar la seccion General de la orden de compra pero NO
// debe crear una factura en el modulo de compras". Hasta el 2026-09-01
// esta funcion creaba ADEMAS una Factura de Compra separada (purchaseInvoices)
// -- eso quedo descartado del todo, no solo "puesto en segundo plano".
// Quien convierte la orden en una Factura de Compra real dentro de BC
// (con "Obtener lineas de pedido"/Get Order Lines, que maneja el vinculo
// nativo y el posteo real) es el equipo de Adsemble, a mano, cuando
// corresponda -- el portal ya le dejo los 3 datos + el PDF puestos en la
// orden para que lo hagan sin tener que pedirselos al proveedor de nuevo.
//
// Esto vuelve mucho mas simple la integracion (ver docs/BITACORA.md):
// desaparece toda la logica de replicar lineas de la orden a mano
// (purchaseInvoiceLines) y el vinculo via PurchInvoiceOrderLinkAPI.al --
// esos existian solo para que la Factura de Compra creada por API se
// comportara como "sacada de la orden" ante el posteo nativo de BC, algo
// que ya no hace falta si BC arma la factura el mismo, de forma nativa,
// desde la orden.
//
// IMPORTANTE (para quien lea esto despues, o decida en el futuro volver a
// crear la Factura de Compra desde el portal): con este cambio, NINGUN
// documento se postea nunca desde el portal -- no hay asiento contable, no
// hay dato para los reportes 606/607/608, no hay registro de pago, hasta
// que alguien en Adsemble arme y postee la factura real en BC a mano. Si
// eso resulta ser un problema operativo, la logica que se saco de aca
// sigue disponible en el historial de git (commit "pedido Key Players --
// 1 OC = 1 Factura...", 2026-09-01) para reactivarla.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { bcPatch, bcPost, bcAttachDocumentFile } from "../_shared/bc-client.ts";

interface ExportRequest {
  invoiceId: string;
  changedBy: string | null;
}

// "export_error" tiene que poder reintentarse (2026-09-03, bug real
// reportado: una factura con un fallo de BC transitorio -- ej. un 404
// puntual del adjunto -- quedaba atrapada para siempre, porque esta misma
// lista era el unico filtro y no la incluia. Sin esto, ni el boton
// "Exportar ahora" ni "Reintentar fallidas" (Exports.tsx) podian volver a
// intentarlo -- la falla se convertia en el motivo por el que nunca se
// podia reintentar.
const EXPORTABLE_STATUSES = new Set(["approved", "ready_for_export", "export_error"]);

function admin() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

async function markError(db: ReturnType<typeof admin>, invoiceId: string, changedBy: string | null, reason: string) {
  await db
    .from("invoices")
    .update({ status: "export_error", export_error_reason: reason })
    .eq("id", invoiceId);
  await db.from("invoice_status_history").insert({
    invoice_id: invoiceId,
    status: "export_error",
    changed_by: changedBy,
    reason,
  });
}

// Grupos de registro de proveedor que NO emiten NCF: el comprobante lo
// emite Adsemble, no el proveedor. Confirmado contra BC (pantalla "Grupos
// registro proveedor": los tres tienen "Permitir emitir NCF" marcado, con
// sus propias series -- ECF PROVIN, ECF GTOMEN, ECF P EX) y contra el
// listado que envio el equipo de Adsemble el 2026-09-04, hoja "Proveedores
// NO emite NCF": "Clasificaciones incluidas: PROVINFORM, GASMENOR e INT"
// -- 1,457 proveedores.
//
// GASMENOR faltaba (2026-09-04). Sin esto, toda factura de un proveedor de
// gasto menor (62 en produccion: cajas chicas, tarjetas corporativas,
// reposiciones de fondo) se caia al exportar con "La factura no tiene NCF",
// pidiendo un dato que ese proveedor por definicion no emite.
const NCF_EXEMPT_POSTING_GROUPS = ["PROVINFORM", "INT", "GASMENOR"];

// Crea la Factura de Compra en BC para una factura del portal que no tiene
// orden de compra. Ver el comentario grande en el punto de llamada.
async function exportInvoiceWithoutOrder(
  db: ReturnType<typeof admin>,
  invoice: Record<string, unknown>,
): Promise<{ bcInvoiceId: string; bcInvoiceNumber: string; attached: boolean }> {
  if (!invoice.vendor_id) {
    throw new Error("La factura no tiene orden de compra NI proveedor asignado -- no hay a nombre de quien crearla en Business Central.");
  }
  if (!invoice.company_id) {
    throw new Error("La factura no tiene empresa asignada -- no se sabe en cual empresa de Business Central crearla.");
  }

  const { data: companyRow, error: companyErr } = await db
    .from("companies")
    .select("bc_code")
    .eq("id", invoice.company_id as string)
    .single();
  if (companyErr || !companyRow?.bc_code) {
    throw new Error(`No se encontro el codigo de BC para la empresa de la factura: ${companyErr?.message}`);
  }
  const bcCompanyId = companyRow.bc_code as string;

  const { data: vendor, error: vendorErr } = await db
    .from("vendors")
    .select("*")
    .eq("id", invoice.vendor_id as string)
    .single();
  if (vendorErr || !vendor) throw new Error(`Proveedor no encontrado: ${vendorErr?.message}`);
  if (!vendor.vendor_number) {
    throw new Error("El proveedor no tiene numero de Business Central (vendor_number) -- correr bc-sync-vendors primero.");
  }

  const ncfExempt = NCF_EXEMPT_POSTING_GROUPS.includes(vendor.vendor_posting_group);
  if (!ncfExempt && !invoice.invoice_tax_number) {
    throw new Error("La factura no tiene NCF (invoice_tax_number) -- sin ese dato Business Central no la deja postear.");
  }
  if (!invoice.invoice_date) {
    throw new Error("La factura no tiene fecha -- es obligatoria para crear el documento en Business Central.");
  }

  // 1. Cabecera. postingDate = invoiceDate: el portal no decide periodos
  // contables, y dejarla vacia hace que BC use la fecha de trabajo del
  // usuario de servicio, que no tiene relacion con la factura.
  const created = await bcPost<{ id: string; number: string }>(bcCompanyId, "/purchaseInvoices", {
    vendorNumber: vendor.vendor_number,
    invoiceDate: invoice.invoice_date,
    postingDate: invoice.invoice_date,
    vendorInvoiceNumber: invoice.invoice_number ?? invoice.invoice_tax_number,
  });

  // 2. NCF, via el custom API propio (page 58004) -- no esta en la API
  // estandar. expenseClassCode no se toca: en el flujo con orden viene de
  // la orden, y aca no hay orden de donde sacarlo; lo elige Adsemble al
  // completar la factura en BC.
  if (invoice.invoice_tax_number) {
    await bcPatch(
      bcCompanyId,
      `/purchaseInvoiceFiscals(${created.id})`,
      { fiscalDocumentNo: invoice.invoice_tax_number },
      "custom",
    );
  }

  // 3. El PDF, por el mismo mecanismo que ya usamos en las ordenes
  // (documentAttachments, tabla 1173) -- verifica el contenido releyendolo,
  // asi que si no queda adjunto de verdad, esto lanza y la factura NO se
  // marca exportada.
  let attached = false;
  if (invoice.file_path) {
    const { data: fileBlob, error: downloadErr } = await db.storage.from("invoices").download(invoice.file_path as string);
    if (downloadErr) throw new Error(`No se pudo leer el PDF de Storage: ${downloadErr.message}`);
    const bytes = new Uint8Array(await fileBlob.arrayBuffer());
    await bcAttachDocumentFile(
      bcCompanyId,
      `/purchaseInvoices(${created.id})`,
      (invoice.filename as string) ?? "factura.pdf",
      bytes,
      "application/pdf",
      "Purchase Invoice",
    );
    attached = true;
  }

  return { bcInvoiceId: created.id, bcInvoiceNumber: created.number, attached };
}

Deno.serve(async (req: Request) => {
  const db = admin();

  // Encontrado en la ronda de pruebas de Key Players (2026-09-01, item 8:
  // "nunca confiar en el vendorId/rol que mande el frontend"): a diferencia
  // de invite-user/delete-user/reset-user-password, esta funcion nunca
  // habia validado quien la llama -- cualquiera con la clave anon (sin
  // sesion, sin rol de aprobador) podia invocarla directo. Exports.tsx solo
  // la ofrece a admin/superadmin/approver (exports.read en ROLE_FEATURES),
  // asi que el backend tiene que exigir lo mismo.
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ ok: false, error: "Falta el token de quien pide la exportacion" }), { status: 401 });
  }
  const { data: callerAuth, error: callerAuthErr } = await db.auth.getUser(authHeader.replace("Bearer ", ""));
  if (callerAuthErr || !callerAuth.user) {
    return new Response(JSON.stringify({ ok: false, error: "Token invalido o expirado" }), { status: 401 });
  }
  const { data: callerProfile } = await db.from("user_profiles").select("role").eq("id", callerAuth.user.id).maybeSingle();
  if (!callerProfile || !["admin", "superadmin", "approver"].includes(callerProfile.role as string)) {
    return new Response(JSON.stringify({ ok: false, error: "Solo un administrador o aprobador puede exportar a Business Central" }), {
      status: 403,
    });
  }

  let body: ExportRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "Body invalido" }), { status: 400 });
  }
  if (!body.invoiceId) {
    return new Response(JSON.stringify({ ok: false, error: "Falta invoiceId" }), { status: 400 });
  }

  try {
    const { data: invoice, error: invErr } = await db.from("invoices").select("*").eq("id", body.invoiceId).single();
    if (invErr || !invoice) throw new Error(`Factura no encontrada: ${invErr?.message}`);

    if (!EXPORTABLE_STATUSES.has(invoice.status)) {
      return new Response(
        JSON.stringify({ ok: false, error: `La factura esta en estado "${invoice.status}", no se puede exportar` }),
        { status: 400 },
      );
    }

    // === Factura SIN orden de compra ===
    //
    // Hasta el 2026-09-04 esto era un error duro ("Sin orden de compra
    // vinculada") y la factura quedaba trabada para siempre. El portal si
    // permitia cargarla (opcion "Sin orden de compra" en Invoices.tsx), asi
    // que era un camino a medio construir.
    //
    // Lo destapo el listado real que envio el equipo de Adsemble
    // (2026-09-04, hoja "Proveedores emiten NCF sin ODC"): 30 proveedores
    // que facturan sin orden de compra, y no son marginales -- son los
    // servicios recurrentes que facturan todos los meses (Claro, EDESUR,
    // acueducto, ayuntamiento, seguros, seguridad, limpieza, combustible).
    // Jonatan eligio la opcion A: que el portal cree la Factura de Compra
    // en BC para estos casos.
    //
    // Esto NO contradice la decision del 2026-09-02 ("el portal no crea
    // facturas de compra, solo alimenta la seccion General de la orden"):
    // esa decision resolvia el caso en que SI hay una orden que alimentar.
    // Aca no hay ninguna, asi que no hay donde dejar los datos ni el PDF.
    //
    // Se crea la CABECERA de la factura con los datos que el portal si
    // conoce (proveedor, fechas, Nº de factura, NCF) y se le adjunta el
    // PDF. Las lineas NO se crean a proposito: la cuenta contable, el ITBIS
    // y la clasificacion de gasto son decisiones contables de Adsemble, y
    // las lineas que trae el OCR de un PDF no son confiables para eso
    // (se ha visto leer el telefono del proveedor como un importe). Igual
    // que en el flujo con orden, el portal deja los datos y el documento
    // puestos; quien completa y postea en BC es Adsemble.
    if (!invoice.purchase_order_id) {
      const result = await exportInvoiceWithoutOrder(db, invoice);
      await db
        .from("invoices")
        .update({
          status: "exported",
          bc_invoice_id: result.bcInvoiceId,
          bc_invoice_number: result.bcInvoiceNumber,
          exported_at: new Date().toISOString(),
          export_error_reason: null,
        })
        .eq("id", invoice.id);
      await db.from("invoice_status_history").insert({
        invoice_id: invoice.id,
        status: "exported",
        changed_by: body.changedBy,
        reason: null,
      });
      return new Response(
        JSON.stringify({
          ok: true,
          withoutOrder: true,
          bcInvoiceNumber: result.bcInvoiceNumber,
          attached: result.attached,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    const { data: order, error: orderErr } = await db
      .from("purchase_orders")
      .select("*")
      .eq("id", invoice.purchase_order_id)
      .single();
    if (orderErr || !order) throw new Error(`Orden de compra no encontrada: ${orderErr?.message}`);

    if (!order.bc_id) {
      await markError(
        db,
        invoice.id,
        body.changedBy,
        "La orden de compra vinculada aun no esta sincronizada con Business Central (falta bc_id)",
      );
      return new Response(JSON.stringify({ ok: false, error: "Orden sin bc_id — correr bc-sync-orders primero" }), {
        status: 422,
      });
    }

    // Multiempresa (Fase 2, 2026-08-29): el GUID real de la empresa en BC
    // ya no viene de una variable de entorno fija -- se resuelve a partir
    // de la empresa de la orden (order.company_id), via companies.bc_code.
    const { data: companyRow, error: companyErr } = await db
      .from("companies")
      .select("bc_code")
      .eq("id", order.company_id)
      .single();
    if (companyErr || !companyRow?.bc_code) {
      throw new Error(`No se encontro el codigo de BC para la empresa de la orden: ${companyErr?.message}`);
    }
    const bcCompanyId = companyRow.bc_code as string;

    // NCF -- sigue siendo obligatorio salvo proveedores informales/
    // extranjeros (PROVINFORM/INT, vendor_posting_group sincronizado por
    // bc-sync-vendors). Ya no es "obligatorio para que BC postee" (nada se
    // postea desde aca) -- es un dato fiscal que no tiene sentido dejar a
    // medias en la orden.
    const { data: vendor, error: vendorErr } = await db.from("vendors").select("*").eq("id", order.vendor_id).single();
    if (vendorErr || !vendor) throw new Error(`Proveedor no encontrado: ${vendorErr?.message}`);
    const ncfExempt = NCF_EXEMPT_POSTING_GROUPS.includes(vendor.vendor_posting_group);
    if (!ncfExempt && !invoice.invoice_tax_number) {
      throw new Error(`La factura no tiene NCF (invoice_tax_number) -- no se puede reflejar en la Orden de Compra sin ese dato.`);
    }

    // 1. "Fecha emision documento" -- campo ESTANDAR de la API v2.0 de
    // purchaseOrders (confirmado en vivo: orderDate de CP-000221 =
    // 2026-09-01 = "1/9/2026" visto en la orden real) -- se patchea
    // directo, sin custom API.
    if (invoice.invoice_date) {
      await bcPatch(bcCompanyId, `/purchaseOrders(${order.bc_id})`, { orderDate: invoice.invoice_date });
    }

    // 2. "Nº factura proveedor" (Vendor Invoice No.) + NCF (DSNNo.
    // Comprobante Fiscal) -- ninguno de los dos esta en la API estandar,
    // via el custom API purchaseOrderFiscals (page 58006, extendido
    // 2026-09-01 -- ver infra/business-central/README.md).
    const fiscalPatch: Record<string, string> = {};
    if (invoice.invoice_number) fiscalPatch.vendorInvoiceNumber = invoice.invoice_number;
    if (invoice.invoice_tax_number) fiscalPatch.fiscalDocumentNo = invoice.invoice_tax_number;
    if (Object.keys(fiscalPatch).length > 0) {
      await bcPatch(bcCompanyId, `/purchaseOrderFiscals(${order.bc_id})`, fiscalPatch, "custom");
    }

    // 3. Adjuntar el PDF de la factura a la ORDEN (Documentos adjuntos), si
    // ya fue subido a Storage.
    //
    // 2026-09-04: cambiado de /attachments a /documentAttachments. El
    // primero (Incoming Document Attachment, tabla 133) resulto estar roto
    // en este tenant: devolvia 204 en el PATCH y el archivo despues no
    // estaba, y ademas dejaba la orden en un estado donde todo adjunto
    // posterior fallaba con 404 -- pasaba tambien adjuntando a mano dentro
    // de BC, o sea que no era nuestro codigo. /documentAttachments (tabla
    // 1173, el FactBox de siempre) funciona sin problema sobre las MISMAS
    // ordenes rotas, verificado byte a byte. Detalle completo en
    // _shared/bc-client.ts y en .gstack/qa-reports/bc-support-cp229-attachments.md.
    //
    // bcAttachDocumentFile ademas relee el archivo desde BC y falla si el
    // tamaño no coincide -- asi nunca mas marcamos "Exportada" una factura
    // cuyo PDF no quedo realmente en la orden.
    let attached = false;
    if (invoice.file_path) {
      const { data: fileBlob, error: downloadErr } = await db.storage.from("invoices").download(invoice.file_path);
      if (downloadErr) throw new Error(`No se pudo leer el PDF de Storage: ${downloadErr.message}`);
      const bytes = new Uint8Array(await fileBlob.arrayBuffer());
      await bcAttachDocumentFile(
        bcCompanyId,
        `/purchaseOrders(${order.bc_id})`,
        invoice.filename ?? "factura.pdf",
        bytes,
        "application/pdf",
      );
      attached = true;
    }

    // "exported" (no "processed"): ya estaba en el enum de estados y la UI
    // ya lo trata igual que "processed" en todos lados (badges, stats,
    // Dashboard/Companies excluyendolo de "abiertas") -- no hizo falta
    // tocar ninguna pantalla. Se reserva "processed" para cuando (si)
    // vuelva a existir un documento real posteado en BC. bc_invoice_id/
    // bc_invoice_number quedan null a proposito -- no hay ningun
    // documento de factura que referenciar.
    const { error: updateErr } = await db
      .from("invoices")
      .update({
        status: "exported",
        bc_invoice_id: null,
        bc_invoice_number: null,
        exported_at: new Date().toISOString(),
        export_error_reason: null,
      })
      .eq("id", invoice.id);
    if (updateErr) throw new Error(`Orden actualizada en BC pero no se pudo actualizar la factura en Supabase: ${updateErr.message}`);

    await db.from("invoice_status_history").insert({
      invoice_id: invoice.id,
      status: "exported",
      changed_by: body.changedBy,
      reason: null,
    });

    return new Response(
      JSON.stringify({ ok: true, orderNumber: order.order_number, attached }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(reason);
    await markError(db, body.invoiceId, body.changedBy, reason);
    return new Response(JSON.stringify({ ok: false, error: reason }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
