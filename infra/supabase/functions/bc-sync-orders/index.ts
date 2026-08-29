// Sincroniza ordenes de compra BC -> Supabase (solo lectura del lado de BC).
// Invocacion manual/programada — no la llama el frontend. Ver plan Fase A.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { bcGetAll } from "../_shared/bc-client.ts";
import { getActiveCompanies } from "../_shared/companies.ts";
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

// Matchea/crea el vendor DENTRO de la empresa (company_id), no solo por
// numero -- el mismo vendor_number existe legitimamente en varias empresas
// de BC (confirmado en vivo: PROV-000001 = REVESTIDA SRL en 11 empresas
// distintas del tenant). Antes de schema-v16.sql esto matcheaba solo por
// vendor_number y habria mezclado ordenes de dos empresas contra un mismo
// vendor del portal en cuanto se conectara la segunda.
async function resolveVendorId(db: ReturnType<typeof admin>, order: BcPurchaseOrder, companyId: string): Promise<string> {
  const { data: existing } = await db
    .from("vendors")
    .select("id")
    .eq("vendor_number", order.vendorNumber)
    .eq("company_id", companyId)
    .maybeSingle();
  if (existing) return existing.id as string;

  const { data: created, error } = await db
    .from("vendors")
    .insert({ vendor_number: order.vendorNumber, company_name: order.vendorName, status: "active", company_id: companyId })
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

    const companies = await getActiveCompanies(db);

    let ordersProcessed = 0;
    let created = 0;
    let updated = 0;
    let lineCount = 0;
    let skippedDrafts = 0;
    const perCompany: unknown[] = [];

    for (const company of companies) {
      const orders = await bcGetAll<BcPurchaseOrder>(company.bcCompanyId, "/purchaseOrders");
      let companyCreated = 0;
      let companyUpdated = 0;
      let companySkippedDrafts = 0;

      // Las ordenes en "Draft" en BC todavia no fueron liberadas/aprobadas
      // internamente por Adsemble -- no deben llegar al portal, ni para el
      // proveedor ni para el admin, hasta que BC las libere. Antes se
      // sincronizaban igual (con badge "Borrador" en la UI, pero sin
      // bloquear "Confirmar orden") — un proveedor podia confirmar una orden
      // que el propio equipo de Adsemble aun no habia terminado de armar.
      // Decision de Jonatan, 2026-08-21.
      for (const order of orders) {
        if (order.status === "Draft") {
          companySkippedDrafts++;
          continue;
        }
        const vendorId = await resolveVendorId(db, order, company.id);

        const { data: existingOrder } = await db.from("purchase_orders").select("id").eq("bc_id", order.id).maybeSingle();

        const orderRow = {
          company_id: company.id,
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
          companyUpdated++;
        } else {
          const { data: inserted, error } = await db.from("purchase_orders").insert(orderRow).select("id").single();
          if (error || !inserted) throw error ?? new Error("insert purchase_orders sin data");
          orderId = inserted.id as string;
          companyCreated++;
        }

        const lines = await bcGetAll<BcPurchaseOrderLine>(company.bcCompanyId, `/purchaseOrders(${order.id})/purchaseOrderLines`);
        const { error: delErr } = await db.from("purchase_orders_lines").delete().eq("order_id", orderId);
        if (delErr) throw delErr;

        if (lines.length > 0) {
          const lineRows = lines.map((line) => ({
            order_id: orderId,
            company_id: company.id,
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

      ordersProcessed += orders.length;
      created += companyCreated;
      updated += companyUpdated;
      skippedDrafts += companySkippedDrafts;
      perCompany.push({
        company: company.name,
        ordersProcessed: orders.length,
        created: companyCreated,
        updated: companyUpdated,
        skippedDrafts: companySkippedDrafts,
      });
    }

    await markRan(db, THROTTLE_KEY);

    return new Response(
      JSON.stringify({
        ok: true,
        companiesProcessed: companies.length,
        ordersProcessed,
        created,
        updated,
        linesSynced: lineCount,
        skippedDrafts,
        perCompany,
      }),
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
