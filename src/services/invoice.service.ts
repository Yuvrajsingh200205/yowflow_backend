import { InvoiceStatus, Prisma } from '@prisma/client';
import { Db, prisma } from '../config/prisma';
import { andWhere, findScoped, paginate, searchFilter } from '../repositories/base.repository';
import { resolveSort } from '../utils/pagination';
import { nextDocumentNumber } from '../utils/documentNumber';
import { badRequest, conflict, notFound } from '../utils/errors';
import { dateRangeFilter, toDateOnly } from '../utils/date';
import { computeDocumentTotals, computeLine, money, round2, ZERO } from '../utils/money';
import { AuthContext } from '../types';
import { AuditRequestContext, recordAudit } from './audit.service';

const SORTABLE = ['issueDate', 'dueDate', 'createdAt', 'total', 'invoiceNumber'] as const;

/** Statuses in which an invoice is still owed money. */
export const OUTSTANDING_STATUSES: InvoiceStatus[] = ['SENT', 'PARTIALLY_PAID', 'OVERDUE'];

export interface InvoiceItemInput {
  service: string;
  description?: string;
  quantity: Prisma.Decimal.Value;
  unitPrice: Prisma.Decimal.Value;
  discountAmount?: Prisma.Decimal.Value;
  taxRate?: Prisma.Decimal.Value;
}

export interface CreateInvoiceInput {
  clientId: string;
  projectId?: string;
  quotationId?: string;
  issueDate: string;
  dueDate?: string;
  discountAmount?: Prisma.Decimal.Value;
  notes?: string;
  items: InvoiceItemInput[];
}

export function listInvoices(
  organizationId: string,
  query: {
    page?: number;
    limit?: number;
    search?: string;
    status?: InvoiceStatus;
    clientId?: string;
    projectId?: string;
    outstanding?: boolean;
    from?: string;
    to?: string;
    sortBy?: string;
    sortOrder?: string;
  },
) {
  const sort = resolveSort(query.sortBy, query.sortOrder, SORTABLE, 'issueDate');
  const issueDate = dateRangeFilter(query.from, query.to);
  return paginate(prisma.invoice, {
    where: andWhere(
      { organizationId },
      query.status ? { status: query.status } : undefined,
      query.outstanding ? { status: { in: OUTSTANDING_STATUSES } } : undefined,
      query.clientId ? { clientId: query.clientId } : undefined,
      query.projectId ? { projectId: query.projectId } : undefined,
      issueDate ? { issueDate } : undefined,
      searchFilter(query.search, ['invoiceNumber', 'notes']),
    ),
    orderBy: { [sort.field]: sort.direction },
    page: query.page,
    limit: query.limit,
    include: {
      client: { select: { id: true, displayName: true, clientCode: true } },
      project: { select: { id: true, projectNumber: true, name: true } },
    },
  });
}

export function getInvoice(organizationId: string, id: string) {
  // Invoices are cancelled, never soft-deleted, so the table has no deletedAt column to filter on.
  return findScoped(prisma.invoice, organizationId, id, 'Invoice', {
    withDeleted: true,
    include: {
      client: true,
      project: { select: { id: true, projectNumber: true, name: true } },
      items: { orderBy: { sortOrder: 'asc' } },
      allocations: {
        include: {
          payment: {
            select: {
              id: true,
              paymentNumber: true,
              paymentDate: true,
              paymentMethod: true,
              status: true,
            },
          },
        },
      },
    },
  });
}

export async function createInvoice(
  auth: AuthContext,
  input: CreateInvoiceInput,
  ctx: AuditRequestContext,
) {
  if (input.items.length === 0) throw badRequest('An invoice needs at least one line item');

  return prisma.$transaction(async (tx) => {
    const client = await tx.client.findFirst({
      where: { id: input.clientId, organizationId: auth.organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!client) throw notFound('Client');

    const computed = input.items.map((item) => ({ input: item, line: computeLine(item) }));
    const totals = computeDocumentTotals(
      computed.map((c) => c.line),
      input.discountAmount ?? 0,
    );

    const invoiceNumber = await nextDocumentNumber(tx, auth.organizationId, 'INVOICE');

    const invoice = await tx.invoice.create({
      data: {
        organizationId: auth.organizationId,
        invoiceNumber,
        clientId: input.clientId,
        projectId: input.projectId,
        quotationId: input.quotationId,
        issueDate: toDateOnly(input.issueDate),
        dueDate: input.dueDate ? toDateOnly(input.dueDate) : null,
        subtotal: totals.subtotal,
        discountAmount: totals.discountAmount,
        taxAmount: totals.taxAmount,
        total: totals.total,
        amountPaid: 0,
        // The `amount_due = total - amount_paid` CHECK constraint is satisfied
        // at insert time, not repaired later.
        amountDue: totals.total,
        status: InvoiceStatus.DRAFT,
        notes: input.notes,
        createdById: auth.userId,
        items: {
          createMany: {
            data: computed.map((c, index) => ({
              service: c.input.service,
              description: c.input.description,
              quantity: c.line.quantity,
              unitPrice: c.line.unitPrice,
              discountAmount: c.line.discountAmount,
              taxRate: c.line.taxRate,
              taxAmount: c.line.taxAmount,
              lineTotal: c.line.lineTotal,
              sortOrder: index,
            })),
          },
        },
      },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'Invoice',
      entityId: invoice.id,
      summary: `Invoice ${invoiceNumber} raised for ${String(totals.total)}`,
      newData: invoice,
    });

    return invoice;
  });
}

/**
 * Recomputes an invoice's derived cache from its allocations and returns the
 * resulting status. This is the ONLY place `amountPaid`/`amountDue`/`status`
 * are written for payment reasons — they are never incremented in place, so a
 * lost update cannot silently corrupt a balance (§14).
 *
 * Must run inside the same transaction as the allocation change.
 */
export async function recalculateInvoice(db: Db, invoiceId: string): Promise<InvoiceStatus> {
  const invoice = await db.invoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, total: true, status: true, dueDate: true },
  });
  if (!invoice) throw notFound('Invoice');

  const aggregate = await db.paymentAllocation.aggregate({
    where: { invoiceId, payment: { status: 'COMPLETED' } },
    _sum: { amount: true },
  });

  const paid = round2(money(aggregate._sum.amount ?? 0));
  const total = money(invoice.total);
  const due = round2(total.minus(paid));

  let status: InvoiceStatus;
  if (invoice.status === 'CANCELLED') {
    status = 'CANCELLED';
  } else if (paid.greaterThanOrEqualTo(total) && total.greaterThan(0)) {
    status = 'PAID';
  } else if (paid.greaterThan(0)) {
    status = 'PARTIALLY_PAID';
  } else if (invoice.dueDate && invoice.dueDate < new Date() && invoice.status !== 'DRAFT') {
    status = 'OVERDUE';
  } else {
    status = invoice.status === 'DRAFT' ? 'DRAFT' : 'SENT';
  }

  await db.invoice.update({
    where: { id: invoiceId },
    data: {
      amountPaid: paid,
      amountDue: due,
      status,
      settledAt: status === 'PAID' ? new Date() : null,
    },
  });

  return status;
}

/** Outstanding balance for an invoice, computed from allocations. */
export async function outstandingFor(db: Db, invoiceId: string) {
  const invoice = await db.invoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, total: true, status: true, organizationId: true, clientId: true },
  });
  if (!invoice) throw notFound('Invoice');

  const aggregate = await db.paymentAllocation.aggregate({
    where: { invoiceId, payment: { status: 'COMPLETED' } },
    _sum: { amount: true },
  });

  const paid = round2(money(aggregate._sum.amount ?? 0));
  return {
    invoice,
    paid,
    outstanding: round2(money(invoice.total).minus(paid)),
  };
}

export async function updateInvoiceStatus(
  auth: AuthContext,
  id: string,
  status: InvoiceStatus,
  ctx: AuditRequestContext,
) {
  return prisma.$transaction(async (tx) => {
    const invoice = await findScoped<{
      id: string;
      status: InvoiceStatus;
      invoiceNumber: string;
      amountPaid: Prisma.Decimal;
    }>(tx.invoice, auth.organizationId, id, 'Invoice', { withDeleted: true });

    if (status === 'CANCELLED' && money(invoice.amountPaid).greaterThan(ZERO())) {
      throw conflict(
        'This invoice has received payments and cannot be cancelled. Record a refund instead.',
      );
    }
    if (invoice.status === 'PAID' && status !== 'CANCELLED') {
      throw conflict('A fully paid invoice cannot change status');
    }

    const updated = await tx.invoice.update({
      where: { id },
      data: {
        status,
        sentAt: status === 'SENT' ? new Date() : undefined,
        cancelledAt: status === 'CANCELLED' ? new Date() : undefined,
      },
    });

    await recordAudit(tx, ctx, {
      action: 'STATUS_CHANGE',
      entityType: 'Invoice',
      entityId: id,
      summary: `Invoice ${invoice.invoiceNumber}: ${invoice.status} -> ${status}`,
      oldData: { status: invoice.status },
      newData: { status },
    });

    return updated;
  });
}
