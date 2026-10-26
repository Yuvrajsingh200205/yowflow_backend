import { PaymentMethod, PaymentStatus, Prisma } from '@prisma/client';
import { prisma, Tx } from '../config/prisma';
import { andWhere, paginate, searchFilter } from '../repositories/base.repository';
import { resolveSort } from '../utils/pagination';
import { nextDocumentNumber } from '../utils/documentNumber';
import { badRequest, conflict, notFound, unprocessable } from '../utils/errors';
import { dateRangeFilter, toDateOnly } from '../utils/date';
import { money, round2, sum, ZERO } from '../utils/money';
import { serializable } from '../utils/transaction';
import { AuthContext } from '../types';
import { AuditRequestContext, recordAudit } from './audit.service';
import { outstandingFor, recalculateInvoice } from './invoice.service';
import { scopedProjectWhere } from './project.service';

const SORTABLE = ['paymentDate', 'createdAt', 'amount', 'paymentNumber'] as const;

export interface AllocationInput {
  invoiceId: string;
  amount: Prisma.Decimal.Value;
}

export interface CreatePaymentInput {
  clientId: string;
  projectId?: string;
  amount: Prisma.Decimal.Value;
  paymentDate: string;
  paymentMethod?: PaymentMethod;
  transactionReference?: string;
  notes?: string;
  allocations?: AllocationInput[];
}

function paymentAccessWhere(auth: AuthContext): Prisma.PaymentWhereInput {
  if (auth.permissions.has('PROJECT_VIEW_ALL')) return {};
  return {
    OR: [
      { receivedById: auth.userId },
      { project: scopedProjectWhere(auth) },
    ],
  };
}

export function listPayments(
  auth: AuthContext,
  query: {
    page?: number;
    limit?: number;
    search?: string;
    projectId?: string;
    clientId?: string;
    invoiceId?: string;
    status?: PaymentStatus;
    paymentMethod?: PaymentMethod;
    from?: string;
    to?: string;
    sortBy?: string;
    sortOrder?: string;
  },
) {
  const sort = resolveSort(query.sortBy, query.sortOrder, SORTABLE, 'paymentDate');
  const paymentDate = dateRangeFilter(query.from, query.to);
  return paginate(prisma.payment, {
    where: andWhere(
      { organizationId: auth.organizationId },
      paymentAccessWhere(auth),
      query.projectId ? { projectId: query.projectId } : undefined,
      query.clientId ? { clientId: query.clientId } : undefined,
      query.invoiceId ? { allocations: { some: { invoiceId: query.invoiceId } } } : undefined,
      query.status ? { status: query.status } : undefined,
      query.paymentMethod ? { paymentMethod: query.paymentMethod } : undefined,
      paymentDate ? { paymentDate } : undefined,
      searchFilter(query.search, ['paymentNumber', 'transactionReference', 'notes']),
    ),
    orderBy: { [sort.field]: sort.direction },
    page: query.page,
    limit: query.limit,
    include: {
      client: { select: { id: true, displayName: true, clientCode: true } },
      project: { select: { id: true, projectNumber: true, name: true } },
      receivedBy: { select: { id: true, fullName: true } },
      allocations: {
        include: { invoice: { select: { id: true, invoiceNumber: true, total: true } } },
      },
    },
  });
}

export async function getPayment(auth: AuthContext, id: string) {
  const payment = await prisma.payment.findFirst({
    where: andWhere({ id, organizationId: auth.organizationId }, paymentAccessWhere(auth)),
    include: {
      client: true,
      project: { select: { id: true, projectNumber: true, name: true } },
      receivedBy: { select: { id: true, fullName: true } },
      allocations: { include: { invoice: true } },
    },
  });
  if (!payment) throw notFound('Payment');
  return payment;
}

/**
 * Validates and writes allocations for a payment, then refreshes both sides'
 * derived caches. Enforces the two §18 invariants:
 *
 *   sum(allocations for payment)  <= payment.amount
 *   allocation.amount             <= invoice outstanding
 */
async function applyAllocations(
  tx: Tx,
  paymentId: string,
  organizationId: string,
  clientId: string,
  paymentAmount: Prisma.Decimal,
  allocations: AllocationInput[],
): Promise<void> {
  if (allocations.length === 0) return;

  const seen = new Set<string>();
  for (const allocation of allocations) {
    if (seen.has(allocation.invoiceId)) {
      throw badRequest('The same invoice appears twice in the allocation list');
    }
    seen.add(allocation.invoiceId);
    if (money(allocation.amount).lessThanOrEqualTo(ZERO())) {
      throw badRequest('Every allocation amount must be greater than zero');
    }
  }

  const alreadyAllocated = await tx.paymentAllocation.aggregate({
    where: { paymentId },
    _sum: { amount: true },
  });

  const requested = round2(sum(allocations.map((a) => a.amount)));
  const total = round2(money(alreadyAllocated._sum.amount ?? 0).plus(requested));

  if (total.greaterThan(money(paymentAmount))) {
    throw unprocessable(
      `Allocations total ${total.toFixed(2)} but the payment is only ${money(paymentAmount).toFixed(2)}`,
    );
  }

  for (const allocation of allocations) {
    const { invoice, outstanding } = await outstandingFor(tx, allocation.invoiceId);

    if (invoice.organizationId !== organizationId) throw notFound('Invoice');
    if (invoice.clientId !== clientId) {
      throw badRequest('An invoice belonging to a different client cannot be settled by this payment');
    }
    if (invoice.status === 'CANCELLED') {
      throw conflict(`Invoice ${allocation.invoiceId} is cancelled and cannot be settled`);
    }

    const amount = round2(money(allocation.amount));
    if (amount.greaterThan(outstanding)) {
      throw unprocessable(
        `Allocation of ${amount.toFixed(2)} exceeds the ${outstanding.toFixed(2)} still outstanding on this invoice`,
      );
    }

    await tx.paymentAllocation.create({
      data: { paymentId, invoiceId: allocation.invoiceId, amount },
    });

    await recalculateInvoice(tx, allocation.invoiceId);
  }

  const finalTotal = await tx.paymentAllocation.aggregate({
    where: { paymentId },
    _sum: { amount: true },
  });

  await tx.payment.update({
    where: { id: paymentId },
    data: { allocatedAmount: round2(money(finalTotal._sum.amount ?? 0)) },
  });
}

/**
 * Records a client payment. Payment row, allocations, invoice re-settlement,
 * notification and audit entry are one atomic unit — a failure at any step
 * rolls the whole thing back (§17, §34).
 */
/**
 * The payment itself, inside a transaction somebody else owns. A project created together with its advance uses
 * this directly, so either both exist or neither does.
 */
export async function recordPayment(
  tx: Tx,
  auth: AuthContext,
  input: CreatePaymentInput,
  ctx: AuditRequestContext,
) {
  const amount = round2(money(input.amount));
  if (amount.lessThanOrEqualTo(ZERO())) throw badRequest('Payment amount must be greater than zero');

  const client = await tx.client.findFirst({
    where: { id: input.clientId, organizationId: auth.organizationId, deletedAt: null },
    select: { id: true, displayName: true },
  });
  if (!client) throw notFound('Client');

  if (input.projectId) {
    const project = await tx.project.findFirst({
      where: scopedProjectWhere(auth, { id: input.projectId }),
      select: { id: true },
    });
    if (!project) throw notFound('Project');
  }

  // Same reference twice is a duplicate submission, not a second payment.
  if (input.transactionReference) {
    const duplicate = await tx.payment.findFirst({
      where: {
        organizationId: auth.organizationId,
        transactionReference: input.transactionReference,
      },
      select: { id: true, paymentNumber: true },
    });
    if (duplicate) {
      throw conflict(
        `A payment with reference "${input.transactionReference}" already exists (${duplicate.paymentNumber})`,
        [{ field: 'transactionReference', message: 'Must be unique' }],
      );
    }
  }

  const paymentNumber = await nextDocumentNumber(tx, auth.organizationId, 'PAYMENT');

  const payment = await tx.payment.create({
    data: {
      organizationId: auth.organizationId,
      paymentNumber,
      clientId: input.clientId,
      projectId: input.projectId,
      amount,
      allocatedAmount: 0,
      paymentDate: toDateOnly(input.paymentDate),
      paymentMethod: input.paymentMethod ?? 'UPI',
      status: PaymentStatus.COMPLETED,
      transactionReference: input.transactionReference,
      notes: input.notes,
      receivedById: auth.userId,
    },
  });

  await applyAllocations(
    tx,
    payment.id,
    auth.organizationId,
    input.clientId,
    amount,
    input.allocations ?? [],
  );

  await recordAudit(tx, ctx, {
    action: 'PAYMENT_RECORDED',
    entityType: 'Payment',
    entityId: payment.id,
    summary: `Payment ${paymentNumber} of ${amount.toFixed(2)} recorded for ${client.displayName}`,
    newData: { ...payment, allocations: input.allocations ?? [] },
  });

  return tx.payment.findUniqueOrThrow({
    where: { id: payment.id },
    include: {
      allocations: { include: { invoice: { select: { id: true, invoiceNumber: true, status: true } } } },
      client: { select: { id: true, displayName: true } },
    },
  });
}

export async function createPayment(
  auth: AuthContext,
  input: CreatePaymentInput,
  ctx: AuditRequestContext,
) {
  return serializable((tx) => recordPayment(tx, auth, input, ctx));
}

/** Allocates an already-recorded payment across invoices (§18). */
export async function allocatePayment(
  auth: AuthContext,
  paymentId: string,
  allocations: AllocationInput[],
  ctx: AuditRequestContext,
) {
  if (allocations.length === 0) throw badRequest('Provide at least one allocation');

  return serializable(async (tx) => {
    const payment = await tx.payment.findFirst({
      where: { id: paymentId, organizationId: auth.organizationId },
    });
    if (!payment) throw notFound('Payment');
    if (payment.status !== 'COMPLETED') {
      throw conflict('Only a completed payment can be allocated');
    }

    await applyAllocations(
      tx,
      payment.id,
      auth.organizationId,
      payment.clientId,
      payment.amount,
      allocations,
    );

    await recordAudit(tx, ctx, {
      action: 'PAYMENT_ALLOCATED',
      entityType: 'Payment',
      entityId: payment.id,
      summary: `Payment ${payment.paymentNumber} allocated across ${allocations.length} invoice(s)`,
      newData: { allocations },
    });

    return tx.payment.findUniqueOrThrow({
      where: { id: payment.id },
      include: { allocations: { include: { invoice: true } } },
    });
  });
}

/**
 * Reverses a payment. Financial rows are never deleted (§25/§50) — the
 * original stays, its allocations are released, and a REFUNDED counter-entry
 * preserves the trail.
 */
export async function refundPayment(
  auth: AuthContext,
  paymentId: string,
  reason: string,
  ctx: AuditRequestContext,
) {
  return serializable(async (tx) => {
    const payment = await tx.payment.findFirst({
      where: { id: paymentId, organizationId: auth.organizationId },
      include: { allocations: true },
    });
    if (!payment) throw notFound('Payment');
    if (payment.status !== 'COMPLETED') throw conflict('Only a completed payment can be refunded');

    const affectedInvoices = payment.allocations.map((a) => a.invoiceId);

    await tx.paymentAllocation.deleteMany({ where: { paymentId } });
    await tx.payment.update({
      where: { id: paymentId },
      data: { status: PaymentStatus.REFUNDED, allocatedAmount: 0 },
    });

    const reversalNumber = await nextDocumentNumber(tx, auth.organizationId, 'PAYMENT');
    const reversal = await tx.payment.create({
      data: {
        organizationId: auth.organizationId,
        paymentNumber: reversalNumber,
        clientId: payment.clientId,
        projectId: payment.projectId,
        amount: payment.amount,
        allocatedAmount: 0,
        paymentDate: new Date(),
        paymentMethod: payment.paymentMethod,
        status: PaymentStatus.REFUNDED,
        notes: `Reversal of ${payment.paymentNumber}: ${reason}`,
        reversalOfPaymentId: payment.id,
        receivedById: auth.userId,
      },
    });

    for (const invoiceId of affectedInvoices) {
      await recalculateInvoice(tx, invoiceId);
    }

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'Payment',
      entityId: paymentId,
      summary: `Payment ${payment.paymentNumber} refunded — ${reason}`,
      oldData: payment,
      newData: reversal,
    });

    return reversal;
  });
}
