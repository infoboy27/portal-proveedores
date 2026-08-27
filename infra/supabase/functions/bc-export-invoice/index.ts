// Exporta una factura aprobada a Business Central "sobre la plantilla de la
// orden de compra correspondiente": cabecera (fecha de factura + NCF/vendor
// invoice number), lineas copiadas de la PO ya sincronizada, y el PDF como
// adjunto. Invocada desde el boton "Exportar ahora" (Exports.tsx). Ver plan
// Fase A: la API v2.0 de BC no tiene "crear factura desde orden" por REST,
// asi que replicamos ese comportamiento copiando purchaseOrderLines ->
// purchaseInvoiceLines a mano.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { bcPost, bcPatch, bcAttachFile } from "../_shared/bc-client.ts";

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
    // puede setear en la creacion. El vinculo con la orden se logra copiando
    // vendor + lineas de la PO (paso 2), que es la "plantilla" que pide el
    // cliente, aunque el campo interno orderId del header quede vacio.
    const created = await bcPost<{ id: string; number: string }>("/purchaseInvoices", {
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
    for (const line of lines ?? []) {
      if (!line.bc_line_type || !line.bc_line_object_number) continue;
      await bcPost(`/purchaseInvoices(${created.id})/purchaseInvoiceLines`, {
        lineType: line.bc_line_type,
        lineObjectNumber: line.bc_line_object_number,
        description: line.description,
        quantity: line.quantity,
        unitCost: line.bc_unit_cost,
      });
      copiedLines += 1;
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
    if (invoice.invoice_tax_number) {
      await bcPatch(
        `/purchaseInvoiceFiscals(${created.id})`,
        { fiscalDocumentNo: invoice.invoice_tax_number },
        "custom",
      );
    }

    // NOTA: existe un segundo campo obligatorio para postear, "Expense
    // Class Code" (misma page 58004, campo `expenseClassCode`) — clasificacion
    // de gasto para los reportes 606/607/608 de la DGII. No se autocompleta
    // aqui a proposito: es una decision contable de Adsemble (que codigo
    // corresponde a que tipo de gasto/cuenta), no un dato que el portal
    // pueda inferir del proveedor o la factura sin equivocarse. Mientras no
    // se defina esa regla, el posteo en BC requiere completarlo a mano ahi
    // (o decidir una regla y volver a esta funcion para automatizarlo).

    // 3. Adjuntar el PDF de la factura, si ya fue subido a Storage.
    let attached = false;
    if (invoice.file_path) {
      const { data: fileBlob, error: downloadErr } = await db.storage.from("invoices").download(invoice.file_path);
      if (downloadErr) throw new Error(`No se pudo leer el PDF de Storage: ${downloadErr.message}`);
      const bytes = new Uint8Array(await fileBlob.arrayBuffer());
      await bcAttachFile(`/purchaseInvoices(${created.id})`, invoice.filename ?? "factura.pdf", bytes, "application/pdf");
      attached = true;
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
      JSON.stringify({ ok: true, bcInvoiceId: created.id, bcInvoiceNumber: created.number, attached }),
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
