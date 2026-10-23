import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { AuthContext } from '../types';
import { badRequest, conflict, notFound } from '../utils/errors';
import { toDateOnly } from '../utils/date';
import { computeLine } from '../utils/money';
import { paymentPlan, todayIn, totalsFor, ymd } from '../utils/quotePricing';
import { checkDate, isSellable, reasonFor } from './availability.service';
import { bookQuotation, isDateTaken } from './booking.service';
import { effectiveStatus, logQuoteEvent } from './quoteEngine.service';
import { notifyStaff } from './staffNotify.service';
import { quoteAcceptedStaffEmail } from './mailer.service';
import { env } from '../config/env';

/** What a customer sees and can do with the link they were sent. No account, the token is the credential. */

export interface SelectionInput { itemId: string; selected?: boolean; quantity?: number }
export interface RequestMeta { ip?: string | null; userAgent?: string | null }

const STUDIO_SELECT = { name: true, phone: true, email: true, website: true, gstNumber: true, addressLine: true, city: true, state: true, postalCode: true, timezone: true } as const;

async function loadByToken(token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw notFound('Quotation');
  const quote = await prisma.quotation.findFirst({
    where: { publicToken: token, deletedAt: null },
    include: { items: { orderBy: { sortOrder: 'asc' } }, organization: { select: STUDIO_SELECT }, lead: { select: { id: true, ownerId: true } } },
  });
  if (!quote || quote.status === 'DRAFT') throw notFound('Quotation'); // a draft is not the customer's yet
  return quote;
}
type LoadedQuote = Awaited<ReturnType<typeof loadByToken>>;

const docDiscountOf = (q: { discountAmount: Prisma.Decimal; items: Array<{ isSelected: boolean; discountAmount: Prisma.Decimal }> }) =>
  Prisma.Decimal.max(0, q.discountAmount.minus(q.items.filter((i) => i.isSelected).reduce((a, i) => a.plus(i.discountAmount), new Prisma.Decimal(0))));

interface Applied { id: string; isSelected: boolean; quantity: Prisma.Decimal }

/** Applies the customer's choices to the optional lines only; required lines can never be switched off or re-priced. */
function applySelection(items: LoadedQuote['items'], selection: SelectionInput[] | undefined): Applied[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const s of selection ?? []) if (!byId.has(s.itemId)) throw badRequest('That quotation line does not exist');
  const choice = new Map((selection ?? []).map((s) => [s.itemId, s]));
  return items.map((i) => {
    const c = choice.get(i.id);
    if (!i.isOptional) return { id: i.id, isSelected: true, quantity: i.quantity };
    const isSelected = c?.selected ?? i.isSelected;
    let quantity = i.quantity;
    if (i.allowQuantity && c?.quantity !== undefined) {
      const q = Math.floor(Number(c.quantity));
      if (!Number.isFinite(q)) throw badRequest('Choose a valid quantity');
      quantity = new Prisma.Decimal(Math.min(Math.max(q, i.minQuantity), i.maxQuantity ?? Number.MAX_SAFE_INTEGER));
    }
    return { id: i.id, isSelected, quantity };
  });
}

function priced(q: LoadedQuote, applied: Applied[]) {
  const state = new Map(applied.map((a) => [a.id, a]));
  const lines = q.items.map((i) => {
    const a = state.get(i.id)!;
    return { item: i, isSelected: a.isSelected, quantity: a.quantity, computed: computeLine({ quantity: a.quantity, unitPrice: i.unitPrice, discountAmount: i.discountAmount, taxRate: i.taxRate }) };
  });
  const totals = totalsFor(lines.map((l) => ({ quantity: l.quantity, unitPrice: l.item.unitPrice, discountAmount: l.item.discountAmount, taxRate: l.item.taxRate, isSelected: l.isSelected })), docDiscountOf(q));
  return { lines, totals };
}

async function settingsFor(organizationId: string) {
  const s = await prisma.organizationSetting.findUnique({ where: { organizationId } });
  return { brandColor: s?.brandColor ?? null, upiId: s?.upiId ?? null, bankAccountName: s?.bankAccountName ?? null, bankName: s?.bankName ?? null, bankAccountNumber: s?.bankAccountNumber ?? null, bankIfsc: s?.bankIfsc ?? null, advancePercentDefault: s?.advancePercent ?? 30, balanceDefault: s?.balanceDueDaysBefore ?? 7, termsDefault: s?.defaultTerms ?? null };
}

async function buildDto(q: LoadedQuote, applied: Applied[], opts: { revealPayment: boolean }) {
  const settings = await settingsFor(q.organizationId);
  const today = toDateOnly(todayIn(q.organization.timezone));
  const status = effectiveStatus(q, today);
  const { lines, totals } = priced(q, applied);
  const advancePercent = q.advancePercent ?? settings.advancePercentDefault;
  const plan = paymentPlan(totals.total, advancePercent, q.balanceDueDaysBefore ?? settings.balanceDefault, q.eventDate, today);

  let dateStatus: { status: string; sellable: boolean; reason: string } | null = null;
  if (q.eventDate && status === 'SENT') {
    const d = await checkDate(q.organizationId, ymd(q.eventDate));
    dateStatus = { status: d.status, sellable: isSellable(d.status), reason: reasonFor(d.status) };
  }
  const advance = plan[0];
  const upiId = settings.upiId;
  const payment = opts.revealPayment && advance && (upiId || settings.bankAccountNumber) ? {
    amount: Number(advance.amount), upiId,
    upiLink: upiId ? `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(q.organization.name)}&am=${Number(advance.amount).toFixed(2)}&cu=INR&tn=${encodeURIComponent(`${q.quotationNumber} advance`)}` : null,
    bank: settings.bankAccountNumber ? { accountName: settings.bankAccountName, bankName: settings.bankName, accountNumber: settings.bankAccountNumber, ifsc: settings.bankIfsc } : null,
  } : null;

  return {
    studio: { name: q.organization.name, phone: q.organization.phone, email: q.organization.email, website: q.organization.website, gstNumber: q.organization.gstNumber, address: [q.organization.addressLine, q.organization.city, q.organization.state, q.organization.postalCode].filter(Boolean).join(', ') || null, brandColor: settings.brandColor },
    quote: {
      number: q.quotationNumber, status, issueDate: ymd(q.issueDate), validUntil: q.validUntil ? ymd(q.validUntil) : null,
      daysLeft: q.validUntil ? Math.max(0, Math.round((q.validUntil.getTime() - today.getTime()) / 86_400_000)) : null,
      customerName: q.customerName, eventType: q.eventType, eventDate: q.eventDate ? ymd(q.eventDate) : null, eventDays: q.eventDays, guestCount: q.guestCount, venueName: q.venueName, venueCity: q.venueCity,
      notes: q.notes, terms: q.termsAndConditions ?? settings.termsDefault,
      items: lines.map((l) => ({
        id: l.item.id, kind: l.item.kind, service: l.item.service, description: l.item.description, inclusions: l.item.inclusions, isOptional: l.item.isOptional, isSelected: l.isSelected,
        allowQuantity: l.item.allowQuantity, minQuantity: l.item.minQuantity, maxQuantity: l.item.maxQuantity, pricingType: l.item.pricingType, unitLabel: l.item.unitLabel,
        quantity: Number(l.quantity), unitPrice: Number(l.item.unitPrice), taxRate: Number(l.item.taxRate), discountAmount: Number(l.item.discountAmount), lineTotal: Number(l.computed.lineTotal),
      })),
      totals: { subtotal: Number(totals.subtotal), discount: Number(totals.discountAmount), tax: Number(totals.taxAmount), total: Number(totals.total) },
      advancePercent, paymentPlan: plan.map((s) => ({ title: s.title, amount: Number(s.amount), dueDate: ymd(s.dueDate) })),
      acceptedAt: q.acceptedAt, acceptedByName: q.acceptedByName, declinedAt: q.declinedAt,
    },
    canAct: status === 'SENT' && (dateStatus?.sellable ?? true),
    dateStatus, payment,
  };
}

const selectionFromStored = (q: LoadedQuote): Applied[] => q.items.map((i) => ({ id: i.id, isSelected: i.isSelected, quantity: i.quantity }));

export async function getPublicQuote(token: string, opts: { track: boolean }) {
  const q = await loadByToken(token);
  if (opts.track && q.status !== 'CANCELLED') await trackView(q);
  return buildDto(q, selectionFromStored(q), { revealPayment: q.status === 'ACCEPTED' });
}

async function trackView(q: LoadedQuote) {
  const now = new Date();
  const recent = q.lastViewedAt && now.getTime() - q.lastViewedAt.getTime() < 10 * 60_000;
  if (recent) return;
  await prisma.quotation.update({ where: { id: q.id }, data: { viewCount: { increment: 1 }, lastViewedAt: now, firstViewedAt: q.firstViewedAt ?? now } });
  if (!q.firstViewedAt) {
    await logQuoteEvent(prisma, q.organizationId, q.id, 'VIEWED', { type: 'CLIENT' }, { first: true });
    await notifyStaff(q.organizationId, { title: `${q.customerName ?? 'A customer'} opened quotation ${q.quotationNumber}`, message: 'They are looking at it right now: a good moment to follow up.', entityType: 'Quotation', entityId: q.id }, { userIds: [q.createdById, q.lead?.ownerId], permissions: ['QUOTATION_UPDATE'] });
  } else if (q.lastViewedAt && now.getTime() - q.lastViewedAt.getTime() > 6 * 3_600_000) {
    await logQuoteEvent(prisma, q.organizationId, q.id, 'VIEWED', { type: 'CLIENT' }, { first: false });
  }
}

export async function previewSelection(token: string, selection: SelectionInput[]) {
  const q = await loadByToken(token);
  return buildDto(q, applySelection(q.items, selection), { revealPayment: false });
}

export async function acceptPublicQuote(token: string, input: { name: string; selection?: SelectionInput[] }, meta: RequestMeta) {
  const q = await loadByToken(token);
  if (q.status === 'ACCEPTED') return acceptedResult(q, true);
  const today = toDateOnly(todayIn(q.organization.timezone));
  const status = effectiveStatus(q, today);
  if (status === 'EXPIRED') throw conflict('This quotation has expired. Please contact the studio for a fresh one.');
  if (status !== 'SENT') throw conflict(`This quotation is ${status.toLowerCase()} and can no longer be accepted.`);

  const applied = applySelection(q.items, input.selection);
  if (!applied.some((a) => a.isSelected)) throw badRequest('Choose at least one item');
  const { lines, totals } = priced(q, applied);

  await prisma.$transaction(async (tx) => {
    for (const l of lines) {
      await tx.quotationItem.update({ where: { id: l.item.id }, data: { isSelected: l.isSelected, quantity: l.quantity, lineTotal: l.computed.lineTotal, taxAmount: l.computed.taxAmount } });
    }
    await tx.quotation.update({
      where: { id: q.id },
      data: { subtotal: totals.subtotal, discountAmount: totals.discountAmount, taxAmount: totals.taxAmount, grandTotal: totals.total, acceptedAt: new Date(), acceptedByName: input.name.trim(), acceptedIp: meta.ip ?? null, acceptedUserAgent: meta.userAgent?.slice(0, 512) ?? null, status: 'ACCEPTED' },
    });
    await logQuoteEvent(tx, q.organizationId, q.id, 'ACCEPTED', { type: 'CLIENT' }, { name: input.name.trim(), total: Number(totals.total), ip: meta.ip ?? null, addons: lines.filter((l) => l.item.isOptional && l.isSelected).map((l) => l.item.service) });
  });

  try {
    const booking = await bookQuotation({ organizationId: q.organizationId, quotationId: q.id, actor: { type: 'CLIENT' } });
    const fresh = await loadByToken(token);
    void notifyAccepted(fresh, booking.projectNumber);
    return { ...(await acceptedResult(fresh, false)), booking: { advanceAmount: booking.advanceAmount } };
  } catch (error) {
    // The date went to someone else a moment ago: undo the acceptance so nothing half-finished remains.
    if (isDateTaken(error)) {
      await prisma.quotation.update({ where: { id: q.id }, data: { status: 'SENT', acceptedAt: null, acceptedByName: null, acceptedIp: null, acceptedUserAgent: null } });
      await notifyStaff(q.organizationId, { title: `Date clash on ${q.quotationNumber}`, message: `${q.customerName ?? 'A customer'} tried to accept for ${q.eventDate ? ymd(q.eventDate) : 'a date'}, but it was just booked by someone else. Call them to offer another date.`, entityType: 'Quotation', entityId: q.id }, { userIds: [q.createdById, q.lead?.ownerId], permissions: ['QUOTATION_UPDATE'] });
    }
    throw error;
  }
}

async function acceptedResult(q: LoadedQuote, already: boolean) {
  const dto = await buildDto(q, selectionFromStored(q), { revealPayment: true });
  return { accepted: true, already, quote: dto.quote, payment: dto.payment, studio: dto.studio };
}

function notifyAccepted(q: LoadedQuote, projectNumber: string) {
  return notifyStaff(q.organizationId, {
    title: `Booked: ${q.customerName ?? 'A customer'} accepted ${q.quotationNumber}`,
    message: `Project ${projectNumber} and a payment schedule were created for ${q.eventDate ? ymd(q.eventDate) : 'the event'}.`,
    entityType: 'Quotation', entityId: q.id,
  }, {
    userIds: [q.createdById, q.lead?.ownerId], permissions: ['QUOTATION_UPDATE'],
    email: (to) => quoteAcceptedStaffEmail({ to, customerName: q.customerName ?? 'A customer', quoteNumber: q.quotationNumber, total: Number(q.grandTotal), eventDate: q.eventDate, link: `${env.APP_URL.replace(/\/$/, '')}/quotes` }),
  });
}

export async function declinePublicQuote(token: string, input: { reason?: string | null }) {
  const q = await loadByToken(token);
  if (q.status === 'REJECTED') return { declined: true };
  if (q.status !== 'SENT') throw conflict(`This quotation is ${q.status.toLowerCase()} and cannot be declined.`);
  await prisma.$transaction(async (tx) => {
    await tx.quotation.update({ where: { id: q.id }, data: { status: 'REJECTED', declinedAt: new Date(), declineReason: input.reason?.trim() || null } });
    await logQuoteEvent(tx, q.organizationId, q.id, 'DECLINED', { type: 'CLIENT' }, { reason: input.reason?.trim() || null });
  });
  await notifyStaff(q.organizationId, { title: `${q.customerName ?? 'A customer'} declined ${q.quotationNumber}`, message: input.reason?.trim() ? `Reason: ${input.reason.trim()}` : 'No reason was given. Consider a follow-up call.', entityType: 'Quotation', entityId: q.id }, { userIds: [q.createdById, q.lead?.ownerId], permissions: ['QUOTATION_UPDATE'] });
  return { declined: true };
}

export async function messageFromQuote(token: string, input: { message: string; name?: string | null; phone?: string | null }) {
  const q = await loadByToken(token);
  if (q.status === 'CANCELLED') throw conflict('This quotation is no longer available.');
  await logQuoteEvent(prisma, q.organizationId, q.id, 'MESSAGE_RECEIVED', { type: 'CLIENT' }, { message: input.message.trim(), name: input.name ?? q.customerName, phone: input.phone ?? q.customerPhone });
  await notifyStaff(q.organizationId, { title: `${q.customerName ?? 'A customer'} sent a question about ${q.quotationNumber}`, message: input.message.trim().slice(0, 300), entityType: 'Quotation', entityId: q.id }, { userIds: [q.createdById, q.lead?.ownerId], permissions: ['QUOTATION_UPDATE'] });
  return { sent: true };
}

/** The same page as the customer sees, for staff to check before sending. Does not count as a view. */
export async function previewForStaff(auth: AuthContext, id: string) {
  const q = await prisma.quotation.findFirst({
    where: { id, organizationId: auth.organizationId, deletedAt: null },
    include: { items: { orderBy: { sortOrder: 'asc' } }, organization: { select: STUDIO_SELECT }, lead: { select: { id: true, ownerId: true } } },
  });
  if (!q) throw notFound('Quotation');
  return buildDto(q, selectionFromStored(q), { revealPayment: q.status === 'ACCEPTED' });
}

