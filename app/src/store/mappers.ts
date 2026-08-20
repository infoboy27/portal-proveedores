import type {
  AuditEvent,
  Invoice,
  InvoiceLine,
  PortalCompany,
  PortalUser,
  PurchaseOrder,
  PurchaseOrderLine,
  PurchaseOrderReceipt,
  Supplier,
} from "./types";

// Supabase devuelve las filas en snake_case (nombres reales de columna, ver
// schema.sql). La app usa camelCase internamente (igual que el bundle
// original). Estos mappers son el unico lugar que conoce ambos formatos.

export function mapInvoice(row: Record<string, unknown>): Invoice {
  return {
    id: row.id as string,
    companyId: row.company_id as string,
    purchaseOrderId: (row.purchase_order_id as string) ?? null,
    supplierId: (row.vendor_id as string) ?? undefined,
    vendorName: (row.vendor_name as string) ?? "",
    vendorTaxId: (row.vendor_tax_id as string) ?? "",
    invoiceNumber: (row.invoice_number as string) ?? "",
    invoiceTaxNumber: (row.invoice_tax_number as string) ?? "",
    invoiceTaxSecurityNumber: (row.invoice_tax_security_number as string) ?? "",
    invoiceDate: row.invoice_date as string,
    invoiceDuedate: (row.invoice_duedate as string) ?? null,
    fiscalDuedate: (row.fiscal_duedate as string) ?? null,
    subtotalAmount: Number(row.subtotal_amount ?? 0),
    discountAmount: Number(row.discount_amount ?? 0),
    totalTaxAmount: Number(row.total_tax_amount ?? 0),
    total: Number(row.total_amount ?? 0),
    status: row.status as Invoice["status"],
    filePath: (row.file_path as string) ?? null,
    filename: (row.filename as string) ?? null,
    validInvoiceTaxNumber: (row.valid_invoice_tax_number as boolean) ?? null,
    rejectionReason: (row.rejection_reason as string) ?? null,
    taxId: (row.vendor_tax_id as string) ?? undefined,
    erpId: (row.erp_id as string) ?? null,
    bcInvoiceId: (row.bc_invoice_id as string) ?? null,
    bcInvoiceNumber: (row.bc_invoice_number as string) ?? null,
    exportErrorReason: (row.export_error_reason as string) ?? null,
    exportedAt: (row.exported_at as string) ?? null,
    paymentDueDate: (row.payment_due_date as string) ?? null,
    paidAt: (row.paid_at as string) ?? null,
    paymentReference: (row.payment_reference as string) ?? null,
    paymentSource: (row.payment_source as Invoice["paymentSource"]) ?? null,
    bcLedgerEntryNo: (row.bc_ledger_entry_no as string) ?? null,
    updatedAt: (row.updated_at as string) ?? (row.created_at as string) ?? "",
    createdAt: (row.created_at as string) ?? "",
  };
}

export function mapInvoiceLine(row: Record<string, unknown>): InvoiceLine {
  return {
    id: row.id as string,
    invoiceId: row.invoice_id as string,
    companyId: (row.company_id as string) ?? null,
    description: (row.description as string) ?? null,
    quantity: row.quantity != null ? Number(row.quantity) : null,
    price: row.price != null ? Number(row.price) : null,
    amount: row.amount != null ? Number(row.amount) : null,
    sequence: row.sequence != null ? Number(row.sequence) : null,
  };
}

export function mapPurchaseOrder(row: Record<string, unknown>): PurchaseOrder {
  return {
    id: row.id as string,
    companyId: row.company_id as string,
    vendorId: row.vendor_id as string,
    orderNumber: (row.order_number as string) ?? "",
    description: (row.description as string) ?? "",
    orderDate: (row.order_date as string) ?? null,
    amount: Number(row.amount ?? 0),
    status: (row.status as PurchaseOrder["status"]) ?? "open",
    confirmationStatus: (row.confirmation_status as PurchaseOrder["confirmationStatus"]) ?? "pending",
    sequence: Number(row.sequence ?? 0),
    bcId: (row.bc_id as string) ?? null,
  };
}

export function mapPurchaseOrderLine(row: Record<string, unknown>): PurchaseOrderLine {
  return {
    id: row.id as string,
    orderId: row.order_id as string,
    companyId: (row.company_id as string) ?? null,
    description: (row.description as string) ?? null,
    quantity: row.quantity != null ? Number(row.quantity) : null,
    price: row.price != null ? Number(row.price) : null,
    amount: row.amount != null ? Number(row.amount) : null,
    sequence: row.sequence != null ? Number(row.sequence) : null,
    bcLineType: (row.bc_line_type as string) ?? null,
    bcLineObjectNumber: (row.bc_line_object_number as string) ?? null,
    bcUnitCost: row.bc_unit_cost != null ? Number(row.bc_unit_cost) : null,
    bcTaxCode: (row.bc_tax_code as string) ?? null,
  };
}

export function mapPurchaseOrderReceipt(row: Record<string, unknown>): PurchaseOrderReceipt {
  return {
    id: row.id as string,
    orderId: row.order_id as string,
    companyId: (row.company_id as string) ?? null,
    bcId: (row.bc_id as string) ?? null,
    receiptNumber: (row.receipt_number as string) ?? "",
    vendorShipmentNo: (row.vendor_shipment_no as string) ?? null,
    postingDate: (row.posting_date as string) ?? null,
  };
}

export function mapSupplier(row: Record<string, unknown>): Supplier {
  const status = (row.status as string) ?? "active";
  return {
    id: row.id as string,
    vendorNumber: (row.vendor_number as string) ?? "",
    taxRegistrationNumber: (row.tax_registration_number as string) ?? "",
    displayName: (row.company_name as string) ?? "",
    status,
    blocked: status === "blocked",
    validInvoiceTaxNumber: (row.valid_invoice_tax_number as boolean) ?? undefined,
  };
}

export function mapCompany(row: Record<string, unknown>): PortalCompany {
  return {
    id: row.id as string,
    name: (row.company_name as string) ?? "",
    bcCode: (row.bc_code as string) ?? null,
    disabledAt: (row.disabled_at as string) ?? null,
  };
}

export function mapUser(row: Record<string, unknown>): PortalUser {
  return {
    id: row.id as string,
    username: (row.username as string) ?? "",
    email: (row.email as string) ?? "",
    role: row.role as PortalUser["role"],
    companyId: (row.company_id as string) ?? null,
    isActive: (row.active as boolean) ?? true,
  };
}

export function mapAuditEvent(row: Record<string, unknown>): AuditEvent {
  return {
    id: row.id as string,
    entityId: row.invoice_id as string,
    status: row.status as string,
    changedBy: (row.changed_by as string) ?? "",
    reason: (row.reason as string) ?? null,
    changedAt: row.changed_at as string,
  };
}
