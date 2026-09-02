// Exporta una factura aprobada a Business Central "sobre la plantilla de la
// orden de compra correspondiente": cabecera (fecha de factura + NCF/vendor
// invoice number), lineas copiadas de la PO ya sincronizada, y el PDF como
// adjunto. Invocada desde el boton "Exportar ahora" (Exports.tsx). Ver plan
// Fase A: la API v2.0 de BC no tiene "crear factura desde orden" por REST,
// asi que replicamos ese comportamiento copiando purchaseOrderLines ->
// purchaseInvoiceLines a mano.
//
// Vinculo real con la orden (2026-08-30): copiar los numeros no basta para
// que BC trate la factura como "sacada de la orden" -- confirmado en /qa
// que la orden de compra no reflejaba nada en su seccion "Detalles Factura"
// porque la factura creada por este flujo no tenia "Order No."/"Order Line
// No." en sus lineas (los campos que la funcion nativa "Obtener lineas de
// pedido" completa, y que la codeunit de posteo de BC usa para actualizar
// "Quantity Invoiced" en la orden al momento de postear). Se agrega un
// PATCH por linea contra el custom API PurchInvoiceOrderLinkAPI.al para
// poner esos dos campos -- no fatal si falla (la factura ya quedo creada y
// usable, solo sin el vinculo nativo), pero se cuenta y se reporta.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { bcPost, bcPatch, bcAttachFile } from "../_shared/bc-client.ts";

// La linea sin publicar de una factura de compra en BC — solo los campos
// que interesan aca. Ver PurchInvoiceOrderLinkAPI.al.
interface CreatedInvoiceLine {
  id: string;
}

interface ExportRequest {
  invoiceId: string;
  changedBy: string | null;
}

const EXPORTABLE_STATUSES = new Set(["approved", "ready_for_export"]);

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

Deno.serve(async (req: Request) => {
  const db = admin();

  // Encontrado en la ronda de pruebas de Key Players (2026-09-01, item 8:
  // "nunca confiar en el vendorId/rol que mande el frontend"): a diferencia
  // de invite-user/delete-user/reset-user-password, esta funcion nunca
  // habia validado quien la llama -- cualquiera con la clave anon (sin
  // sesion, sin rol de aprobador) podia invocarla directo y crear una
  // factura real en BC. Exports.tsx solo la ofrece a admin/superadmin/
  // approver (exports.read en ROLE_FEATURES), asi que el backend tiene que
  // exigir lo mismo, no confiar en que la UI oculte el boton.
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

    if (!invoice.purchase_order_id) {
      await markError(db, invoice.id, body.changedBy, "La factura no tiene una orden de compra vinculada");
      return new Response(JSON.stringify({ ok: false, error: "Sin orden de compra vinculada" }), { status: 422 });
    }

    const { data: order, error: orderErr } = await db
      .from("purchase_orders")
      .select("*")
      .eq("id", invoice.purchase_order_id)
      .single();
    if (orderErr || !order) throw new Error(`Orden de compra no encontrada: ${orderErr?.message}`);

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

    const { data: vendor, error: vendorErr } = await db.from("vendors").select("*").eq("id", order.vendor_id).single();
    if (vendorErr || !vendor) throw new Error(`Proveedor no encontrado: ${vendorErr?.message}`);

    const { data: lines, error: linesErr } = await db
      .from("purchase_orders_lines")
      .select("*")
      .eq("order_id", order.id)
      .order("sequence", { ascending: true });
    if (linesErr) throw new Error(`No se pudieron leer las lineas de la orden: ${linesErr.message}`);

    // 1. Cabecera de la factura en BC. `orderId` es de solo lectura en la API
    // v2.0 (confirmado en sandbox: "Control 'orderId' is read-only") — no se
    // puede setear en la creacion. El vinculo real con la orden se logra
    // linea por linea en el paso 2 (Order No./Order Line No. via el custom
    // API), no en la cabecera.
    const created = await bcPost<{ id: string; number: string }>(bcCompanyId, "/purchaseInvoices", {
      vendorNumber: vendor.vendor_number,
      invoiceDate: invoice.invoice_date,
      postingDate: invoice.invoice_date,
      vendorInvoiceNumber: invoice.invoice_tax_number ?? invoice.invoice_number,
    });

    // 2. Copiar lineas de la PO (guardadas por bc-sync-orders) a la factura.
    // Si una linea no tiene bc_line_object_number (ej. una linea tipo
    // "Account" creada en BC sin cuenta contable real asignada) no se puede
    // replicar en BC y se omite — pero si TODAS se omiten, la factura queda
    // creada en BC con monto RD$0.00 y sin vinculo real a la orden, y sin
    // esta verificacion el export se marcaba "processed" como si hubiera
    // funcionado. Encontrado en /qa 2026-08-20 exportando una factura real.
    let copiedLines = 0;
    let orderLinked = 0;
    for (const line of lines ?? []) {
      if (!line.bc_line_type || !line.bc_line_object_number) continue;
      const createdLine = await bcPost<CreatedInvoiceLine>(bcCompanyId, `/purchaseInvoices(${created.id})/purchaseInvoiceLines`, {
        lineType: line.bc_line_type,
        lineObjectNumber: line.bc_line_object_number,
        description: line.description,
        quantity: line.quantity,
        unitCost: line.bc_unit_cost,
      });
      copiedLines += 1;

      // "sequence" de purchaseOrderLines ES el "Line No." interno de BC
      // (asi lo guarda bc-sync-orders) -- es lo que "orderLineNo" espera.
      if (order.order_number && line.sequence != null) {
        try {
          await bcPatch(
            bcCompanyId,
            `/purchaseInvoiceOrderLinks(${createdLine.id})`,
            { orderNo: order.order_number, orderLineNo: line.sequence },
            "custom",
          );
          orderLinked += 1;
        } catch (linkErr) {
          console.error(`No se pudo vincular la linea ${createdLine.id} con la orden ${order.order_number}: ${linkErr}`);
        }
      }
    }
    if ((lines ?? []).length > 0 && copiedLines === 0) {
      throw new Error(
        `La orden tiene ${lines?.length} linea(s) pero ninguna tiene un numero de cuenta/item valido en Business Central (bc_line_object_number vacio) — la factura ${created.number} se creo en BC pero sin lineas, hay que corregirla o eliminarla ahi manualmente`,
      );
    }

    // 2.5. "No. Comprobante Fiscal" (NCF) — campo obligatorio de cumplimiento
    // fiscal de Republica Dominicana para poder postear. No esta expuesto en
    // la API estandar (confirmado inspeccionando el $metadata completo de
    // purchaseInvoices, 46 campos, ninguno fiscal) asi que se escribe via el
    // Custom API propio (PurchInvoiceFiscalAPI.al, page 58004), sobre el
    // mismo SystemId que ya devolvio la creacion estandar del paso 1. Sin
    // esto, Microsoft.NAV.post rechaza el posteo con "Fiscal Document No.
    // must have a value" — confirmado en vivo en /qa 2026-08-20.
    //
    // Excepcion (2026-08-26): proveedores informales/extranjeros no tienen
    // NCF dominicano. vendor.vendor_posting_group viene de vendorPostingSetups
    // (sincronizado por bc-sync-vendors) -- PROVINFORM e INT son los codigos
    // reales confirmados contra el sandbox. Por defecto (grupo vacio/desconocido)
    // se sigue exigiendo NCF, igual que antes.
    const ncfExempt = vendor.vendor_posting_group === "PROVINFORM" || vendor.vendor_posting_group === "INT";
    if (!ncfExempt && !invoice.invoice_tax_number) {
      throw new Error(
        `La factura ${created.number} se creo en BC pero no tiene NCF (invoice_tax_number) — Business Central no la va a dejar postear sin ese dato`,
      );
    }
    // 2.6. "Expense Class Code" — segundo campo obligatorio de cumplimiento
    // fiscal (reportes 606/607/608 de la DGII) para poder postear. NO es una
    // regla que el portal calcule: quien arma la orden de compra en BC ya lo
    // elige al crearla (confirmado en vivo 2026-08-31 contra ordenes reales
    // via el legacy OData v4 "Pedido_compra_Excel" -- 12 de 15 ordenes de
    // ADSEMBLE ya lo traian poblado). bc-sync-orders lo lee de la orden
    // (purchaseOrderFiscals, solo lectura) y lo guarda en
    // purchase_orders.bc_expense_class_code; aca simplemente se copia a la
    // factura, junto con el NCF, sobre el mismo SystemId. Si la orden no lo
    // tiene (ordenes viejas/de prueba sin ese dato en BC), queda vacio en la
    // factura igual que antes -- no bloquea el export, solo el posteo
    // posterior en BC.
    const fiscalPatch: Record<string, string> = {};
    if (invoice.invoice_tax_number) fiscalPatch.fiscalDocumentNo = invoice.invoice_tax_number;
    if (order.bc_expense_class_code) fiscalPatch.expenseClassCode = order.bc_expense_class_code;
    if (Object.keys(fiscalPatch).length > 0) {
      await bcPatch(bcCompanyId, `/purchaseInvoiceFiscals(${created.id})`, fiscalPatch, "custom");
    }

    // 3. Adjuntar el PDF de la factura, si ya fue subido a Storage.
    let attached = false;
    if (invoice.file_path) {
      const { data: fileBlob, error: downloadErr } = await db.storage.from("invoices").download(invoice.file_path);
      if (downloadErr) throw new Error(`No se pudo leer el PDF de Storage: ${downloadErr.message}`);
      const bytes = new Uint8Array(await fileBlob.arrayBuffer());
      await bcAttachFile(bcCompanyId, `/purchaseInvoices(${created.id})`, invoice.filename ?? "factura.pdf", bytes, "application/pdf");
      attached = true;
    }

    // 3.5. Reflejar los mismos datos en la Orden de Compra misma (Key
    // Players, 2026-09-01, items 3 y 5). Confirmado con Jonatan: esto es
    // ADEMAS del flujo de arriba (la Factura de Compra separada, que sigue
    // siendo lo unico que postea y alimenta 606/607/608), no en su lugar --
    // el equipo de Adsemble mira hoy la orden misma (ver
    // docs/BITACORA.md, captura ordendecompra1.png) y quiere ver ahi la
    // fecha/Nº factura/NCF + el PDF, sin tener que abrir la factura aparte.
    //
    // orderDate es un campo ESTANDAR de la API v2.0 de purchaseOrders
    // (confirmado en vivo: orderDate de CP-000221 = 2026-09-01 = "1/9/2026"
    // de la captura) -- se patchea directo, sin custom API. Vendor Invoice
    // No. y el NCF si necesitan el custom API (purchaseOrderFiscals, page
    // 58006, extendido para esto -- ver infra/business-central/README.md).
    //
    // A proposito NO fatal: la factura real (lo que importa para
    // contabilidad/DGII) ya se creo arriba con exito. Si este paso
    // adicional falla (ej. la extension AL todavia no fue publicada por
    // Jonatan en el sandbox), la exportacion NO se marca export_error por
    // esto -- solo se loguea, y el resultado lo reporta orderSynced:false
    // para que quien exporta lo note sin que el flujo principal se rompa.
    let orderSynced = false;
    try {
      if (order.bc_id) {
        if (invoice.invoice_date) {
          await bcPatch(bcCompanyId, `/purchaseOrders(${order.bc_id})`, { orderDate: invoice.invoice_date });
        }
        const orderFiscalPatch: Record<string, string> = {};
        if (invoice.invoice_number) orderFiscalPatch.vendorInvoiceNumber = invoice.invoice_number;
        if (invoice.invoice_tax_number) orderFiscalPatch.fiscalDocumentNo = invoice.invoice_tax_number;
        if (Object.keys(orderFiscalPatch).length > 0) {
          await bcPatch(bcCompanyId, `/purchaseOrderFiscals(${order.bc_id})`, orderFiscalPatch, "custom");
        }
        if (invoice.file_path) {
          const { data: orderFileBlob, error: orderDownloadErr } = await db.storage.from("invoices").download(invoice.file_path);
          if (orderDownloadErr) throw new Error(`No se pudo releer el PDF de Storage: ${orderDownloadErr.message}`);
          const orderBytes = new Uint8Array(await orderFileBlob.arrayBuffer());
          await bcAttachFile(bcCompanyId, `/purchaseOrders(${order.bc_id})`, invoice.filename ?? "factura.pdf", orderBytes, "application/pdf");
        }
        orderSynced = true;
      }
    } catch (orderSyncErr) {
      console.error(
        `No se pudo reflejar la factura en la Orden de Compra ${order.order_number} (no bloquea el export, la factura ya se creo en BC): ${orderSyncErr instanceof Error ? orderSyncErr.message : String(orderSyncErr)}`,
      );
    }

    const { error: updateErr } = await db
      .from("invoices")
      .update({
        status: "processed",
        bc_invoice_id: created.id,
        bc_invoice_number: created.number,
        erp_id: created.number,
        exported_at: new Date().toISOString(),
        export_error_reason: null,
      })
      .eq("id", invoice.id);
    if (updateErr) throw new Error(`Factura exportada a BC pero no se pudo actualizar en Supabase: ${updateErr.message}`);

    await db.from("invoice_status_history").insert({
      invoice_id: invoice.id,
      status: "processed",
      changed_by: body.changedBy,
      reason: null,
    });

    return new Response(
      JSON.stringify({
        ok: true,
        bcInvoiceId: created.id,
        bcInvoiceNumber: created.number,
        attached,
        copiedLines,
        orderLinked,
        orderSynced,
      }),
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
