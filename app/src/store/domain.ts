import { create } from "zustand";
import { supabase } from "@/lib/supabase";
import type {
  AuditEvent,
  Invoice,
  InvoiceLine,
  PortalCompany,
  PortalUser,
  PurchaseOrder,
  PurchaseOrderLine,
  PurchaseOrderReceipt,
  PurchaseOrderStatus,
  Supplier,
} from "./types";
import {
  mapAuditEvent,
  mapCompany,
  mapInvoice,
  mapInvoiceLine,
  mapPurchaseOrder,
  mapPurchaseOrderLine,
  mapPurchaseOrderReceipt,
  mapSupplier,
  mapUser,
} from "./mappers";

// Equivalente a `Re` en el bundle original (store de datos de dominio).
// Los nombres de columnas siguen exactamente extraido/01-esquema-tablas.md;
// el mapeo snake_case -> camelCase vive en mappers.ts.

// PostgREST limita cada respuesta a PGRST_DB_MAX_ROWS (1000 en este server).
// El sandbox de BC ya tiene 3,495 vendors (Produccion: ~32,957) — un
// `.select("*")` sin paginar deja fuera silenciosamente a todo vendor mas
// alla del primero 1000, lo que se traduce en nombre de proveedor en blanco
// ("-") en Ordenes, Facturas y Pagos para cualquier orden cuyo vendor_id cae
// fuera de esa primera pagina. Encontrado en /qa 2026-08-20 viendo varias
// filas de /orders sin nombre de proveedor pese a que el JOIN en la base de
// datos si resuelve el nombre correctamente.
async function fetchAllRows<T>(table: string): Promise<T[]> {
  const pageSize = 1000;
  let allRows: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    allRows = allRows.concat((data ?? []) as T[]);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return allRows;
}

interface DomainStore {
  invoices: Invoice[];
  invoiceLines: InvoiceLine[];
  purchaseOrders: PurchaseOrder[];
  purchaseOrderLines: PurchaseOrderLine[];
  purchaseOrderReceipts: PurchaseOrderReceipt[];
  suppliers: Supplier[];
  companies: PortalCompany[];
  users: PortalUser[];
  auditEvents: AuditEvent[];
  loading: boolean;
  error: string | null;
  fetchAll: () => Promise<void>;
  approveInvoice: (invoiceId: string, changedBy: string) => Promise<void>;
  rejectInvoice: (invoiceId: string, changedBy: string, reason: string) => Promise<void>;
  exportInvoice: (
    invoiceId: string,
    changedBy: string,
  ) => Promise<{ orderNumber: string; attached: boolean }>;
  confirmInvoiceForApproval: (invoiceId: string, changedBy: string) => Promise<void>;
  // Confirmacion de orden de compra (Dias 7-9): registro solo-portal, nunca
  // escribe a BC directo — ver rpc_confirm_purchase_order en schema-v4.sql.
  confirmPurchaseOrder: (
    orderId: string,
    userId: string,
    action: "confirmed" | "change_requested",
    input?: { newExpectedDate?: string | null; reason?: string | null; comments?: string | null },
  ) => Promise<void>;
  // Captura manual de los datos que hoy nadie llena (el webhook de OCR del
  // proveedor original nunca se conecto). El proveedor completa esto antes
  // de confirmar — son los datos que Fase A necesita para exportar a
  // Business Central (fecha de factura + NCF), mas el total.
  //
  // Dias 10-13: valida duplicado (mismo vendor + mismo numero de factura,
  // ver indice unico en schema-v5.sql) y que el total no supere el monto de
  // la orden de compra vinculada. Se omite intencionalmente la validacion
  // de cantidades por linea porque este rebuild no tiene un formulario de
  // carga de lineas de factura (ver comentario en Invoices.tsx: "se omite
  // el formulario para agregar lineas de factura manualmente") — no hay
  // contra que validar cantidad todavia.
  updateInvoiceData: (
    invoiceId: string,
    patch: { invoiceNumber: string; invoiceDate: string; invoiceTaxNumber: string; totalAmount: number },
  ) => Promise<void>;
  // Eliminar factura cargada por error (pedido Key Players, 2026-09-01,
  // item 2). Solo mientras sigue en draft/uploaded -- reforzado server-side
  // por la policy "scoped delete" (schema-v20.sql), esto no es la unica
  // barrera. Borra el archivo de Storage ANTES que la fila de invoices: la
  // policy de delete de storage.objects valida contra la fila de invoices
  // todavia existente (status draft/uploaded) -- si se borrara la fila
  // primero, la policy de storage ya no encontraria con que validar y el
  // archivo quedaria huerfano sin poder borrarse. changedBy es quien lo pide
  // (mismo patron que approveInvoice/rejectInvoice) -- queda registrado en
  // security_audit_log, no en invoice_status_history (esa tabla cascadea y
  // desaparece junto con la fila de invoices que se borra).
  deleteInvoice: (invoiceId: string, changedBy: string) => Promise<void>;
  uploadInvoice: (input: {
    companyId: string;
    purchaseOrderId: string | null;
    vendorId: string | null;
    invoiceNumber: string;
    vendorName: string;
    vendorTaxId: string;
    file: File;
    uploadedByUserId: string;
  }) => Promise<{ invoiceId: string }>;
  // Perfil-only: crear el auth.users real requiere la Admin API con
  // service_role, que NO se puede invocar de forma segura desde el
  // navegador con la clave anon. En produccion esto necesita una Edge
  // Function propia que reciba el JWT del admin, valide el rol server-side,
  // y llame a la Admin API. Aqui solo se gestiona la fila de user_profiles
  // para un auth.users que ya exista (p.ej. creado por invitacion).
  // Dias 20-08: pasa por rpc_update_user_profile (SECURITY DEFINER) en vez
  // de un UPDATE directo -- registra el cambio en security_audit_log
  // (quien lo hizo, antes/despues). changedBy es el admin que lo pide,
  // nunca se infiere del lado del cliente.
  updateUser: (
    userId: string,
    changedBy: string,
    patch: { role: PortalUser["role"]; companyId: string | null; isActive: boolean },
  ) => Promise<void>;
  // Baja definitiva de cuenta -- exclusivo de superadmin (invite-user
  // Edge Function lo revalida server-side). Primera capacidad real que
  // distingue superadmin de admin.
  deleteUser: (userId: string) => Promise<void>;
  // Reset de password real (2026-08-24): dispara reset-user-password, que
  // valida el rol server-side y llama a resetPasswordForEmail (correo real
  // via SMTP, plantilla recovery.html) -- reemplaza el reset manual por
  // script que se hacia antes de esto.
  resetUserPassword: (userId: string) => Promise<{ email: string }>;
  // URL firmada temporal (60s) para descargar el PDF de una factura ya
  // subida -- el bucket "invoices" es privado, no hay URL publica directa.
  downloadInvoiceFile: (filePath: string) => Promise<string>;
  // Adjuntos de la Orden de Compra en BC (Key Players, 2026-09-01, item 5).
  // No se persiste nada en Supabase -- se consulta a BC en vivo cada vez
  // (bc-order-attachments), porque el equipo de Adsemble puede agregar/
  // sacar adjuntos ahi en cualquier momento y no tiene sentido mantenerlo
  // sincronizado aparte solo para mostrar una lista.
  fetchOrderAttachments: (
    orderId: string,
  ) => Promise<{ id: string; fileName: string; byteSize: number; lastModifiedDateTime: string }[]>;
  downloadOrderAttachment: (orderId: string, attachmentId: string, fileName: string, mode?: "view" | "download") => Promise<void>;
  // Onboarding real (2026-08-20): invita un login nuevo de verdad, via la
  // Edge Function invite-user (Admin API + user_profiles + user_vendor_mapping
  // en una sola llamada). Reemplaza el placeholder anterior donde "Crear
  // usuario" no existia porque no se podia hacer de forma segura desde el
  // navegador con la clave anon.
  createUser: (input: {
    email: string;
    role: PortalUser["role"];
    companyId: string | null;
    vendorId: string | null;
    username?: string;
  }) => Promise<void>;
  // "Pendiente de Pago" (punto 6 del informe): la API estandar de BC no
  // expone vendor ledger entries, asi que este dato NO viaja sincronizado
  // desde BC — es un campo manual que un admin ingresa en el portal. Ver
  // plan Fase A, seccion "Gap real encontrado para el punto 6".
  setInvoicePaymentDueDate: (invoiceId: string, paymentDueDate: string | null) => Promise<void>;
  // Dias 13-15: marca una factura "processed" como pagada. Registro
  // solo-portal (no sincroniza con BC, ver schema-v6.sql) — mismo patron
  // que rpc_confirm_purchase_order: unico camino de escritura, revalida rol
  // server-side.
  markInvoicePaid: (
    invoiceId: string,
    changedBy: string,
    paidAt: string,
    paymentReference?: string | null,
  ) => Promise<void>;
  // Fetch propio de Suppliers.tsx (Key Players, 2026-09-01, item 7):
  // `suppliers` del store global ahora solo trae los vendors referenciados
  // por lo que ya esta cargado (ver comentario en fetchAll) -- la unica
  // pantalla que necesita navegar/buscar TODOS los proveedores llama esto
  // aparte, una vez al entrar, en vez de depender del slice compartido.
  fetchAllSuppliers: () => Promise<Supplier[]>;
  // Filtros de Ordenes de Compra del lado servidor (Key Players, 2026-09-01,
  // item 6): antes Orders.tsx filtraba a mano sobre TODAS las ordenes ya
  // traidas por fetchAll(). Esto pagina/filtra en la base -- crece bien
  // aunque el volumen de ordenes aumente mucho, a diferencia del filtro en
  // memoria de antes. El aislamiento de proveedor NO se arma aca a mano --
  // lo sigue garantizando "scoped read" (schema-v3.sql) sobre CUALQUIER
  // forma de esta query, igual que ya pasaba con el fetch completo.
  fetchPurchaseOrdersPage: (input: {
    page: number;
    pageSize: number;
    orderNumber?: string;
    status?: PurchaseOrderStatus | "all";
    dateFrom?: string | null;
    dateTo?: string | null;
    vendorId?: string | null;
    companyId?: string | null;
  }) => Promise<{ rows: PurchaseOrder[]; totalCount: number }>;
  // Los 4 numeros de las tarjetas de Orders.tsx reflejan TODO el alcance
  // del usuario (no lo tecleado en busqueda/status) -- no pueden salir de
  // una sola pagina de 20 filas, se calculan en la base (rpc_purchase_order_
  // stats, schema-v21.sql) en vez de sumar sobre filas ya traidas.
  fetchPurchaseOrderStats: (companyId: string | null) => Promise<{ active: number; drafts: number; pending: number; totalValue: number }>;
}

export const useDomainStore = create<DomainStore>((set, get) => ({
  invoices: [],
  invoiceLines: [],
  purchaseOrders: [],
  purchaseOrderLines: [],
  purchaseOrderReceipts: [],
  suppliers: [],
  companies: [],
  users: [],
  auditEvents: [],
  loading: false,
  error: null,

  // Key Players (2026-09-01, item 7 -- performance): hasta aca, `vendors`
  // se traia COMPLETA en cada fetchAll() -- y fetchAll() corre no solo al
  // entrar, sino DESPUES DE CADA MUTACION de toda la app (aprobar, subir,
  // confirmar, exportar, eliminar...). Medido en vivo antes de este cambio
  // (docs/BITACORA.md): 10.441 filas de vendors -> 11 requests paginados
  // secuenciales -> fetchAll() completo tardaba 2.339ms, la gran mayoria de
  // ese tiempo en esas 11 vueltas. El resto de las tablas son chicas (20-36
  // filas) y no explican la lentitud reportada.
  //
  // La app en realidad solo necesita, en el 99% de las pantallas, los
  // vendors que aparecen en las invoices/ordenes/recepciones YA cargadas
  // (para mostrar nombre/RNC al lado de cada fila) -- no la tabla entera.
  // La UNICA pantalla que de verdad necesita navegar TODOS los proveedores
  // es Suppliers.tsx (el listado/búsqueda de proveedores), que ahora tiene
  // su propio fetch independiente (fetchAllSuppliers, abajo) en vez de
  // depender de este slice compartido.
  async fetchAll() {
    set({ loading: true, error: null });
    try {
      const [invoicesRes, invoiceLinesRes, ordersRes, orderLinesRes, receiptsRes, companiesRes, usersRes, auditRes] =
        await Promise.all([
          supabase.from("invoices").select("*").order("created_at", { ascending: false }),
          supabase.from("invoice_lines").select("*").order("sequence", { ascending: true }),
          // purchase_orders paginado igual que vendors -- mismo riesgo de
          // truncado silencioso a 1000 filas si crece (hoy 21, sin
          // impacto de performance real todavia, es una salvaguarda).
          fetchAllRows<Record<string, unknown>>("purchase_orders"),
          supabase.from("purchase_orders_lines").select("*").order("sequence", { ascending: true }),
          supabase.from("purchase_order_receipts").select("*").order("posting_date", { ascending: false }),
          supabase.from("companies").select("*").is("disabled_at", null),
          supabase.from("user_profiles").select("*").order("username", { ascending: true }),
          supabase.from("invoice_status_history").select("*").order("changed_at", { ascending: false }).limit(100),
        ]);

      // Solo los vendor_id que de verdad aparecen en lo que se acaba de
      // cargar -- normalmente unas pocas decenas, nunca la tabla completa.
      // RLS de "vendors" ya sigue aplicando sobre este .in() igual que
      // sobre cualquier otra query -- esto no amplia lo que cada rol puede
      // ver, solo evita traer de mas lo que ya no iba a mostrarse.
      const referencedVendorIds = Array.from(
        new Set(
          [
            ...(invoicesRes.data ?? []).map((r) => r.vendor_id as string | null),
            ...ordersRes.map((r) => (r as { vendor_id: string | null }).vendor_id),
          ].filter((id): id is string => !!id),
        ),
      );
      const suppliersRows =
        referencedVendorIds.length > 0
          ? (await supabase.from("vendors").select("*").in("id", referencedVendorIds)).data ?? []
          : [];

      // ordersRes ya no es {data,error} -- fetchAllRows tira (throw) directo
      // si alguna pagina falla, lo agarra el catch de aca abajo.
      const firstError =
        invoicesRes.error ?? invoiceLinesRes.error ?? orderLinesRes.error ?? receiptsRes.error ?? companiesRes.error ?? usersRes.error ?? auditRes.error;
      if (firstError) throw firstError;

      set({
        invoices: (invoicesRes.data ?? []).map(mapInvoice),
        invoiceLines: (invoiceLinesRes.data ?? []).map(mapInvoiceLine),
        purchaseOrders: ordersRes.map(mapPurchaseOrder),
        purchaseOrderLines: (orderLinesRes.data ?? []).map(mapPurchaseOrderLine),
        purchaseOrderReceipts: (receiptsRes.data ?? []).map(mapPurchaseOrderReceipt),
        suppliers: suppliersRows.map(mapSupplier),
        companies: (companiesRes.data ?? []).map(mapCompany),
        users: (usersRes.data ?? []).map(mapUser),
        auditEvents: (auditRes.data ?? []).map(mapAuditEvent),
        loading: false,
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), loading: false });
    }
  },

  async fetchAllSuppliers() {
    const rows = await fetchAllRows<Record<string, unknown>>("vendors");
    return rows.map(mapSupplier);
  },

  async fetchPurchaseOrdersPage(input) {
    const from = input.page * input.pageSize;
    const to = from + input.pageSize - 1;
    let query = supabase.from("purchase_orders").select("*", { count: "exact" });

    if (input.orderNumber?.trim()) query = query.ilike("order_number", `%${input.orderNumber.trim()}%`);
    if (input.status && input.status !== "all") query = query.eq("status", input.status);
    if (input.dateFrom) query = query.gte("order_date", input.dateFrom);
    if (input.dateTo) query = query.lte("order_date", input.dateTo);
    if (input.vendorId) query = query.eq("vendor_id", input.vendorId);
    if (input.companyId) query = query.eq("company_id", input.companyId);

    const { data, error, count } = await query.order("order_date", { ascending: false }).range(from, to);
    if (error) throw error;
    return { rows: (data ?? []).map(mapPurchaseOrder), totalCount: count ?? 0 };
  },

  async fetchPurchaseOrderStats(companyId) {
    const { data, error } = await supabase.rpc("rpc_purchase_order_stats", { p_company_id: companyId, p_vendor_id: null });
    if (error) throw error;
    const row = (data as { active_count: number; draft_count: number; pending_count: number; total_value: number }[])[0];
    return {
      active: Number(row?.active_count ?? 0),
      drafts: Number(row?.draft_count ?? 0),
      pending: Number(row?.pending_count ?? 0),
      totalValue: Number(row?.total_value ?? 0),
    };
  },

  async approveInvoice(invoiceId, changedBy) {
    const { error } = await supabase.rpc("rpc_update_invoice_status", {
      p_invoice_id: invoiceId,
      p_status: "approved",
      p_changed_by: changedBy,
      p_reason: null,
    });
    if (error) throw error;
    await get().fetchAll();
  },

  async rejectInvoice(invoiceId, changedBy, reason) {
    const { error } = await supabase.rpc("rpc_update_invoice_status", {
      p_invoice_id: invoiceId,
      p_status: "rejected",
      p_changed_by: changedBy,
      p_reason: reason,
    });
    if (error) throw error;
    await get().fetchAll();
  },

  // Exportacion real a Business Central (Fase A). Rediseñado 2026-09-02
  // (pedido de Jonatan): ya NO crea ninguna Factura de Compra en BC -- solo
  // completa la seccion General de la Orden de Compra vinculada (fecha,
  // Nº factura, NCF) y adjunta el PDF ahi. Ver el comentario grande al
  // principio de bc-export-invoice/index.ts para el porque del cambio.
  async exportInvoice(invoiceId, changedBy) {
    const { data, error } = await supabase.functions.invoke("bc-export-invoice", {
      body: { invoiceId, changedBy },
    });
    if (error) {
      // Encontrado en /qa 2026-08-29: cuando la Edge Function responde con un
      // status no-2xx (422/500, que es como bc-export-invoice reporta TODOS
      // sus errores de negocio -- orden sin vincular, sin bc_id, sin NCF,
      // fallo de BC, etc.), supabase-js NUNCA parsea el cuerpo JSON de la
      // respuesta -- error.message queda en el generico "Edge Function
      // returned a non-2xx status code" y el mensaje real (`{ok:false,
      // error:"..."}`) se pierde. El popup de "Exportar ahora" mostraba ese
      // generico en vez del motivo real. El cuerpo real esta en
      // error.context (el Response crudo), asi que hay que leerlo a mano.
      const context = (error as { context?: Response }).context;
      let parsedMessage: string | null = null;
      if (context) {
        try {
          const body = await context.clone().json();
          if (body?.error) parsedMessage = body.error as string;
        } catch {
          // el cuerpo no era JSON parseable -- cae al error generico de abajo
        }
      }
      throw parsedMessage ? new Error(parsedMessage) : error;
    }
    if (!data?.ok) throw new Error(data?.error ?? "La exportacion a Business Central fallo");
    await get().fetchAll();
    return { orderNumber: data.orderNumber as string, attached: !!data.attached };
  },

  async updateInvoiceData(invoiceId, patch) {
    const current = get().invoices.find((inv) => inv.id === invoiceId);
    if (!current) throw new Error("Factura no encontrada.");

    const invoiceNumber = patch.invoiceNumber.trim();

    // Duplicado: mismo proveedor + mismo numero de factura ya existente en
    // otra factura. El bundle original mostraba un modal para esto al subir
    // (ver comentario en Invoices.tsx) — aqui se valida con un mensaje
    // explicito antes de guardar, en vez de dejar que falle el indice unico
    // de base de datos (schema-v5.sql) sin contexto para el usuario.
    if (invoiceNumber && current.supplierId) {
      const { data: duplicate, error: dupError } = await supabase
        .from("invoices")
        .select("id")
        .eq("vendor_id", current.supplierId)
        .eq("invoice_number", invoiceNumber)
        .neq("id", invoiceId)
        .maybeSingle();
      if (dupError) throw dupError;
      if (duplicate) {
        throw new Error(`Ya existe una factura con el numero "${invoiceNumber}" para este proveedor.`);
      }
    }

    // Duplicado por NCF (2026-08-25, pedido de Jonatan): el NCF es el
    // identificador fiscal real y unico ante la DGII -- a diferencia de
    // invoice_number (que cada proveedor arma como quiera), asi que es un
    // filtro mas confiable para evitar que se suba/confirme la misma
    // factura dos veces. Mismo patron que el chequeo de arriba: indice
    // unico de respaldo en schema-v12.sql.
    const invoiceTaxNumber = patch.invoiceTaxNumber.trim();
    if (invoiceTaxNumber && current.supplierId) {
      const { data: duplicateNcf, error: dupNcfError } = await supabase
        .from("invoices")
        .select("id")
        .eq("vendor_id", current.supplierId)
        .eq("invoice_tax_number", invoiceTaxNumber)
        .neq("id", invoiceId)
        .maybeSingle();
      if (dupNcfError) throw dupNcfError;
      if (duplicateNcf) {
        throw new Error(`Ya existe una factura con el NCF "${invoiceTaxNumber}" para este proveedor.`);
      }
    }

    // Monto: si la factura esta vinculada a una orden de compra, el total
    // acumulado de TODAS las facturas de esa orden (esta incluida) no puede
    // superar el monto de la orden. Antes solo comparaba esta factura sola
    // contra el monto completo -- con varias facturas sobre la misma orden
    // (soportado desde 2026-08-26, ver plan de observaciones de usuarios)
    // eso dejaba pasar un total combinado mayor al de la orden. Se excluyen
    // las rechazadas: una factura rechazada no deberia seguir "reservando"
    // presupuesto de la orden.
    if (current.purchaseOrderId) {
      const order = get().purchaseOrders.find((po) => po.id === current.purchaseOrderId);
      if (order) {
        const othersTotal = get()
          .invoices.filter(
            (inv) => inv.id !== invoiceId && inv.purchaseOrderId === current.purchaseOrderId && inv.status !== "rejected",
          )
          .reduce((sum, inv) => sum + inv.total, 0);
        const combinedTotal = othersTotal + patch.totalAmount;
        if (combinedTotal > order.amount) {
          throw new Error(
            othersTotal > 0
              ? `El total de esta factura (${patch.totalAmount.toFixed(2)}) sumado a lo ya facturado en esta orden (${othersTotal.toFixed(2)}) supera el monto de la orden de compra (${order.amount.toFixed(2)}).`
              : `El total de la factura (${patch.totalAmount.toFixed(2)}) supera el monto de la orden de compra vinculada (${order.amount.toFixed(2)}).`,
          );
        }
      }
    }

    const { error } = await supabase
      .from("invoices")
      .update({
        invoice_number: invoiceNumber,
        invoice_date: patch.invoiceDate,
        invoice_tax_number: invoiceTaxNumber,
        total_amount: patch.totalAmount,
      })
      .eq("id", invoiceId);
    if (error) throw error;
    await get().fetchAll();
  },

  // Replica `confirmInvoiceForApproval`: el proveedor confirma que los datos
  // extraidos por OCR son correctos y la factura pasa a pending_approval.
  //
  // Antes llamaba al RPC generico rpc_update_invoice_status, que no valida
  // nada -- la obligatoriedad de fecha/NCF/numero/total vivia solo en
  // Invoices.tsx (handleConfirm), saltable llamando el RPC directo. Ahora
  // usa rpc_confirm_invoice_for_approval (schema-v15.sql), que re-valida
  // esos campos sobre el estado ACTUAL de la fila (ya escrito por
  // updateInvoiceData justo antes) antes de permitir la transicion.
  async confirmInvoiceForApproval(invoiceId, changedBy) {
    const { error } = await supabase.rpc("rpc_confirm_invoice_for_approval", {
      p_invoice_id: invoiceId,
      p_user_id: changedBy,
    });
    if (error) throw error;
    await get().fetchAll();
  },

  // Pedido Key Players (2026-09-01), item 2: eliminar una factura cargada
  // por error, mientras no haya sido enviada todavia. El unico camino real
  // es este -- server-side lo re-valida la policy "scoped delete"
  // (schema-v20.sql: admin/superadmin sin restriccion, proveedor solo
  // sobre lo suyo y solo en draft/uploaded), asi que un intento de borrar
  // algo fuera de ese alcance falla en el DELETE mismo, no silenciosamente.
  //
  // Orden importa: se borra el archivo de Storage ANTES que la fila de
  // invoices -- la policy de delete de storage.objects valida contra esa
  // fila (status draft/uploaded) todavia existente; si se borrara la fila
  // primero, el archivo quedaria huerfano e imposible de limpiar despues
  // (la policy ya no tendria contra que validar el file_path).
  //
  // No hace falta "desbloquear" la orden aparte -- uploadInvoice nunca toca
  // purchase_orders.status, asi que en cuanto la fila de invoices
  // desaparece, el chequeo de "ya tiene factura activa" (aca y en el
  // trigger de la base) deja de encontrar nada y la orden vuelve a admitir
  // una carga nueva sola.
  async deleteInvoice(invoiceId, changedBy) {
    const invoice = get().invoices.find((inv) => inv.id === invoiceId);
    if (!invoice) throw new Error("Factura no encontrada.");
    if (invoice.status !== "draft" && invoice.status !== "uploaded") {
      throw new Error("Esta factura ya fue enviada para aprobacion -- no se puede eliminar.");
    }

    if (invoice.filePath) {
      const { error: removeError } = await supabase.storage.from("invoices").remove([invoice.filePath]);
      if (removeError) throw removeError;
    }

    const { error, count } = await supabase.from("invoices").delete({ count: "exact" }).eq("id", invoiceId);
    if (error) throw error;
    // count en 0 sin error = la RLS descarto la fila silenciosamente (no es
    // tuya, o ya no esta en draft/uploaded) -- Supabase no lo reporta como
    // error, hay que chequearlo a mano para no mostrar "eliminado" en falso.
    if (!count) throw new Error("No se pudo eliminar la factura (sin permiso o ya no esta en un estado eliminable).");

    // No es fatal si el log falla -- la factura ya se borro correctamente,
    // que el registro de auditoria no ande no deberia dejar al usuario con
    // un error confuso sobre algo que si funciono.
    try {
      await supabase.from("security_audit_log").insert({
        event_type: "invoice_deleted",
        actor_user_id: changedBy,
        detail: {
          invoiceId: invoice.id,
          purchaseOrderId: invoice.purchaseOrderId,
          vendorId: invoice.supplierId ?? null,
          invoiceNumber: invoice.invoiceNumber || null,
          filePath: invoice.filePath,
        },
      });
    } catch (logErr) {
      console.error("No se pudo registrar invoice_deleted en security_audit_log:", logErr);
    }

    await get().fetchAll();
  },

  // El bundle original llamaba a un webhook externo de OCR (ver
  // extraido/03-automatizacion.md) que nunca se conecto en esta
  // reconstruccion. Aqui se sube el PDF real a Storage (bucket "invoices"),
  // se crea la factura en estado "uploaded", y se invoca extract-invoice-data
  // (OCR self-hosted con Tesseract, sin servicios de pago de terceros) para
  // pre-llenar fecha/NCF antes de que el proveedor confirme. Es best-effort:
  // si el OCR falla o no encuentra nada, la factura queda igual que antes —
  // el formulario de InvoiceDetail sigue siendo editable a mano.
  async uploadInvoice(input) {
    const allowedTypes = ["application/pdf", "image/jpeg", "image/png"];
    if (input.file.type && !allowedTypes.includes(input.file.type)) {
      throw new Error("Solo se permite subir la factura en PDF o como foto (JPG/PNG).");
    }

    // Pedido Key Players (2026-09-01), item 1: 1 Orden de Compra = 1
    // Factura. Este chequeo es solo para dar un mensaje claro ANTES de subir
    // el archivo -- la garantia real es el trigger
    // check_one_active_invoice_per_po (schema-v20.sql), que corre server-side
    // sobre el INSERT mismo y no se puede saltar llamando la API directo.
    if (input.purchaseOrderId) {
      const hasActiveInvoice = get().invoices.some(
        (inv) => inv.purchaseOrderId === input.purchaseOrderId && inv.status !== "rejected",
      );
      if (hasActiveInvoice) {
        throw new Error("Esta orden de compra ya tiene una factura asociada. Eliminala primero si fue un error.");
      }
    }

    const filePath = `${input.companyId}/${crypto.randomUUID()}-${input.file.name}`;
    const { error: uploadError } = await supabase.storage
      .from("invoices")
      .upload(filePath, input.file, { contentType: input.file.type || "application/pdf" });
    if (uploadError) throw uploadError;

    const { data, error } = await supabase
      .from("invoices")
      .insert({
        company_id: input.companyId,
        purchase_order_id: input.purchaseOrderId,
        vendor_id: input.vendorId,
        invoice_number: input.invoiceNumber,
        vendor_name: input.vendorName,
        vendor_tax_id: input.vendorTaxId,
        filename: input.file.name,
        file_path: filePath,
        status: "uploaded",
        changed_by_user_id: input.uploadedByUserId,
      })
      .select("id")
      .single();
    if (error) throw error;

    try {
      await supabase.functions.invoke("extract-invoice-data", { body: { invoiceId: data.id } });
    } catch {
      // best-effort: si el OCR falla, el proveedor completa a mano.
    }

    await get().fetchAll();
    return { invoiceId: data.id as string };
  },

  async confirmPurchaseOrder(orderId, userId, action, input) {
    const { error } = await supabase.rpc("rpc_confirm_purchase_order", {
      p_order_id: orderId,
      p_user_id: userId,
      p_action: action,
      p_new_expected_date: input?.newExpectedDate ?? null,
      p_reason: input?.reason ?? null,
      p_comments: input?.comments ?? null,
    });
    if (error) throw error;
    await get().fetchAll();
  },

  async setInvoicePaymentDueDate(invoiceId, paymentDueDate) {
    const { error } = await supabase.from("invoices").update({ payment_due_date: paymentDueDate }).eq("id", invoiceId);
    if (error) throw error;
    await get().fetchAll();
  },

  async markInvoicePaid(invoiceId, changedBy, paidAt, paymentReference) {
    const { error } = await supabase.rpc("rpc_mark_invoice_paid", {
      p_invoice_id: invoiceId,
      p_changed_by: changedBy,
      p_paid_at: paidAt,
      p_payment_reference: paymentReference ?? null,
    });
    if (error) throw error;
    await get().fetchAll();
  },

  async createUser(input) {
    const { data, error } = await supabase.functions.invoke("invite-user", {
      body: {
        email: input.email,
        role: input.role,
        companyId: input.companyId,
        vendorId: input.vendorId,
        username: input.username,
      },
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error ?? "No se pudo invitar al usuario");
    await get().fetchAll();
  },

  async updateUser(userId, changedBy, patch) {
    const { error } = await supabase.rpc("rpc_update_user_profile", {
      p_target_user_id: userId,
      p_changed_by: changedBy,
      p_role: patch.role,
      p_company_id: patch.companyId,
      p_active: patch.isActive,
    });
    if (error) throw error;
    await get().fetchAll();
  },

  async deleteUser(userId) {
    const { data, error } = await supabase.functions.invoke("delete-user", { body: { userId } });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error ?? "No se pudo eliminar el usuario");
    await get().fetchAll();
  },

  async resetUserPassword(userId) {
    const { data, error } = await supabase.functions.invoke("reset-user-password", { body: { userId } });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error ?? "No se pudo enviar el correo de reset");
    return { email: data.email as string };
  },

  async downloadInvoiceFile(filePath) {
    const { data, error } = await supabase.storage.from("invoices").createSignedUrl(filePath, 60);
    if (error) throw error;
    if (!data?.signedUrl) throw new Error("No se pudo generar el enlace de descarga");
    return data.signedUrl;
  },

  async fetchOrderAttachments(orderId) {
    const { data, error } = await supabase.functions.invoke("bc-order-attachments", { body: { orderId, action: "list" } });
    if (error) {
      // Mismo problema que ya se documento en exportInvoice: en un status
      // no-2xx supabase-js no parsea el body, hay que leerlo a mano de
      // error.context para no perder el motivo real.
      const context = (error as { context?: Response }).context;
      let parsedMessage: string | null = null;
      if (context) {
        try {
          const body = await context.clone().json();
          if (body?.error) parsedMessage = body.error as string;
        } catch {
          // no era JSON -- cae al error generico
        }
      }
      throw parsedMessage ? new Error(parsedMessage) : error;
    }
    if (!data?.ok) throw new Error(data?.error ?? "No se pudieron obtener los adjuntos de la orden");
    return data.attachments as { id: string; fileName: string; byteSize: number; lastModifiedDateTime: string }[];
  },

  async downloadOrderAttachment(orderId, attachmentId, fileName, mode = "download") {
    const { data, error } = await supabase.functions.invoke("bc-order-attachments", {
      body: { orderId, action: "download", attachmentId, fileName },
    });
    if (error) {
      const context = (error as { context?: Response }).context;
      let parsedMessage: string | null = null;
      if (context) {
        try {
          const body = await context.clone().json();
          if (body?.error) parsedMessage = body.error as string;
        } catch {
          // el cuerpo del error era el binario/no-JSON -- cae al error generico
        }
      }
      throw parsedMessage ? new Error(parsedMessage) : error;
    }
    // Content-Type real (PDF, imagen, etc.) -- supabase-js ya devuelve un
    // Blob para respuestas que no son JSON/texto, no hace falta parsear nada.
    const blob = data as Blob;
    const url = URL.createObjectURL(blob);
    if (mode === "view") {
      // Sin el atributo download -- el navegador la abre inline si puede
      // (PDF/imagen), en vez de forzar el guardado.
      window.open(url, "_blank", "noopener,noreferrer");
    } else {
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    // No se revoca de inmediato en modo "view": la pestaña nueva todavia
    // necesita el blob URL vivo para poder cargarlo -- el navegador lo
    // libera solo cuando se cierra esa pestaña/proceso.
    if (mode !== "view") URL.revokeObjectURL(url);
  },
}));
