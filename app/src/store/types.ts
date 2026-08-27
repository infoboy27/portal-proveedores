// Tipos derivados del esquema recuperado por ingenieria inversa.
// Ver: Portal-proveedores/extraido/01-esquema-tablas.md

export type UserRole = "admin" | "superadmin" | "approver" | "supplier" | "service_uploader";

export type InvoiceStatus =
  | "draft"
  | "uploaded"
  | "pending_approval"
  | "approved"
  | "ready_for_export"
  | "exported"
  | "processed"
  | "rejected"
  | "export_error";

export type PurchaseOrderStatus = "draft" | "open" | "in_review" | "partially_invoiced" | "closed";

// Confirmacion de orden por el proveedor — independiente de `status` (que
// refleja el ciclo de vida en BC). Registro solo-portal, nunca escribe a BC
// directo (ver docs/BUSINESS_CENTRAL_INTEGRATION.md §7).
export type PurchaseOrderConfirmationStatus = "pending" | "confirmed" | "change_requested";

export interface Company {
  companyId: string;
  companyName: string;
  isGlobal?: boolean;
}

export interface SessionState {
  userId: string | null;
  role: UserRole | null;
  companyId: string | null;
  supplierId: string | null;
  activeCompany: Company | null;
  availableCompanies: Company[];
}

export interface Invoice {
  id: string;
  companyId: string;
  purchaseOrderId: string | null;
  supplierId?: string;
  vendorName: string;
  vendorTaxId: string;
  invoiceNumber: string;
  invoiceTaxNumber: string; // NCF
  invoiceTaxSecurityNumber: string;
  invoiceDate: string;
  invoiceDuedate: string | null;
  fiscalDuedate: string | null;
  subtotalAmount: number;
  discountAmount: number;
  totalTaxAmount: number;
  total: number;
  status: InvoiceStatus;
  filePath: string | null;
  filename: string | null;
  pdfUrl?: string | null;
  validInvoiceTaxNumber: boolean | null;
  rejectionReason: string | null;
  taxId?: string;
  erpId: string | null;
  bcInvoiceId: string | null;
  bcInvoiceNumber: string | null;
  exportErrorReason: string | null;
  exportedAt: string | null;
  paymentDueDate: string | null;
  // Dias 13-15: "Pagada" no es un valor nuevo de `status` (que se queda en
  // "processed", igual que hoy) sino un dato derivado de paidAt — evita
  // sumar un estado mas al enum cuando processed+paidAt ya distingue los
  // dos casos ("Pendiente de Pago" vs "Pagada", ver PaymentStatusBadge.tsx).
  paidAt: string | null;
  paymentReference: string | null;
  // 'bc' = escrito por bc-sync-payments (vendorLedgerEntries reales);
  // 'manual' o null = entrada manual (setInvoicePaymentDueDate/markInvoicePaid).
  paymentSource: "manual" | "bc" | null;
  bcLedgerEntryNo: string | null;
  updatedAt: string;
  createdAt: string;
}

export interface InvoiceLine {
  id: string;
  invoiceId: string;
  companyId: string | null;
  description: string | null;
  quantity: number | null;
  price: number | null;
  amount: number | null;
  sequence: number | null;
}

export interface PurchaseOrder {
  id: string;
  companyId: string;
  vendorId: string;
  orderNumber: string;
  description: string;
  orderDate: string | null;
  amount: number;
  status: PurchaseOrderStatus;
  confirmationStatus: PurchaseOrderConfirmationStatus;
  sequence: number;
  bcId: string | null;
}

export interface PurchaseOrderLine {
  id: string;
  orderId: string;
  companyId: string | null;
  description: string | null;
  quantity: number | null;
  price: number | null;
  amount: number | null;
  sequence: number | null;
  bcLineType: string | null;
  bcLineObjectNumber: string | null;
  bcUnitCost: number | null;
  bcTaxCode: string | null;
}

export interface PurchaseOrderReceipt {
  id: string;
  orderId: string;
  companyId: string | null;
  bcId: string | null;
  receiptNumber: string;
  vendorShipmentNo: string | null;
  postingDate: string | null;
}

export interface Supplier {
  id: string;
  vendorNumber: string;
  taxRegistrationNumber: string;
  displayName: string;
  email?: string;
  status: string;
  blocked: boolean;
  validInvoiceTaxNumber?: boolean;
  // Sincronizado desde BC (vendorPostingSetups). CPPROV = formal (NCF
  // obligatorio), PROVINFORM = informal, INT = extranjero (NCF opcional
  // para estos dos ultimos) -- ver schema-v15.sql.
  vendorPostingGroup?: string | null;
}

export interface PortalCompany {
  id: string;
  name: string;
  bcCode: string | null;
  disabledAt: string | null;
}

export interface PortalUser {
  id: string;
  username: string;
  email: string;
  role: UserRole;
  companyId: string | null;
  isActive: boolean;
}

export interface AuditEvent {
  id: string;
  entityId: string;
  status: string;
  changedBy: string;
  reason: string | null;
  changedAt: string;
}
