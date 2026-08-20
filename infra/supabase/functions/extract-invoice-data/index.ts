// Extrae fecha de factura + NCF via OCR self-hosted (Tesseract, servicio interno
// "ocr-service" — sin depender de ningun servicio de IA de pago). Se invoca justo
// despues de subir el PDF (uploadInvoice en domain.ts). Solo actualiza los campos
// que el OCR detecto con confianza; si no detecta nada, la factura queda igual
// que hoy y el proveedor la completa a mano en el formulario de InvoiceDetail.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

interface ExtractRequest {
  invoiceId: string;
}

interface OcrResult {
  ok: boolean;
  text?: string;
  invoiceDate?: string | null;
  invoiceTaxNumber?: string | null;
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
      .select("id, file_path, invoice_date, invoice_tax_number")
      .eq("id", body.invoiceId)
      .single();
    if (invErr || !invoice) throw new Error(`Factura no encontrada: ${invErr?.message}`);

    if (!invoice.file_path) {
      return new Response(JSON.stringify({ ok: true, extracted: null, reason: "Sin PDF subido" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const { data: fileBlob, error: downloadErr } = await db.storage.from("invoices").download(invoice.file_path);
    if (downloadErr) throw new Error(`No se pudo leer el PDF de Storage: ${downloadErr.message}`);
    const bytes = new Uint8Array(await fileBlob.arrayBuffer());

    const ocrRes = await fetch("http://ocr-service:8080/extract", {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: bytes,
    });
    const ocr = (await ocrRes.json()) as OcrResult;
    if (!ocrRes.ok || !ocr.ok) {
      throw new Error(`ocr-service fallo: ${ocr.error ?? ocrRes.status}`);
    }

    // Nunca pisa un dato que el usuario ya haya cargado a mano.
    const patch: Record<string, string> = {};
    if (ocr.invoiceDate && !invoice.invoice_date) patch.invoice_date = ocr.invoiceDate;
    if (ocr.invoiceTaxNumber && !invoice.invoice_tax_number) patch.invoice_tax_number = ocr.invoiceTaxNumber;

    if (Object.keys(patch).length > 0) {
      const { error: updateErr } = await db.from("invoices").update(patch).eq("id", invoice.id);
      if (updateErr) throw new Error(`No se pudo guardar lo extraido: ${updateErr.message}`);
    }

    return new Response(
      JSON.stringify({ ok: true, extracted: { invoiceDate: ocr.invoiceDate, invoiceTaxNumber: ocr.invoiceTaxNumber } }),
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
