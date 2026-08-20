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
  Supplier,
} from "./types";
import {
  mapAuditEvent,
  mapCompany,
  mapInvoice,
  mapInvoiceLine,
  mapPurchaseOrder,
  mapPurchaseOrderLine,
  mapSupplier,
  mapUser,
} from "./mappers";

// Equivalente a `Re` en el bundle original (store de datos de dominio).
// Los nombres de columnas siguen exactamente extraido/01-esquema-tablas.md;
// el mapeo snake_case -> camelCase vive en mappers.ts.

interface DomainStore {
  invoices: Invoice[];
  invoiceLines: InvoiceLine[];
  purchaseOrders: PurchaseOrder[];
  purchaseOrderLines: PurchaseOrderLine[];
  suppliers: Supplier[];
  companies: PortalCompany[];
  users: PortalUser[];
  auditEvents: AuditEvent[];
  loading: boolean;
  error: string | null;
  fetchAll: () => Promise<void>;
  approveInvoice: (invoiceId: string, changedBy: string) => Promise<void>;
  rejectInvoice: (invoiceId: string, changedBy: string, reason: string) => Promise<void>;
  exportInvoice: (invoiceId: string, changedBy: string) => Promise<void>;
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
  updateUser: (userId: string, patch: { role: PortalUser["role"]; companyId: string | null; isActive: boolean }) => Promise<void>;
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
}

export const useDomainStore = create<DomainStore>((set, get) => ({
  invoices: [],
  invoiceLines: [],
  purchaseOrders: [],
  purchaseOrderLines: [],
  suppliers: [],
  companies: [],
  users: [],
  auditEvents: [],
  loading: false,
  error: null,

  async fetchAll() {
    set({ loading: true, error: null });
    try {
      const [invoicesRes, invoiceLinesRes, ordersRes, orderLinesRes, suppliersRes, companiesRes, usersRes, auditRes] =
        await Promise.all([
          supabase.from("invoices").select("*").order("created_at", { ascending: false }),
          supabase.from("invoice_lines").select("*").order("sequence", { ascending: true }),
          supabase.from("purchase_orders").select("*"),
          supabase.from("purchase_orders_lines").select("*").order("sequence", { ascending: true }),
          supabase.from("vendors").select("*"),
          supabase.from("companies").select("*").is("disabled_at", null),
          supabase.from("user_profiles").select("*"),
          supabase.from("invoice_status_history").select("*").order("changed_at", { ascending: false }).limit(100),
        ]);

      const firstError =
        invoicesRes.error ??
        invoiceLinesRes.error ??
        ordersRes.error ??
        orderLinesRes.error ??
        suppliersRes.error ??
        companiesRes.error ??
        usersRes.error ??
        auditRes.error;
      if (firstError) throw firstError;

      set({
        invoices: (invoicesRes.data ?? []).map(mapInvoice),
        invoiceLines: (invoiceLinesRes.data ?? []).map(mapInvoiceLine),
        purchaseOrders: (ordersRes.data ?? []).map(mapPurchaseOrder),
        purchaseOrderLines: (orderLinesRes.data ?? []).map(mapPurchaseOrderLine),
        suppliers: (suppliersRes.data ?? []).map(mapSupplier),
        companies: (companiesRes.data ?? []).map(mapCompany),
        users: (usersRes.data ?? []).map(mapUser),
        auditEvents: (auditRes.data ?? []).map(mapAuditEvent),
        loading: false,
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), loading: false });
    }
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

  // Exportacion real a Business Central (Fase A): invoca la Edge Function
  // bc-export-invoice, que crea la purchaseInvoice en BC sobre la orden de
  // compra vinculada, copia sus lineas y adjunta el PDF. Reemplaza el stub
  // que solo marcaba "exported" en Supabase sin llamar a BC.
  async exportInvoice(invoiceId, changedBy) {
    const { data, error } = await supabase.functions.invoke("bc-export-invoice", {
      body: { invoiceId, changedBy },
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error ?? "La exportacion a Business Central fallo");
    await get().fetchAll();
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

    // Monto: si la factura esta vinculada a una orden de compra, el total
    // no puede superar el monto de esa orden.
    if (current.purchaseOrderId) {
      const order = get().purchaseOrders.find((po) => po.id === current.purchaseOrderId);
      if (order && patch.totalAmount > order.amount) {
        throw new Error(
          `El total de la factura (${patch.totalAmount.toFixed(2)}) supera el monto de la orden de compra vinculada (${order.amount.toFixed(2)}).`,
        );
      }
    }

    const { error } = await supabase
      .from("invoices")
      .update({
        invoice_number: invoiceNumber,
        invoice_date: patch.invoiceDate,
        invoice_tax_number: patch.invoiceTaxNumber,
        total_amount: patch.totalAmount,
      })
      .eq("id", invoiceId);
    if (error) throw error;
    await get().fetchAll();
  },

  // Replica `confirmInvoiceForApproval`: el proveedor confirma que los datos
  // extraidos por OCR son correctos y la factura pasa a pending_approval.
  async confirmInvoiceForApproval(invoiceId, changedBy) {
    const { error } = await supabase.rpc("rpc_update_invoice_status", {
      p_invoice_id: invoiceId,
      p_status: "pending_approval",
      p_changed_by: changedBy,
      p_reason: "confirmed_by_provider",
    });
    if (error) throw error;
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

  async updateUser(userId, patch) {
    const { error } = await supabase
      .from("user_profiles")
      .update({ role: patch.role, company_id: patch.companyId, active: patch.isActive })
      .eq("id", userId);
    if (error) throw error;
    await get().fetchAll();
  },
}));
