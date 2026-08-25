// Sincroniza recepciones de compra BC -> Supabase (solo lectura del lado de
// BC). Usa la Custom API page propia (infra/business-central/), publicada
// en Test672026 el 2026-08-20 — la API v2.0 estandar no expone
// purchaseReceipts para este tenant (ver docs/BUSINESS_CENTRAL_INTEGRATION.md §4).
// Invocacion manual/programada, igual que bc-sync-orders — no la llama el
// frontend directamente.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { bcGetAll } from "../_shared/bc-client.ts";
import { markRan, shouldRun } from "../_shared/sync-throttle.ts";

const THROTTLE_KEY = "sync_receipts_interval_minutes";

interface BcPurchaseReceipt {
  id: string;
  number: string;
  orderNo: string;
  vendorNo: string;
  postingDate: string;
  vendorShipmentNo: string;
}

function admin() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

async function resolveCompanyId(db: ReturnType<typeof admin>): Promise<string> {
  const bcCompanyId = Deno.env.get("BC_COMPANY_ID")!;
  const { data, error } = await db.from("companies").select("id").eq("bc_code", bcCompanyId).single();
  if (error || !data) throw new Error(`No se encontro companies.bc_code = ${bcCompanyId}: ${error?.message}`);
  return data.id as string;
}

Deno.serve(async () => {
  try {
    const db = admin();

    if (!(await shouldRun(db, THROTTLE_KEY))) {
      return new Response(JSON.stringify({ ok: true, skipped: true, reason: "not due yet" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const companyId = await resolveCompanyId(db);
    const receipts = await bcGetAll<BcPurchaseReceipt>("/purchaseReceipts", "custom");

    let created = 0;
    let updated = 0;
    let skippedNoOrder = 0;

    for (const receipt of receipts) {
      // orderNo es el numero legible de la orden (purchase_orders.order_number
      // via bc-sync-orders), no el bc_id — asi es como lo expone la Custom API.
      const { data: order } = await db
        .from("purchase_orders")
        .select("id")
        .eq("order_number", receipt.orderNo)
        .eq("company_id", companyId)
        .maybeSingle();

      if (!order) {
        skippedNoOrder++;
        continue;
      }

      const row = {
        order_id: order.id as string,
        company_id: companyId,
        bc_id: receipt.id,
        receipt_number: receipt.number,
        vendor_shipment_no: receipt.vendorShipmentNo || null,
        posting_date: receipt.postingDate || null,
      };

      const { data: existing } = await db
        .from("purchase_order_receipts")
        .select("id")
        .eq("bc_id", receipt.id)
        .maybeSingle();

      if (existing) {
        const { error } = await db.from("purchase_order_receipts").update(row).eq("id", existing.id);
        if (error) throw error;
        updated++;
      } else {
        const { error } = await db.from("purchase_order_receipts").insert(row);
        if (error) throw error;
        created++;
      }
    }

    await markRan(db, THROTTLE_KEY);

    return new Response(
      JSON.stringify({ ok: true, receiptsProcessed: receipts.length, created, updated, skippedNoOrder }),
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
