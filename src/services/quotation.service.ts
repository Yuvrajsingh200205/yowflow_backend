import { Prisma, QuotationStatus } from '@prisma/client';
import { prisma } from '../config/prisma';
import { andWhere, findScoped, paginate, searchFilter } from '../repositories/base.repository';
import { resolveSort } from '../utils/pagination';
import { nextDocumentNumber } from '../utils/documentNumber';
import { badRequest, conflict, notFound } from '../utils/errors';
import { dateRangeFilter, toDateOnly } from '../utils/date';
import { computeDocumentTotals, computeLine } from '../utils/money';
import { AuthContext } from '../types';
import { AuditRequestContext, recordAudit } from './audit.service';
import { effectiveStatus, logQuoteEvent, publicQuoteUrl, viewState } from './quoteEngine.service';
import { newToken } from '../utils/token';
import { todayIn } from '../utils/quotePricing';

const SORTABLE = ['issueDate', 'createdAt', 'grandTotal', 'quotationNumber'] as const;

export interface QuotationItemInput {
  service: string;
  description?: string;
  quantity: Prisma.Decimal.Value;
  unitPrice: Prisma.Decimal.Value;
  discountAmount?: Prisma.Decimal.Value;
  taxRate?: Prisma.Decimal.Value;
}

export interface CreateQuotationInput {
  clientId?: string;
  leadId?: string;
  projectId?: string;
  issueDate: string;
  validUntil?: string;
  discountAmount?: Prisma.Decimal.Value;
  notes?: string;
  termsAndConditions?: string;
  items: QuotationItemInput[];
}

export async function listQuotations(
  organizationId: string,
  query: {
    page?: number;
    limit?: number;
    search?: string;
    status?: QuotationStatus;
    clientId?: string;
    projectId?: string;
    leadId?: string;
    needsReview?: boolean;
    from?: string;
    to?: string;
    sortBy?: string;
    sortOrder?: string;
  },
) {
  const sort = resolveSort(query.sortBy, query.sortOrder, SORTABLE, 'issueDate');
  const issueDate = dateRangeFilter(query.from, query.to);
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timezone: true } });
  const today = toDateOnly(todayIn(org.timezone));
  const result = await paginate<Prisma.QuotationGetPayload<{ include: { client: { select: { id: true; displayName: true; clientCode: true } }; lead: { select: { id: true; name: true; phone: true } }; project: { select: { id: true; projectNumber: true; name: true } }; _count: { select: { items: true } } } }>>(prisma.quotation, {
    where: andWhere(
      { organizationId, deletedAt: null },
      query.status ? { status: query.status } : undefined,
      query.clientId ? { clientId: query.clientId } : undefined,
      query.projectId ? { projectId: query.projectId } : undefined,
      query.leadId ? { leadId: query.leadId } : undefined,
      query.needsReview === undefined ? undefined : { needsReview: query.needsReview },
      issueDate ? { issueDate } : undefined,
      searchFilter(query.search, ['quotationNumber', 'notes', 'customerName', 'customerPhone', 'customerEmail']),
    ),
    orderBy: { [sort.field]: sort.direction },
    page: query.page,
    limit: query.limit,
    include: {
      client: { select: { id: true, displayName: true, clientCode: true } },
      lead: { select: { id: true, name: true, phone: true } },
      project: { select: { id: true, projectNumber: true, name: true } },
      _count: { select: { items: true } },
    },
  });
  // Sensitive acceptance details (IP, user agent) and the share token stay out of lists.
  const items = result.items.map(({ acceptedIp: _ip, acceptedUserAgent: _ua, publicToken: _t, ...q }) => {
    void _ip; void _ua; void _t;
    return { ...q, effectiveStatus: effectiveStatus(q, today), viewState: viewState(q) };
  });
  return { items, pagination: result.pagination };
}

export async function getQuotation(organizationId: string, id: string) {
  const q = await findScoped<Prisma.QuotationGetPayload<{ include: { client: true; lead: { select: { id: true; name: true; phone: true; email: true; status: true } }; project: { select: { id: true; projectNumber: true; name: true } }; items: true; createdBy: { select: { id: true; fullName: true } } } }>>(prisma.quotation, organizationId, id, 'Quotation', {
    include: {
      client: true,
      lead: { select: { id: true, name: true, phone: true, email: true, status: true } },
      project: { select: { id: true, projectNumber: true, name: true } },
      items: { orderBy: { sortOrder: 'asc' } },
      createdBy: { select: { id: true, fullName: true } },
    },
  });
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timezone: true } });
  const { acceptedIp: _ip, acceptedUserAgent: _ua, ...rest } = q;
  void _ip; void _ua;
  return { ...rest, effectiveStatus: effectiveStatus(q, toDateOnly(todayIn(org.timezone))), viewState: viewState(q), publicUrl: q.publicToken && q.status !== 'DRAFT' ? publicQuoteUrl(q.publicToken) : null, publicPreviewUrl: q.publicToken ? publicQuoteUrl(q.publicToken) : null };
}

export async function createQuotation(
  auth: AuthContext,
  input: CreateQuotationInput,
  ctx: AuditRequestContext,
) {
  if (input.items.length === 0) throw badRequest('A quotation needs at least one line item');
  if (!input.clientId && !input.leadId) throw badRequest('Choose a client or a lead');

  return prisma.$transaction(async (tx) => {
    const client = input.clientId
      ? await tx.client.findFirst({ where: { id: input.clientId, organizationId: auth.organizationId, deletedAt: null }, select: { id: true, displayName: true, primaryPhone: true, primaryEmail: true } })
      : null;
    if (input.clientId && !client) throw notFound('Client');
    const lead = input.leadId
      ? await tx.lead.findFirst({ where: { id: input.leadId, organizationId: auth.organizationId, deletedAt: null }, select: { id: true, name: true, phone: true, email: true, clientId: true } })
      : null;
    if (input.leadId && !lead) throw notFound('Lead');

    const computed = input.items.map((item) => ({ input: item, line: computeLine(item) }));
    const totals = computeDocumentTotals(
      computed.map((c) => c.line),
      input.discountAmount ?? 0,
    );

    const quotationNumber = await nextDocumentNumber(tx, auth.organizationId, 'QUOTATION');

    const quotation = await tx.quotation.create({
      data: {
        organizationId: auth.organizationId,
        quotationNumber,
        clientId: input.clientId ?? lead?.clientId ?? null,
        leadId: lead?.id ?? null,
        publicToken: newToken(),
        customerName: client?.displayName ?? lead?.name ?? null,
        customerPhone: client?.primaryPhone ?? lead?.phone ?? null,
        customerEmail: (client?.primaryEmail ?? lead?.email)?.toLowerCase() ?? null,
        projectId: input.projectId,
        issueDate: toDateOnly(input.issueDate),
        validUntil: input.validUntil ? toDateOnly(input.validUntil) : null,
        subtotal: totals.subtotal,
        discountAmount: totals.discountAmount,
        taxAmount: totals.taxAmount,
        grandTotal: totals.total,
        notes: input.notes,
        termsAndConditions: input.termsAndConditions,
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

    await logQuoteEvent(tx, auth.organizationId, quotation.id, 'CREATED', { type: 'STAFF', id: auth.userId }, { total: Number(quotation.grandTotal) });
    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'Quotation',
      entityId: quotation.id,
      summary: `Quotation ${quotationNumber} created for ${String(totals.total)}`,
      newData: quotation,
    });

    return quotation;
  });
}

export async function updateQuotationStatus(
  auth: AuthContext,
  id: string,
  status: QuotationStatus,
  ctx: AuditRequestContext,
) {
  return prisma.$transaction(async (tx) => {
    const quotation = await findScoped<{ id: string; status: QuotationStatus; quotationNumber: string }>(
      tx.quotation,
      auth.organizationId,
      id,
      'Quotation',
    );

    if (quotation.status === 'ACCEPTED' && status !== 'CANCELLED') {
      throw conflict('An accepted quotation can only be cancelled');
    }

    const updated = await tx.quotation.update({
      where: { id },
      data: { status, acceptedAt: status === 'ACCEPTED' ? new Date() : undefined },
    });

    await recordAudit(tx, ctx, {
      action: 'STATUS_CHANGE',
      entityType: 'Quotation',
      entityId: id,
      summary: `Quotation ${quotation.quotationNumber}: ${quotation.status} -> ${status}`,
      oldData: { status: quotation.status },
      newData: { status },
    });

    return updated;
  });
}

export async function deleteQuotation(auth: AuthContext, id: string, ctx: AuditRequestContext) {
  return prisma.$transaction(async (tx) => {
    const quotation = await findScoped<{ id: string; status: QuotationStatus }>(
      tx.quotation,
      auth.organizationId,
      id,
      'Quotation',
    );
    if (quotation.status === 'ACCEPTED') {
      throw conflict('An accepted quotation cannot be deleted. Cancel it instead.');
    }
    await tx.quotation.update({
      where: { id },
      data: { deletedAt: new Date(), deletedBy: auth.userId },
    });
    await recordAudit(tx, ctx, {
      action: 'SOFT_DELETE',
      entityType: 'Quotation',
      entityId: id,
      summary: 'Quotation archived',
      oldData: quotation,
    });
  });
}
