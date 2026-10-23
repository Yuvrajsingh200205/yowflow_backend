import { Prisma, ProjectType, QuotationEventType, QuotationStatus } from '@prisma/client';
import { Db, Tx, prisma } from '../config/prisma';
import { env } from '../config/env';
import { AuthContext } from '../types';
import { badRequest, conflict, notFound } from '../utils/errors';
import { nextDocumentNumber } from '../utils/documentNumber';
import { computeLine } from '../utils/money';
import { newToken } from '../utils/token';
import { toDateOnly } from '../utils/date';
import { PricingContext, quantityFor, todayIn, totalsFor, ymd } from '../utils/quotePricing';
import { AuditRequestContext, recordAudit } from './audit.service';
import { quoteEmail, sendMail } from './mailer.service';
import { logger } from '../config/logger';

/**
 * Builds, edits and sends quotes. A quote is a snapshot: it copies names, prices and tax from the catalogue when
 * it is made, so editing the price list never changes a quote that has already gone out.
 */

export interface QuoteLine {
  service: string;
  description?: string | null;
  inclusions?: string[];
  kind: 'PACKAGE' | 'ADDON' | 'CUSTOM';
  catalogItemId?: string | null;
  isOptional?: boolean;
  isSelected?: boolean;
  pricingType?: 'FIXED' | 'PER_DAY' | 'PER_PERSON';
  unitLabel?: string | null;
  allowQuantity?: boolean;
  minQuantity?: number;
  maxQuantity?: number | null;
  quantity: Prisma.Decimal.Value;
  unitPrice: Prisma.Decimal.Value;
  discountAmount?: Prisma.Decimal.Value;
  taxRate?: Prisma.Decimal.Value;
}

export interface QuoteHeader {
  customerName?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  eventType?: ProjectType | null;
  eventDate?: string | null;
  eventDays?: number;
  guestCount?: number | null;
  venueName?: string | null;
  venueCity?: string | null;
  advancePercent?: number | null;
  balanceDueDaysBefore?: number | null;
  notes?: string | null;
  termsAndConditions?: string | null;
  validUntil?: string | null;
}

export const publicQuoteUrl = (token: string) => `${env.APP_URL.replace(/\/$/, '')}/quote/${token}`;

const applies = (types: ProjectType[], eventType?: ProjectType | null) => types.length === 0 || !eventType || types.includes(eventType);

/** Turns a chosen package and add-ons into quote lines, and offers the remaining add-ons as optional extras. */
export async function buildCatalogLines(
  db: Db,
  organizationId: string,
  opts: { packageId?: string | null; addons?: Array<{ id: string; quantity?: number }>; eventType?: ProjectType | null; ctx: PricingContext; suggestRest?: boolean },
): Promise<QuoteLine[]> {
  const wantedAddons = new Map((opts.addons ?? []).map((a) => [a.id, a.quantity]));
  const lines: QuoteLine[] = [];

  if (opts.packageId) {
    const pkg = await db.catalogItem.findFirst({ where: { id: opts.packageId, organizationId, kind: 'PACKAGE', isActive: true, deletedAt: null } });
    if (!pkg) throw notFound('Package');
    lines.push({
      service: pkg.name, description: pkg.description, inclusions: pkg.inclusions, kind: 'PACKAGE', catalogItemId: pkg.id, isOptional: false, isSelected: true,
      pricingType: pkg.pricingType, unitLabel: pkg.unitLabel, allowQuantity: false, minQuantity: pkg.minQuantity, maxQuantity: pkg.maxQuantity,
      quantity: quantityFor(pkg, opts.ctx), unitPrice: pkg.unitPrice, taxRate: pkg.taxRate,
    });
  }

  const addons = await db.catalogItem.findMany({
    where: { organizationId, kind: 'ADDON', isActive: true, deletedAt: null, ...(opts.suggestRest ? {} : { id: { in: [...wantedAddons.keys()] } }) },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  const missing = [...wantedAddons.keys()].filter((id) => !addons.some((a) => a.id === id));
  if (missing.length) throw notFound('Add-on');

  let suggested = 0;
  for (const a of addons) {
    const chosen = wantedAddons.has(a.id);
    if (!chosen) {
      if (!opts.suggestRest || !a.isPublic || !applies(a.eventTypes, opts.eventType) || suggested >= 12) continue;
      suggested += 1;
    }
    lines.push({
      service: a.name, description: a.description, inclusions: a.inclusions, kind: 'ADDON', catalogItemId: a.id, isOptional: true, isSelected: chosen,
      pricingType: a.pricingType, unitLabel: a.unitLabel, allowQuantity: a.allowQuantity, minQuantity: a.minQuantity, maxQuantity: a.maxQuantity,
      quantity: quantityFor(a, opts.ctx, wantedAddons.get(a.id)), unitPrice: a.unitPrice, taxRate: a.taxRate,
    });
  }
  return lines;
}

export function itemCreateData(line: QuoteLine, index: number): Prisma.QuotationItemCreateWithoutQuotationInput {
  const c = computeLine({ quantity: line.quantity, unitPrice: line.unitPrice, discountAmount: line.discountAmount, taxRate: line.taxRate });
  return {
    service: line.service.trim().slice(0, 200), description: line.description ?? null, inclusions: line.inclusions ?? [], kind: line.kind,
    catalogItem: line.catalogItemId ? { connect: { id: line.catalogItemId } } : undefined,
    isOptional: line.isOptional ?? false, isSelected: line.isSelected ?? true, pricingType: line.pricingType ?? 'FIXED', unitLabel: line.unitLabel ?? null,
    allowQuantity: line.allowQuantity ?? false, minQuantity: line.minQuantity ?? 1, maxQuantity: line.maxQuantity ?? null,
    quantity: c.quantity, unitPrice: c.unitPrice, discountAmount: c.discountAmount, taxRate: c.taxRate, taxAmount: c.taxAmount, lineTotal: c.lineTotal, sortOrder: index,
  };
}

export const totalsData = (lines: QuoteLine[], docDiscount: Prisma.Decimal.Value = 0) => {
  const t = totalsFor(lines.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice, discountAmount: l.discountAmount, taxRate: l.taxRate, isSelected: l.isSelected })), docDiscount);
  return { subtotal: t.subtotal, discountAmount: t.discountAmount, taxAmount: t.taxAmount, grandTotal: t.total };
};

export async function logQuoteEvent(db: Db, organizationId: string, quotationId: string, type: QuotationEventType, actor: { type: 'STAFF' | 'CLIENT' | 'SYSTEM'; id?: string | null }, meta?: Prisma.InputJsonValue) {
  await db.quotationEvent.create({ data: { organizationId, quotationId, type, actorType: actor.type, actorId: actor.id ?? null, meta } });
}

export async function loadSalesDefaults(db: Db, organizationId: string) {
  const [org, s] = await Promise.all([
    db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timezone: true } }),
    db.organizationSetting.findUnique({ where: { organizationId } }),
  ]);
  return {
    timezone: org.timezone,
    quoteValidDays: s?.quoteValidDays ?? 7,
    advancePercent: s?.advancePercent ?? 30,
    balanceDueDaysBefore: s?.balanceDueDaysBefore ?? 7,
    defaultTerms: s?.defaultTerms ?? null,
  };
}

export interface CreateQuoteArgs {
  organizationId: string;
  createdById: string | null;
  leadId?: string | null;
  clientId?: string | null;
  header: QuoteHeader;
  lines: QuoteLine[];
  discountAmount?: Prisma.Decimal.Value;
  autoGenerated?: boolean;
  needsReview?: boolean;
  status?: QuotationStatus;
  actor: { type: 'STAFF' | 'CLIENT' | 'SYSTEM'; id?: string | null };
}

/** Writes a quote with its lines, totals and first timeline entry. Must run inside a transaction. */
export async function createQuoteRecord(tx: Tx, args: CreateQuoteArgs) {
  if (args.lines.length === 0) throw badRequest('A quotation needs at least one line item');
  if (!args.lines.some((l) => l.isSelected !== false)) throw badRequest('Select at least one item for the quotation');
  const defaults = await loadSalesDefaults(tx, args.organizationId);
  const today = todayIn(defaults.timezone);
  const issue = toDateOnly(today);
  const valid = args.header.validUntil ? toDateOnly(args.header.validUntil) : new Date(issue.getTime() + defaults.quoteValidDays * 86_400_000);
  const totals = totalsData(args.lines, args.discountAmount ?? 0);
  const number = await nextDocumentNumber(tx, args.organizationId, 'QUOTATION');

  const quote = await tx.quotation.create({
    data: {
      organizationId: args.organizationId, quotationNumber: number, leadId: args.leadId ?? null, clientId: args.clientId ?? null, createdById: args.createdById,
      issueDate: issue, validUntil: valid, ...totals,
      status: args.status ?? 'DRAFT', needsReview: args.needsReview ?? false, autoGenerated: args.autoGenerated ?? false, publicToken: newToken(),
      notes: args.header.notes ?? null, termsAndConditions: args.header.termsAndConditions ?? defaults.defaultTerms,
      customerName: args.header.customerName ?? null, customerPhone: args.header.customerPhone ?? null, customerEmail: args.header.customerEmail?.toLowerCase() ?? null,
      eventType: args.header.eventType ?? null, eventDate: args.header.eventDate ? toDateOnly(args.header.eventDate) : null, eventDays: args.header.eventDays ?? 1,
      guestCount: args.header.guestCount ?? null, venueName: args.header.venueName ?? null, venueCity: args.header.venueCity ?? null,
      advancePercent: args.header.advancePercent ?? defaults.advancePercent, balanceDueDaysBefore: args.header.balanceDueDaysBefore ?? defaults.balanceDueDaysBefore,
      items: { create: args.lines.map((l, i) => itemCreateData(l, i)) },
    },
    include: { items: { orderBy: { sortOrder: 'asc' } } },
  });
  await logQuoteEvent(tx, args.organizationId, quote.id, 'CREATED', args.actor, { auto: args.autoGenerated ?? false, total: Number(quote.grandTotal) });
  return quote;
}

// ── Staff: create from a lead ───────────────────────────────────────────────
export interface CreateFromLeadInput {
  leadId: string;
  packageId?: string | null;
  addons?: Array<{ id: string; quantity?: number }>;
  customLines?: QuoteLine[];
  eventDate?: string | null;
  eventDays?: number;
  guestCount?: number | null;
  venueName?: string | null;
  venueCity?: string | null;
  discountAmount?: number;
  notes?: string | null;
  termsAndConditions?: string | null;
  validDays?: number;
  advancePercent?: number;
}

export async function createQuoteForLead(auth: AuthContext, input: CreateFromLeadInput, ctx: AuditRequestContext) {
  const lead = await prisma.lead.findFirst({ where: { id: input.leadId, organizationId: auth.organizationId, deletedAt: null } });
  if (!lead) throw notFound('Lead');
  const eventDays = input.eventDays ?? 1;
  const eventDate = input.eventDate === undefined ? (lead.eventDate ? ymd(lead.eventDate) : null) : input.eventDate;
  const guestCount = input.guestCount === undefined ? lead.guestCount : input.guestCount;

  return prisma.$transaction(async (tx) => {
    const catalogLines = input.packageId || input.addons?.length
      ? await buildCatalogLines(tx, auth.organizationId, { packageId: input.packageId ?? lead.interestedPackageId, addons: input.addons, eventType: lead.eventType, ctx: { eventDays, guestCount }, suggestRest: true })
      : [];
    const lines = [...catalogLines, ...(input.customLines ?? []).map((l) => ({ ...l, kind: l.kind ?? 'CUSTOM', isSelected: l.isSelected ?? true }))];
    const defaults = await loadSalesDefaults(tx, auth.organizationId);
    const validUntil = input.validDays ? ymd(new Date(toDateOnly(todayIn(defaults.timezone)).getTime() + input.validDays * 86_400_000)) : null;
    const quote = await createQuoteRecord(tx, {
      organizationId: auth.organizationId, createdById: auth.userId, leadId: lead.id, clientId: lead.clientId,
      header: {
        customerName: lead.name, customerPhone: lead.phone, customerEmail: lead.email, eventType: lead.eventType, eventDate, eventDays, guestCount,
        venueName: input.venueName ?? null, venueCity: input.venueCity ?? lead.venueCity, advancePercent: input.advancePercent ?? null, notes: input.notes ?? null,
        termsAndConditions: input.termsAndConditions ?? null, validUntil,
      },
      lines, discountAmount: input.discountAmount ?? 0, actor: { type: 'STAFF', id: auth.userId },
    });
    await tx.lead.update({ where: { id: lead.id }, data: { guestCount: guestCount ?? undefined, eventDate: eventDate ? toDateOnly(eventDate) : undefined } });
    await recordAudit(tx, ctx, { action: 'CREATE', entityType: 'Quotation', entityId: quote.id, summary: `Quotation ${quote.quotationNumber} created for lead ${lead.name}`, newData: { total: Number(quote.grandTotal) } });
    return quote;
  });
}

// ── Staff: edit ─────────────────────────────────────────────────────────────
export interface UpdateQuoteInput extends QuoteHeader {
  items?: QuoteLine[];
  discountAmount?: number;
}

export async function updateQuoteContent(auth: AuthContext, id: string, input: UpdateQuoteInput, ctx: AuditRequestContext) {
  return prisma.$transaction(async (tx) => {
    const quote = await tx.quotation.findFirst({ where: { id, organizationId: auth.organizationId, deletedAt: null }, include: { items: true } });
    if (!quote) throw notFound('Quotation');
    if (!['DRAFT', 'SENT'].includes(quote.status)) throw conflict(`A ${quote.status.toLowerCase()} quotation can no longer be edited. Make a new one instead.`);

    const data: Prisma.QuotationUpdateInput = {};
    const set = <K extends keyof QuoteHeader>(key: K, prismaKey: keyof Prisma.QuotationUpdateInput, map?: (v: NonNullable<QuoteHeader[K]>) => unknown) => {
      if (input[key] !== undefined) (data as Record<string, unknown>)[prismaKey] = input[key] === null || !map ? input[key] : map(input[key] as NonNullable<QuoteHeader[K]>);
    };
    set('customerName', 'customerName'); set('customerPhone', 'customerPhone'); set('customerEmail', 'customerEmail', (v) => String(v).toLowerCase());
    set('eventType', 'eventType'); set('eventDate', 'eventDate', (v) => toDateOnly(String(v))); set('eventDays', 'eventDays'); set('guestCount', 'guestCount');
    set('venueName', 'venueName'); set('venueCity', 'venueCity'); set('advancePercent', 'advancePercent'); set('balanceDueDaysBefore', 'balanceDueDaysBefore');
    set('notes', 'notes'); set('termsAndConditions', 'termsAndConditions'); set('validUntil', 'validUntil', (v) => toDateOnly(String(v)));

    const lines: QuoteLine[] = input.items
      ?? quote.items.map((i) => ({ service: i.service, description: i.description, inclusions: i.inclusions, kind: i.kind, catalogItemId: i.catalogItemId, isOptional: i.isOptional, isSelected: i.isSelected, pricingType: i.pricingType, unitLabel: i.unitLabel, allowQuantity: i.allowQuantity, minQuantity: i.minQuantity, maxQuantity: i.maxQuantity, quantity: i.quantity, unitPrice: i.unitPrice, discountAmount: i.discountAmount, taxRate: i.taxRate }));
    if (!lines.some((l) => l.isSelected !== false)) throw badRequest('Select at least one item for the quotation');
    if (input.items) {
      const ids = [...new Set(input.items.map((l) => l.catalogItemId).filter((x): x is string => Boolean(x)))];
      if (ids.length) {
        const found = await tx.catalogItem.count({ where: { id: { in: ids }, organizationId: auth.organizationId } });
        if (found !== ids.length) throw notFound('Catalogue item');
      }
    }
    const docDiscount = input.discountAmount ?? undefined;
    const totals = totalsData(lines, docDiscount ?? 0);
    if (docDiscount === undefined && !input.items) Object.assign(totals, { discountAmount: quote.discountAmount });

    if (input.items) {
      await tx.quotationItem.deleteMany({ where: { quotationId: id } });
    }
    const updated = await tx.quotation.update({
      where: { id },
      data: { ...data, ...(input.items || docDiscount !== undefined ? totals : {}), ...(input.items ? { items: { create: lines.map((l, i) => itemCreateData(l, i)) } } : {}) },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    });
    if (quote.status === 'SENT') await logQuoteEvent(tx, auth.organizationId, id, 'REVISED', { type: 'STAFF', id: auth.userId }, { total: Number(updated.grandTotal) });
    await recordAudit(tx, ctx, { action: 'UPDATE', entityType: 'Quotation', entityId: id, summary: `Quotation ${quote.quotationNumber} edited`, oldData: { total: Number(quote.grandTotal) }, newData: { total: Number(updated.grandTotal) } });
    return updated;
  });
}

// ── Staff: send / approve ───────────────────────────────────────────────────
export const toWaPhone = (phone?: string | null) => {
  const d = (phone ?? '').replace(/\D/g, '');
  if (d.length === 10) return `91${d}`;
  if (d.length === 12 && d.startsWith('91')) return d;
  return d.length >= 8 ? d : null;
};

export async function sendQuote(auth: AuthContext, id: string, input: { channel: 'EMAIL' | 'LINK' | 'WHATSAPP' }, ctx: AuditRequestContext) {
  const quote = await prisma.quotation.findFirst({ where: { id, organizationId: auth.organizationId, deletedAt: null }, include: { items: true, organization: { select: { name: true, phone: true, email: true } } } });
  if (!quote) throw notFound('Quotation');
  if (!['DRAFT', 'SENT', 'REJECTED', 'EXPIRED'].includes(quote.status)) throw conflict(`A ${quote.status.toLowerCase()} quotation cannot be sent.`);
  if (!quote.items.some((i) => i.isSelected)) throw badRequest('Select at least one item before sending');
  if (input.channel === 'EMAIL' && !quote.customerEmail) throw badRequest('Add an email address for the customer first, or share the link on WhatsApp.');

  const defaults = await loadSalesDefaults(prisma, auth.organizationId);
  const today = toDateOnly(todayIn(defaults.timezone));
  // A quote that lapsed or was declined gets a fresh validity window when it is sent again.
  const refreshValidity = quote.status === 'EXPIRED' || quote.status === 'REJECTED' || !quote.validUntil || quote.validUntil < today;
  const validUntil = refreshValidity ? new Date(today.getTime() + defaults.quoteValidDays * 86_400_000) : quote.validUntil;
  const token = quote.publicToken ?? newToken();
  const wasApproval = quote.needsReview;

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.quotation.update({
      where: { id },
      data: { status: 'SENT', sentAt: new Date(), sentVia: input.channel, needsReview: false, publicToken: token, validUntil, declinedAt: null, declineReason: null },
    });
    if (wasApproval) await logQuoteEvent(tx, auth.organizationId, id, 'APPROVED', { type: 'STAFF', id: auth.userId });
    await logQuoteEvent(tx, auth.organizationId, id, 'SENT', { type: 'STAFF', id: auth.userId }, { channel: input.channel });
    if (quote.leadId) await tx.lead.updateMany({ where: { id: quote.leadId, status: { in: ['NEW', 'CONTACTED', 'QUALIFIED'] } }, data: { status: 'PROPOSAL_SENT' } });
    await recordAudit(tx, ctx, { action: 'STATUS_CHANGE', entityType: 'Quotation', entityId: id, summary: `Quotation ${quote.quotationNumber} sent via ${input.channel.toLowerCase()}`, oldData: { status: quote.status }, newData: { status: 'SENT' } });
    return u;
  });

  const url = publicQuoteUrl(token);
  let emailed = false;
  if (input.channel === 'EMAIL' && quote.customerEmail) {
    try {
      await sendMail(quoteEmail({ to: quote.customerEmail, name: quote.customerName ?? 'there', studioName: quote.organization.name, link: url, total: Number(quote.grandTotal), validUntil, eventDate: quote.eventDate, studioPhone: quote.organization.phone, replyTo: quote.organization.email }));
      emailed = true;
    } catch (error) {
      logger.warn({ err: error }, 'quote e-mail failed');
    }
  }
  const wa = toWaPhone(quote.customerPhone);
  const text = `Hi ${quote.customerName ?? ''}, thank you for your enquiry with ${quote.organization.name}. Here is your quotation: ${url}`;
  return { quotation: updated, publicUrl: url, emailed, whatsappUrl: wa ? `https://wa.me/${wa}?text=${encodeURIComponent(text)}` : null };
}

export async function listQuoteEvents(organizationId: string, id: string) {
  const q = await prisma.quotation.findFirst({ where: { id, organizationId, deletedAt: null }, select: { id: true } });
  if (!q) throw notFound('Quotation');
  return prisma.quotationEvent.findMany({ where: { quotationId: id }, orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, type: true, actorType: true, meta: true, createdAt: true } });
}

/** What a quote really is right now: a sent quote past its date is expired, whatever the stored status says. */
export function effectiveStatus(q: { status: QuotationStatus; validUntil: Date | null }, today: Date): QuotationStatus {
  return q.status === 'SENT' && q.validUntil && q.validUntil < today ? 'EXPIRED' : q.status;
}
export const viewState = (q: { status: QuotationStatus; sentAt: Date | null; firstViewedAt: Date | null }) =>
  q.status === 'DRAFT' ? 'NOT_SENT' : q.firstViewedAt ? 'OPENED' : q.sentAt ? 'NOT_OPENED' : 'NOT_SENT';

export async function assertQuoteBelongs(organizationId: string, id: string) {
  const q = await prisma.quotation.findFirst({ where: { id, organizationId, deletedAt: null }, select: { id: true } });
  if (!q) throw notFound('Quotation');
  return q;
}
