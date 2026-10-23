import { z } from 'zod';
import {
  dateOnly,
  listQuery,
  nonNegativeDecimal,
  positiveDecimal,
  uuid,
} from './common.validator';

export const PAYMENT_METHOD = z.enum([
  'CASH',
  'UPI',
  'BANK_TRANSFER',
  'CREDIT_CARD',
  'DEBIT_CARD',
  'CHEQUE',
  'OTHER',
]);

const lineItemSchema = z.object({
  service: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  quantity: positiveDecimal,
  unitPrice: nonNegativeDecimal,
  discountAmount: nonNegativeDecimal.optional(),
  taxRate: z.coerce.number().min(0).max(100).optional(),
});

// --- Quotations -----------------------------------------------------------

export const QUOTATION_STATUS = z.enum([
  'DRAFT',
  'SENT',
  'ACCEPTED',
  'REJECTED',
  'EXPIRED',
  'CANCELLED',
]);

export const quotationListQuery = listQuery.extend({
  status: QUOTATION_STATUS.optional(),
  clientId: uuid.optional(),
  projectId: uuid.optional(),
  leadId: uuid.optional(),
  needsReview: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

export const createQuotationSchema = z
  .object({
    clientId: uuid.optional(),
    leadId: uuid.optional(),
    projectId: uuid.optional(),
    issueDate: dateOnly,
    validUntil: dateOnly.optional(),
    discountAmount: nonNegativeDecimal.optional(),
    notes: z.string().max(5000).optional(),
    termsAndConditions: z.string().max(10000).optional(),
    items: z.array(lineItemSchema).min(1, 'At least one line item is required').max(100),
  })
  .refine((v) => !v.validUntil || v.validUntil >= v.issueDate, {
    message: 'validUntil cannot be earlier than issueDate',
    path: ['validUntil'],
  })
  .refine((v) => v.clientId || v.leadId, { message: 'Choose a client or a lead', path: ['clientId'] });

export const quotationStatusSchema = z.object({ status: QUOTATION_STATUS });

// --- Invoices -------------------------------------------------------------

export const INVOICE_STATUS = z.enum([
  'DRAFT',
  'SENT',
  'PARTIALLY_PAID',
  'PAID',
  'OVERDUE',
  'CANCELLED',
]);

export const invoiceListQuery = listQuery.extend({
  status: INVOICE_STATUS.optional(),
  clientId: uuid.optional(),
  projectId: uuid.optional(),
  outstanding: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

export const createInvoiceSchema = z
  .object({
    clientId: uuid,
    projectId: uuid.optional(),
    quotationId: uuid.optional(),
    issueDate: dateOnly,
    dueDate: dateOnly.optional(),
    discountAmount: nonNegativeDecimal.optional(),
    notes: z.string().max(5000).optional(),
    items: z.array(lineItemSchema).min(1, 'At least one line item is required').max(100),
  })
  .refine((v) => !v.dueDate || v.dueDate >= v.issueDate, {
    message: 'dueDate cannot be earlier than issueDate',
    path: ['dueDate'],
  });

export const invoiceStatusSchema = z.object({ status: INVOICE_STATUS });

// --- Payments -------------------------------------------------------------

export const PAYMENT_STATUS = z.enum(['PENDING', 'COMPLETED', 'FAILED', 'REFUNDED', 'CANCELLED']);

export const paymentListQuery = listQuery.extend({
  status: PAYMENT_STATUS.optional(),
  paymentMethod: PAYMENT_METHOD.optional(),
  clientId: uuid.optional(),
  projectId: uuid.optional(),
  invoiceId: uuid.optional(),
});

const allocationSchema = z.object({
  invoiceId: uuid,
  amount: positiveDecimal,
  subcategory: z.string().trim().max(160).optional(),
  paidAmount: nonNegativeDecimal.optional(),
});

export const createPaymentSchema = z.object({
  clientId: uuid,
  projectId: uuid.optional(),
  amount: positiveDecimal,
  paymentDate: dateOnly,
  paymentMethod: PAYMENT_METHOD.optional(),
  transactionReference: z.string().trim().max(120).optional(),
  notes: z.string().max(2000).optional(),
  allocations: z.array(allocationSchema).max(50).optional(),
});

export const allocatePaymentSchema = z.object({
  allocations: z.array(allocationSchema).min(1).max(50),
});

export const refundPaymentSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

// --- Expenses -------------------------------------------------------------

export const EXPENSE_APPROVAL_STATUS = z.enum(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED']);

export const expenseListQuery = listQuery.extend({
  approvalStatus: EXPENSE_APPROVAL_STATUS.optional(),
  categoryId: uuid.optional(),
  projectId: uuid.optional(),
  freelancerId: uuid.optional(),
  scope: z.enum(['PROJECT', 'GENERAL']).optional(),
});

export const createExpenseSchema = z.object({
  categoryId: uuid,
  amount: positiveDecimal,
  expenseDate: dateOnly,
  projectId: uuid.optional(),
  shootId: uuid.optional(),
  branchId: uuid.optional(),
  freelancerId: uuid.optional(),
  taxAmount: nonNegativeDecimal.optional(),
  vendor: z.string().max(160).optional(),
  paymentMethod: PAYMENT_METHOD.optional(),
  description: z.string().max(5000).optional(),
  submit: z.boolean().default(false),
});

export const updateExpenseSchema = createExpenseSchema.partial();
export const createExpensePaymentSchema = z.object({ amount: positiveDecimal, paidAt: dateOnly, method: PAYMENT_METHOD.optional(), note: z.string().max(5000).optional() });

export const reviewExpenseSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    reason: z.string().max(500).optional(),
  })
  .refine((v) => v.decision === 'APPROVE' || Boolean(v.reason), {
    message: 'A reason is required when rejecting',
    path: ['reason'],
  });

export const expenseCategorySchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(255).optional(),
});

export const INCOME_CATEGORY = z.enum(['CLIENT_PAYMENT', 'ADVANCE', 'ALBUM_SALES', 'REFERRAL', 'OTHER']);
export const incomeListQuery = listQuery.extend({ projectId: uuid.optional(), category: INCOME_CATEGORY.optional() });
export const createIncomeSchema = z.object({
  amount: positiveDecimal,
  date: dateOnly,
  category: INCOME_CATEGORY,
  projectId: uuid.optional(),
  client: z.string().trim().max(160).optional(),
  source: z.string().trim().max(160).optional(),
  paymentMethod: PAYMENT_METHOD.optional(),
  notes: z.string().max(5000).optional(),
  addedBy: z.string().trim().max(160).optional(),
});
export const updateIncomeSchema = createIncomeSchema.partial();
