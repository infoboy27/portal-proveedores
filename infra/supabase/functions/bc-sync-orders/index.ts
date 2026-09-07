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
  paymentTermsId: string | null;
  // Presente cuando se pide con $expand=purchaseOrderLines (2026-09-07).
  purchaseOrderLines?: BcPurchaseOrderLine[];
}

// Key Players (2026-09-02), item 7: fecha estimada de pago = fecha de la
// factura + la condicion de pago de ESTA orden en BC -- nunca inventada
// localmente. `dueDateCalculation` es la formula real de BC (DateFormula),
// interpretada server-side en estimate_payment_date (schema-v28.sql).
interface BcPaymentTerm {
  id: string;
  code: string;
  displayName: string;
  dueDateCalculation: string;
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

interface BcPurchaseOrderFiscal {
  id: string;
  expenseClassCode: string | null;
}

// Todos los codigos de clasificacion de gasto de una empresa, en UNA sola
// llamada, indexados por el SystemId de la orden.
//
// 2026-09-07: antes esto era una llamada a BC POR CADA ORDEN
// (fetchExpenseClassCode, abajo). Con una sola empresa activa se notaba
// poco; al activar las 7 empresas de produccion pasaron a ser 229 ordenes
// = 229 llamadas solo para este dato, y la sincronizacion dejo de terminar
// dentro del tiempo permitido: el supervisor mataba al worker y despues el
// gateway devolvia 502. Resultado: 4 dias sin sincronizar y nadie se
// enteraba. purchaseOrderFiscals es una page sobre Purchase Header
// filtrada a Document Type = Order, asi que un GET sin filtro devuelve
// todas las ordenes de la empresa de una vez (verificado en produccion:
// 144 registros de Liquid Digital Agency en una llamada).
async function fetchExpenseClassCodes(bcCompanyId: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const rows = await bcGetAll<BcPurchaseOrderFiscal>(bcCompanyId, "/purchaseOrderFiscals", "custom");
    for (const row of rows) {
      if (row.id && row.expenseClassCode) map.set(row.id, row.expenseClassCode);
    }
  } catch (err) {
    // Mismo criterio que antes: si la extension no esta publicada o falla,
    // las ordenes se sincronizan igual, solo sin este dato.
    console.error(`No se pudieron leer los Expense Class Code de la empresa ${bcCompanyId}: ${err}`);
  }
  return map;
}

const STATUS_MAP: Record<string, string> = {
  Open: "open",
  Draft: "draft",
  Closed: "closed",
  Released: "open",
};

// Valor crudo que devuelve la API de BC para "Pendiente de aprobación"
// (Purchase Header Status = "Pending Approval", nombre del enum "In Review").
// OData escapa el espacio del nombre del enum como "_x0020_" -- NO es un
// espacio literal. Hallazgo de Jonatan, 2026-09-02: la clave vieja del
// STATUS_MAP ("In Review", con espacio literal) nunca hacia match contra
// esto, asi que `STATUS_MAP[order.status] ?? "open"` caia siempre al
// fallback "open" -- una orden pendiente de aprobar en BC quedaba
// indistinguible de una ya aprobada, sincronizada y **totalmente
// trabajable** desde el portal (confirmar, subir factura). Verificado en
// vivo contra el sandbox: 2 ordenes reales (CP-000222, CP-000223) con
// status="In_x0020_Review" en BC, guardadas como status="open" en el
// portal -- una de ellas (CP-000223) ya tenia una confirmacion y una
// factura subida en el momento del hallazgo.
const STATUS_PENDING_APPROVAL = "In_x0020_Review";

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

// Payment Terms cambian poco -- se resincroniza el catalogo completo de
// la empresa una vez por corrida (no por orden). Upsert por id (bc guid).
async function syncPaymentTerms(db: ReturnType<typeof admin>, company: { id: string; bcCompanyId: string }): Promise<number> {
  const terms = await bcGetAll<BcPaymentTerm>(company.bcCompanyId, "/paymentTerms");
  if (terms.length === 0) return 0;
  const rows = terms.map((t) => ({
    id: t.id,
    company_id: company.id,
    code: t.code,
    display_name: t.displayName,
    due_date_calculation: t.dueDateCalculation,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await db.from("payment_terms").upsert(rows, { onConflict: "id" });
  if (error) throw error;
  return rows.length;
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
    let skippedNotApproved = 0;
    const perCompany: unknown[] = [];

    for (const company of companies) {
      await syncPaymentTerms(db, company);
      // Dos lecturas en lote por empresa, en vez de dos llamadas por orden
      // (2026-09-07, ver fetchExpenseClassCodes): las lineas vienen
      // expandidas en la misma respuesta de las ordenes, y los codigos de
      // gasto se traen todos juntos. Con las 7 empresas de produccion esto
      // baja la sincronizacion de ~458 llamadas a BC a 14.
      const orders = await bcGetAll<BcPurchaseOrder>(
        company.bcCompanyId,
        "/purchaseOrders?$expand=purchaseOrderLines",
      );
      const expenseClassCodes = await fetchExpenseClassCodes(company.bcCompanyId);
      let companyCreated = 0;
      let companyUpdated = 0;
      let companySkippedNotApproved = 0;

      // Las ordenes en "Draft" o pendientes de aprobacion en BC todavia no
      // fueron liberadas/aprobadas internamente por Adsemble -- no deben
      // llegar al portal, ni para el proveedor ni para el admin, hasta que
      // BC las apruebe. Antes se sincronizaban igual (con badge en la UI,
      // pero sin bloquear "Confirmar orden") — un proveedor podia confirmar
      // una orden que el propio equipo de Adsemble aun no habia terminado
      // de aprobar. Decision de Jonatan, 2026-08-21 (solo cubria Draft) y
      // 2026-09-02 (extendida a pendiente de aprobacion, con evidencia real
      // de que se estaba colando -- ver comentario en STATUS_PENDING_APPROVAL).
      for (const order of orders) {
        if (order.status === "Draft" || order.status === STATUS_PENDING_APPROVAL) {
          companySkippedNotApproved++;
          continue;
        }
        const vendorId = await resolveVendorId(db, order, company.id);

        const { data: existingOrder } = await db.from("purchase_orders").select("id").eq("bc_id", order.id).maybeSingle();

        const expenseClassCode = expenseClassCodes.get(order.id) ?? null;

        const orderRow = {
          company_id: company.id,
          vendor_id: vendorId,
          order_number: order.number,
          order_date: order.orderDate,
          amount: order.totalAmountIncludingTax,
          status: STATUS_MAP[order.status] ?? "open",
          bc_id: order.id,
          bc_expense_class_code: expenseClassCode,
          payment_terms_id: order.paymentTermsId || null,
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

        // Ya vienen en la respuesta de arriba ($expand), sin llamada extra.
        const lines = order.purchaseOrderLines ?? [];
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
      skippedNotApproved += companySkippedNotApproved;
      perCompany.push({
        company: company.name,
        ordersProcessed: orders.length,
        created: companyCreated,
        updated: companyUpdated,
        skippedNotApproved: companySkippedNotApproved,
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
        skippedNotApproved,
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
