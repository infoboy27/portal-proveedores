// Extrae fecha de factura, NCF, numero de factura y total via OCR self-hosted
// (Tesseract, servicio interno "ocr-service" — sin depender de ningun servicio
// de IA de pago). Se invoca justo despues de subir el PDF (uploadInvoice en
// domain.ts). Solo actualiza los campos que el OCR detecto con confianza; si
// no detecta nada, la factura queda igual que hoy y el proveedor la completa
// a mano en el formulario de InvoiceDetail.
//
// Nota (2026-08-25): las lineas de detalle (invoice_lines) NO se extraen por
// OCR — con Tesseract puro (texto plano, sin bounding boxes) el parseo de
// tablas es poco confiable entre formatos de proveedor distintos. Se dejo
// fuera a proposito en vez de entregar algo poco confiable.
//
// Actualizado (2026-08-31, pedido de Jonatan): ocr-service ahora intenta
// extraerlas con pytesseract.image_to_data() (heuristica de filas/columnas
// por posicion, ver comentario en app.py) y las devuelve en `lines`. Sigue
// siendo best-effort -- por eso solo se insertan si la factura TODAVIA no
// tiene ninguna linea (nunca pisa lineas ya cargadas a mano por un admin/
// aprobador via invoiceLinesHint) y si el propio ocr-service no encontro
// nada quedan simplemente vacias, igual que fecha/NCF/total cuando el OCR
// no detecta nada.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

interface ExtractRequest {
  invoiceId: string;
}

interface OcrLine {
  description: string;
  quantity: number | null;
  unitPrice: number | null;
  amount: number;
  sequence: number;
}

interface OcrResult {
  ok: boolean;
  text?: string;
  invoiceDate?: string | null;
  invoiceTaxNumber?: string | null;
  invoiceNumber?: string | null;
  totalAmount?: number | null;
  lines?: OcrLine[];
  error?: string;
}

function admin() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

Deno.serve(async (req: Request) => {
  let body: ExtractRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "Body invalido" }), { status: 400 });
  }
  if (!body.invoiceId) {
    return new Response(JSON.stringify({ ok: false, error: "Falta invoiceId" }), { status: 400 });
  }

  try {
    const db = admin();
    const { data: invoice, error: invErr } = await db
      .from("invoices")
      .select("id, company_id, file_path, filename, invoice_date, invoice_tax_number, invoice_number, total_amount")
      .eq("id", body.invoiceId)
      .single();
    if (invErr || !invoice) throw new Error(`Factura no encontrada: ${invErr?.message}`);

    if (!invoice.file_path) {
      return new Response(JSON.stringify({ ok: true, extracted: null, reason: "Sin PDF subido" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const { data: fileBlob, error: downloadErr } = await db.storage.from("invoices").download(invoice.file_path);
    if (downloadErr) throw new Error(`No se pudo leer el archivo de Storage: ${downloadErr.message}`);
    const bytes = new Uint8Array(await fileBlob.arrayBuffer());

    // El proveedor puede subir PDF o foto (JPG/PNG) -- ocr-service decide
    // rasterizar-como-PDF vs. leer-imagen-directo segun este Content-Type,
    // asi que tiene que reflejar el archivo real, no asumir siempre PDF.
    const lowerName = (invoice.filename ?? "").toLowerCase();
    const contentType = lowerName.endsWith(".png")
      ? "image/png"
      : lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")
        ? "image/jpeg"
        : "application/pdf";

    const ocrRes = await fetch("http://ocr-service:8080/extract", {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: bytes,
    });
    const ocr = (await ocrRes.json()) as OcrResult;
    if (!ocrRes.ok || !ocr.ok) {
      throw new Error(`ocr-service fallo: ${ocr.error ?? ocrRes.status}`);
    }

    // Nunca pisa un dato que el usuario ya haya cargado a mano.
    // invoice_number/total_amount arrancan en "" / 0 (ver uploadInvoice en
    // domain.ts) -- falsy es "todavia no lo lleno nadie", igual que null en
    // invoice_date/invoice_tax_number.
    const patch: Record<string, string | number> = {};
    if (ocr.invoiceDate && !invoice.invoice_date) patch.invoice_date = ocr.invoiceDate;
    if (ocr.invoiceTaxNumber && !invoice.invoice_tax_number) patch.invoice_tax_number = ocr.invoiceTaxNumber;
    if (ocr.invoiceNumber && !invoice.invoice_number) {
      patch.invoice_number = ocr.invoiceNumber;
    } else if (!invoice.invoice_number) {
      // Facturas de servicios (EDESUR y similares, 2026-09-03): no traen un
      // "Numero de factura" etiquetado -- son recibos de consumo, no
      // facturas comerciales (confirmado leyendo el texto real de una,
      // ver docs/BITACORA.md). Pedido explicito de Jonatan: si el OCR no
      // encontro numero de factura pero SI encontro el NCF, usar los
      // ultimos 4 digitos del NCF como numero de factura -- mejor que
      // dejarlo vacio y bloquear la confirmacion.
      const ncf = ocr.invoiceTaxNumber ?? invoice.invoice_tax_number;
      if (ncf && ncf.length >= 4) patch.invoice_number = ncf.slice(-4);
    }
    if (ocr.totalAmount && !invoice.total_amount) patch.total_amount = ocr.totalAmount;

    if (Object.keys(patch).length > 0) {
      const { error: updateErr } = await db.from("invoices").update(patch).eq("id", invoice.id);
      if (updateErr) throw new Error(`No se pudo guardar lo extraido: ${updateErr.message}`);
    }

    // Lineas de detalle: solo si el OCR encontro algo Y la factura todavia
    // no tiene ninguna -- nunca pisa lineas ya cargadas a mano (ver nota
    // arriba). No es fatal si falla: la factura queda como estaba, igual
    // que el resto de esta funcion.
    let linesInserted = 0;
    if (ocr.lines && ocr.lines.length > 0) {
      const { count: existingLines } = await db
        .from("invoice_lines")
        .select("id", { count: "exact", head: true })
        .eq("invoice_id", invoice.id);
      if (!existingLines) {
        const rows = ocr.lines.map((l) => ({
          invoice_id: invoice.id,
          company_id: invoice.company_id,
          description: l.description,
          quantity: l.quantity,
          price: l.unitPrice,
          amount: l.amount,
          sequence: l.sequence,
        }));
        const { error: linesErr } = await db.from("invoice_lines").insert(rows);
        if (linesErr) {
          console.error(`No se pudieron guardar las lineas extraidas: ${linesErr.message}`);
        } else {
          linesInserted = rows.length;
        }
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        extracted: {
          invoiceDate: ocr.invoiceDate,
          invoiceTaxNumber: ocr.invoiceTaxNumber,
          invoiceNumber: ocr.invoiceNumber,
          totalAmount: ocr.totalAmount,
          linesInserted,
        },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(reason);
    // No es fatal: la factura simplemente queda sin auto-completar, igual que
    // el comportamiento anterior a esta funcion.
    return new Response(JSON.stringify({ ok: false, error: reason }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
});
