// Sincroniza pagos reales BC -> Supabase via vendorLedgerEntries (Custom API
// propia, ver docs/BUSINESS_CENTRAL_INTEGRATION.md §4 y §7). Reemplaza el
// "Pendiente de Pago" manual por datos reales de BC cuando hay match —
// nunca escribe hacia BC, solo lee.
//
// Match: primero por externalDocumentNo (= "Vendor Invoice No." que
// bc-export-invoice manda al crear la factura, invoice_tax_number/NCF o
// invoice_number) — es el dato que sobrevive el posteo. Confirmado en vivo
// (2026-08-20): el "No." del documento borrador que crea bc-export-invoice
// (bc_invoice_number, ej. "CF-001918") es de una serie distinta a la del
// asiento ya posteado (documentNo, ej. "CFR-000001") — emparejar por
// bc_invoice_number/documentNo NUNCA hubiera funcionado una vez posteada la
// factura. Se deja documentNo/bc_invoice_number como respaldo por si algun
// escenario preserva el numero.
//
// Solo toca facturas ya exportadas (status = 'processed').
//
// Conservador a proposito: si el asiento sigue abierto (Open = true) solo
// actualiza `payment_due_date` con el `dueDate` real de BC — nunca borra un
// `paid_at` ya puesto. Solo escribe `paid_at` cuando BC confirma el asiento
// cerrado (Open = false).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { bcGetAll } from "../_shared/bc-client.ts";
import { markRan, shouldRun } from "../_shared/sync-throttle.ts";

const THROTTLE_KEY = "sync_payments_interval_minutes";

interface BcVendorLedgerEntry {
  entryNo: number;
  vendorNo: string;
  documentType: string;
  documentNo: string;
  externalDocumentNo: string;
  postingDate: string;
  dueDate: string | null;
  amount: number;
  remainingAmount: number;
  open: boolean;
  closedAtDate: string | null;
}

interface InvoiceRow {
  id: string;
  invoice_number: string | null;
  invoice_tax_number: string | null;
  bc_invoice_number: string | null;
  paid_at: string | null;
  bc_ledger_entry_no: string | null;
}

function admin() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

function findInvoice(
  entry: BcVendorLedgerEntry,
  byExternalDoc: Map<string, InvoiceRow>,
  byBcNumber: Map<string, InvoiceRow>,
): InvoiceRow | undefined {
  if (entry.externalDocumentNo) {
    const hit = byExternalDoc.get(entry.externalDocumentNo);
    if (hit) return hit;
  }
  if (entry.documentNo) {
    const hit = byBcNumber.get(entry.documentNo);
    if (hit) return hit;
  }
  return undefined;
}

Deno.serve(async () => {
  try {
    const db = admin();

    if (!(await shouldRun(db, THROTTLE_KEY))) {
      return new Response(JSON.stringify({ ok: true, skipped: true, reason: "not due yet" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Un solo GET a BC (paginado, filtrado server-side a solo tipo Factura)
    // y una sola query a Supabase — evita el patron N+1 (una consulta por
    // cada uno de los miles de asientos) que causo timeout en la primera
    // version de esta funcion.
    const [entries, invoicesRes] = await Promise.all([
      bcGetAll<BcVendorLedgerEntry>("/vendorLedgerEntries?$filter=documentType eq 'Invoice'", "custom"),
      db
        .from("invoices")
        .select("id, invoice_number, invoice_tax_number, bc_invoice_number, paid_at, bc_ledger_entry_no")
        .eq("status", "processed"),
    ]);
    if (invoicesRes.error) throw invoicesRes.error;

    const invoices = (invoicesRes.data ?? []) as InvoiceRow[];
    const byExternalDoc = new Map<string, InvoiceRow>();
    const byBcNumber = new Map<string, InvoiceRow>();
    for (const inv of invoices) {
      if (inv.invoice_tax_number) byExternalDoc.set(inv.invoice_tax_number, inv);
      if (inv.invoice_number && !byExternalDoc.has(inv.invoice_number)) byExternalDoc.set(inv.invoice_number, inv);
      if (inv.bc_invoice_number) byBcNumber.set(inv.bc_invoice_number, inv);
    }

    let matched = 0;
    let markedPaid = 0;
    let dueDateUpdated = 0;
    let skippedNoMatch = 0;

    for (const entry of entries) {
      const invoice = findInvoice(entry, byExternalDoc, byBcNumber);
      if (!invoice) {
        skippedNoMatch++;
        continue;
      }
      matched++;

      const entryNoStr = String(entry.entryNo);

      if (!entry.open) {
        const paidAt = entry.closedAtDate || entry.postingDate;
        const alreadyRecorded = invoice.paid_at && invoice.bc_ledger_entry_no === entryNoStr;
        if (!alreadyRecorded) {
          const { error } = await db
            .from("invoices")
            .update({
              paid_at: paidAt,
              payment_reference: entry.externalDocumentNo || null,
              payment_source: "bc",
              bc_ledger_entry_no: entryNoStr,
            })
            .eq("id", invoice.id);
          if (error) throw error;

          await db.from("invoice_status_history").insert({
            invoice_id: invoice.id,
            status: "paid",
            changed_by: null,
            reason: `Sincronizado desde Business Central (vendor ledger entry ${entryNoStr})`,
          });
          markedPaid++;
        }
      } else if (entry.dueDate) {
        const { error } = await db
          .from("invoices")
          .update({ payment_due_date: entry.dueDate, payment_source: "bc", bc_ledger_entry_no: entryNoStr })
          .eq("id", invoice.id);
        if (error) throw error;
        dueDateUpdated++;
      }
    }

    await markRan(db, THROTTLE_KEY);

    return new Response(
      JSON.stringify({ ok: true, entriesProcessed: entries.length, matched, markedPaid, dueDateUpdated, skippedNoMatch }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
