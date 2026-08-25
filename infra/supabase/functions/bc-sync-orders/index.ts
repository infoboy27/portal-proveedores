// Sincroniza ordenes de compra BC -> Supabase (solo lectura del lado de BC).
// Invocacion manual/programada — no la llama el frontend. Ver plan Fase A.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { bcGetAll } from "../_shared/bc-client.ts";
import { markRan, shouldRun } from "../_shared/sync-throttle.ts";

const THROTTLE_KEY = "sync_orders_interval_minutes";

interface BcPurchaseOrder {
  id: string;
  number: string;
  orderDate: string;
  vendorId: string;
  vendorNumber: string;
  vendorName: string;
  totalAmountIncludingTax: number;
  status: string;
}

interface BcPurchaseOrderLine {
  id: string;
  documentId: string;
  sequence: number;
  lineType: string;
  lineObjectNumber: string;
  description: string;
  quantity: number;
  directUnitCost: number;
  amountIncludingTax: number;
  taxCode: string;
}

const STATUS_MAP: Record<string, string> = {
  Open: "open",
  Draft: "draft",
  "In Review": "in_review",
  Closed: "closed",
  Released: "open",
};

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

async function resolveVendorId(db: ReturnType<typeof admin>, order: BcPurchaseOrder): Promise<string> {
  const { data: existing } = await db.from("vendors").select("id").eq("vendor_number", order.vendorNumber).maybeSingle();
  if (existing) return existing.id as string;

  const { data: created, error } = await db
    .from("vendors")
    .insert({ vendor_number: order.vendorNumber, company_name: order.vendorName, status: "active" })
    .select("id")
    .single();
  if (error || !created) throw new Error(`No se pudo crear vendor ${order.vendorNumber}: ${error?.message}`);
  return created.id as string;
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
    const orders = await bcGetAll<BcPurchaseOrder>("/purchaseOrders");

    let created = 0;
    let updated = 0;
    let lineCount = 0;

    // Las ordenes en "Draft" en BC todavia no fueron liberadas/aprobadas
    // internamente por Adsemble -- no deben llegar al portal, ni para el
    // proveedor ni para el admin, hasta que BC las libere. Antes se
    // sincronizaban igual (con badge "Borrador" en la UI, pero sin
    // bloquear "Confirmar orden") — un proveedor podia confirmar una orden
    // que el propio equipo de Adsemble aun no habia terminado de armar.
    // Decision de Jonatan, 2026-08-21.
    let skippedDrafts = 0;
    for (const order of orders) {
      if (order.status === "Draft") {
        skippedDrafts++;
        continue;
      }
      const vendorId = await resolveVendorId(db, order);

      const { data: existingOrder } = await db.from("purchase_orders").select("id").eq("bc_id", order.id).maybeSingle();

      const orderRow = {
        company_id: companyId,
        vendor_id: vendorId,
        order_number: order.number,
        order_date: order.orderDate,
        amount: order.totalAmountIncludingTax,
        status: STATUS_MAP[order.status] ?? "open",
        bc_id: order.id,
      };

      let orderId: string;
      if (existingOrder) {
        orderId = existingOrder.id as string;
        const { error } = await db.from("purchase_orders").update(orderRow).eq("id", orderId);
        if (error) throw error;
        updated++;
      } else {
        const { data: inserted, error } = await db.from("purchase_orders").insert(orderRow).select("id").single();
        if (error || !inserted) throw error ?? new Error("insert purchase_orders sin data");
        orderId = inserted.id as string;
        created++;
      }

      const lines = await bcGetAll<BcPurchaseOrderLine>(`/purchaseOrders(${order.id})/purchaseOrderLines`);
      const { error: delErr } = await db.from("purchase_orders_lines").delete().eq("order_id", orderId);
      if (delErr) throw delErr;

      if (lines.length > 0) {
        const lineRows = lines.map((line) => ({
          order_id: orderId,
          company_id: companyId,
          description: line.description,
          quantity: line.quantity,
          price: line.directUnitCost,
          amount: line.amountIncludingTax,
          sequence: line.sequence,
          bc_line_type: line.lineType,
          bc_line_object_number: line.lineObjectNumber,
          bc_unit_cost: line.directUnitCost,
          bc_tax_code: line.taxCode,
        }));
        const { error: linesErr } = await db.from("purchase_orders_lines").insert(lineRows);
        if (linesErr) throw linesErr;
        lineCount += lineRows.length;
      }
    }

    await markRan(db, THROTTLE_KEY);

    return new Response(
      JSON.stringify({ ok: true, ordersProcessed: orders.length, created, updated, linesSynced: lineCount, skippedDrafts }),
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
