import { Router } from 'express';
import * as controller from '../controllers/finance.controller';
import { validate } from '../middleware/validate';
import { requirePermission } from '../middleware/rbac';
import { idempotent } from '../middleware/idempotency';
import * as salesController from '../controllers/sales.controller';
import { idParam } from '../validators/common.validator';
import { quoteConvertSchema, quoteFromLeadSchema, quoteSendSchema, quoteUpdateSchema } from '../validators/sales.validator';
import {
  allocatePaymentSchema,
  createExpenseSchema,
  createInvoiceSchema,
  createPaymentSchema,
  createQuotationSchema,
  expenseCategorySchema,
  expenseListQuery,
  invoiceListQuery,
  invoiceStatusSchema,
  paymentListQuery,
  quotationListQuery,
  quotationStatusSchema,
  refundPaymentSchema,
  reviewExpenseSchema,
  updateExpenseSchema,
  createIncomeSchema,
  createExpensePaymentSchema,
  incomeListQuery,
  updateIncomeSchema,
} from '../validators/finance.validator';

export const quotationRouter = Router();

quotationRouter.get(
  '/',
  requirePermission('QUOTATION_VIEW'),
  validate({ query: quotationListQuery }),
  controller.listQuotations,
);
quotationRouter.post(
  '/',
  requirePermission('QUOTATION_CREATE'),
  validate({ body: createQuotationSchema }),
  controller.createQuotation,
);
// Fixed paths first, so they are never read as an id.
quotationRouter.get('/today', requirePermission('QUOTATION_VIEW'), salesController.todayList);
quotationRouter.post('/from-lead', requirePermission('QUOTATION_CREATE'), validate({ body: quoteFromLeadSchema }), salesController.quoteFromLead);
quotationRouter.get(
  '/:id',
  requirePermission('QUOTATION_VIEW'),
  validate({ params: idParam }),
  controller.getQuotation,
);
quotationRouter.patch('/:id', requirePermission('QUOTATION_UPDATE'), validate({ params: idParam, body: quoteUpdateSchema }), salesController.updateQuote);
quotationRouter.post('/:id/send', requirePermission('QUOTATION_UPDATE'), validate({ params: idParam, body: quoteSendSchema }), salesController.sendQuote);
quotationRouter.post('/:id/convert', requirePermission('QUOTATION_UPDATE'), validate({ params: idParam, body: quoteConvertSchema }), salesController.convertQuote);
quotationRouter.get('/:id/events', requirePermission('QUOTATION_VIEW'), validate({ params: idParam }), salesController.quoteEvents);
quotationRouter.get('/:id/preview', requirePermission('QUOTATION_VIEW'), validate({ params: idParam }), salesController.quotePreview);
quotationRouter.get('/:id/pdf', requirePermission('QUOTATION_VIEW'), validate({ params: idParam }), salesController.quotePdf);
quotationRouter.patch(
  '/:id/status',
  requirePermission('QUOTATION_UPDATE'),
  validate({ params: idParam, body: quotationStatusSchema }),
  controller.updateQuotationStatus,
);
quotationRouter.delete(
  '/:id',
  requirePermission('QUOTATION_DELETE'),
  validate({ params: idParam }),
  controller.removeQuotation,
);

export const invoiceRouter = Router();

invoiceRouter.get('/:id/pdf', requirePermission('INVOICE_VIEW'), validate({ params: idParam }), salesController.invoicePdf);

invoiceRouter.get(
  '/',
  requirePermission('INVOICE_VIEW'),
  validate({ query: invoiceListQuery }),
  controller.listInvoices,
);
// Idempotent: a retried invoice creation must never raise a second invoice.
invoiceRouter.post(
  '/',
  requirePermission('INVOICE_CREATE'),
  validate({ body: createInvoiceSchema }),
  idempotent(),
  controller.createInvoice,
);
invoiceRouter.get(
  '/:id',
  requirePermission('INVOICE_VIEW'),
  validate({ params: idParam }),
  controller.getInvoice,
);
invoiceRouter.patch(
  '/:id/status',
  requirePermission('INVOICE_UPDATE'),
  validate({ params: idParam, body: invoiceStatusSchema }),
  controller.updateInvoiceStatus,
);

export const paymentRouter = Router();

paymentRouter.get(
  '/',
  requirePermission('PAYMENT_VIEW'),
  validate({ query: paymentListQuery }),
  controller.listPayments,
);
// Idempotency-Key is mandatory here: a duplicate submission must never book
// the same money twice (§35).
paymentRouter.post(
  '/',
  requirePermission('PAYMENT_CREATE'),
  validate({ body: createPaymentSchema }),
  idempotent({ required: true }),
  controller.createPayment,
);
paymentRouter.get(
  '/:id',
  requirePermission('PAYMENT_VIEW'),
  validate({ params: idParam }),
  controller.getPayment,
);
paymentRouter.post(
  '/:id/allocations',
  requirePermission('PAYMENT_ALLOCATE'),
  validate({ params: idParam, body: allocatePaymentSchema }),
  idempotent(),
  controller.allocatePayment,
);
paymentRouter.post(
  '/:id/refund',
  requirePermission('PAYMENT_UPDATE'),
  validate({ params: idParam, body: refundPaymentSchema }),
  idempotent({ required: true }),
  controller.refundPayment,
);

export const expenseRouter = Router();

expenseRouter.get(
  '/',
  requirePermission('EXPENSE_VIEW'),
  validate({ query: expenseListQuery }),
  controller.listExpenses,
);
expenseRouter.get('/summary', requirePermission('EXPENSE_VIEW'), controller.expenseSummary);
expenseRouter.post(
  '/',
  requirePermission('EXPENSE_CREATE'),
  validate({ body: createExpenseSchema }),
  controller.createExpense,
);
expenseRouter.get('/categories', requirePermission('EXPENSE_VIEW'), controller.listExpenseCategories);
expenseRouter.post(
  '/categories',
  requirePermission('EXPENSE_CREATE'),
  validate({ body: expenseCategorySchema }),
  controller.createExpenseCategory,
);
expenseRouter.get(
  '/:id',
  requirePermission('EXPENSE_VIEW'),
  validate({ params: idParam }),
  controller.getExpense,
);
expenseRouter.patch(
  '/:id',
  requirePermission('EXPENSE_UPDATE'),
  validate({ params: idParam, body: updateExpenseSchema }),
  controller.updateExpense,
);
expenseRouter.post(
  '/:id/review',
  requirePermission('EXPENSE_APPROVE'),
  validate({ params: idParam, body: reviewExpenseSchema }),
  controller.reviewExpense,
);
expenseRouter.post('/:id/payments', requirePermission('EXPENSE_UPDATE'), validate({ params: idParam, body: createExpensePaymentSchema }), controller.addExpensePayment);
expenseRouter.delete(
  '/:id',
  requirePermission('EXPENSE_DELETE'),
  validate({ params: idParam }),
  controller.removeExpense,
);

export const incomeRouter = Router();
incomeRouter.get('/summary', requirePermission('EXPENSE_VIEW'), controller.incomeSummary);
incomeRouter.get('/', requirePermission('EXPENSE_VIEW'), validate({ query: incomeListQuery }), controller.listIncomes);
incomeRouter.post('/', requirePermission('EXPENSE_CREATE'), validate({ body: createIncomeSchema }), controller.createIncome);
incomeRouter.get('/:id', requirePermission('EXPENSE_VIEW'), validate({ params: idParam }), controller.getIncome);
incomeRouter.patch('/:id', requirePermission('EXPENSE_UPDATE'), validate({ params: idParam, body: updateIncomeSchema }), controller.updateIncome);
incomeRouter.delete('/:id', requirePermission('EXPENSE_DELETE'), validate({ params: idParam }), controller.removeIncome);

export const financeRouter = Router();
financeRouter.get('/profit-loss', requirePermission('EXPENSE_VIEW'), controller.profitLoss);
