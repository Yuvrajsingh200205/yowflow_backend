import { Prisma, ProjectType } from '@prisma/client';
import { prisma } from '../config/prisma';
import { AppError, conflict, notFound } from '../utils/errors';
import { nextDocumentNumber } from '../utils/documentNumber';
import { computeLine } from '../utils/money';
import { paymentPlan, todayIn, totalsFor, ymd } from '../utils/quotePricing';
import { toDateOnly } from '../utils/date';
import { recordAudit } from './audit.service';
import { checkDate, isSellable, reasonFor } from './availability.service';
import { loadSalesDefaults, logQuoteEvent } from './quoteEngine.service';
import { clientIdByPhone } from '../utils/phoneMatch';

/**
 * Turns an accepted quotation into a booking: the client record, the project with its dates, the payment
 * schedule and a draft invoice. Runs in one transaction, and takes a lock per studio and date so two
 * customers accepting for the same date at the same moment cannot both get it.
 */

export const DATE_UNAVAILABLE = 'DATE_UNAVAILABLE';
const dateTaken = (reason: string) => new AppError(409, 'CONFLICT', reason, [{ field: 'eventDate', message: DATE_UNAVAILABLE }]);
export const isDateTaken = (e: unknown) => e instanceof AppError && e.statusCode === 409 && e.details?.[0]?.message === DATE_UNAVAILABLE;

const LABELS: Record<ProjectType, string> = {
  ROKA: 'Roka', ENGAGEMENT: 'Engagement', PRE_WEDDING: 'Pre-wedding', WEDDING: 'Wedding', COMPLETE_WEDDING_SERVICES: 'Wedding', HALDI_MEHENDI: 'Haldi & Mehendi',
  SANGEET: 'Sangeet', RECEPTION: 'Reception', ANNIVERSARY: 'Anniversary', CORPORATE: 'Corporate event', OTHER: 'Event',
};
export const eventLabel = (t?: ProjectType | null) => LABELS[t ?? 'WEDDING'];

export interface BookArgs {
  organizationId: string;
  quotationId: string;
  actor: { type: 'STAFF' | 'CLIENT' | 'SYSTEM'; id?: string | null };
  overrideAvailability?: boolean;
}

export async function bookQuotation(args: BookArgs) {
  return prisma.$transaction(async (tx) => {
    const quote = await tx.quotation.findFirst({
      where: { id: args.quotationId, organizationId: args.organizationId, deletedAt: null },
      include: { items: { orderBy: { sortOrder: 'asc' } }, lead: true },
    });
    if (!quote) throw notFound('Quotation');
    if (quote.projectId) {
      const existing = await tx.project.findUniqueOrThrow({ where: { id: quote.projectId }, select: { id: true, projectNumber: true, clientId: true } });
      return { projectId: existing.id, projectNumber: existing.projectNumber, clientId: existing.clientId, alreadyBooked: true, advanceAmount: 0, milestones: [] as Array<{ title: string; amount: number; dueDate: string }> };
    }
    if (!['SENT', 'ACCEPTED', 'DRAFT'].includes(quote.status)) throw conflict(`A ${quote.status.toLowerCase()} quotation cannot be booked.`);

    const eventDate = quote.eventDate;
    if (eventDate) {
      // Serialise acceptances for the same studio and date; the check below then sees any booking that just committed.
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', `book:${args.organizationId}:${ymd(eventDate)}`);
      if (!args.overrideAvailability) {
        const day = await checkDate(args.organizationId, ymd(eventDate));
        if (!isSellable(day.status)) throw dateTaken(reasonFor(day.status));
      }
    }

    const defaults = await loadSalesDefaults(tx, args.organizationId);
    const today = toDateOnly(todayIn(defaults.timezone));
    const name = (quote.customerName ?? quote.lead?.name ?? 'Client').trim();
    const phone = (quote.customerPhone ?? quote.lead?.phone ?? '').trim();

    // Client: the one on the quote, else the lead's, else a matching phone number, else a new record.
    let clientId = quote.clientId ?? quote.lead?.clientId ?? null;
    if (!clientId && phone) clientId = await clientIdByPhone(tx, args.organizationId, phone);
    if (!clientId) {
      const clientCode = await nextDocumentNumber(tx, args.organizationId, 'CLIENT');
      const created = await tx.client.create({
        data: { organizationId: args.organizationId, clientCode, displayName: name.slice(0, 160), primaryPhone: phone || 'N/A', primaryEmail: (quote.customerEmail ?? quote.lead?.email)?.toLowerCase() ?? null },
      });
      clientId = created.id;
      await recordAudit(tx, { organizationId: args.organizationId, actorId: args.actor.id ?? null }, { action: 'CREATE', entityType: 'Client', entityId: clientId, summary: `Client ${clientCode} created from quotation ${quote.quotationNumber}` });
    }

    // Project with one event per day of coverage.
    const label = eventLabel(quote.eventType);
    const projectNumber = await nextDocumentNumber(tx, args.organizationId, 'PROJECT');
    const days = Math.max(1, quote.eventDays);
    const selected = quote.items.filter((i) => i.isSelected);
    const lines = selected.map((i) => ({ quantity: i.quantity, unitPrice: i.unitPrice, discountAmount: i.discountAmount, taxRate: i.taxRate }));
    const totals = totalsFor(lines, Prisma.Decimal.max(0, quote.discountAmount.minus(selected.reduce((a, i) => a.plus(i.discountAmount), new Prisma.Decimal(0)))));
    const project = await tx.project.create({
      data: {
        organizationId: args.organizationId, clientId, leadId: quote.leadId, projectNumber, name: `${name} — ${label}`.slice(0, 200), type: quote.eventType ?? 'WEDDING', status: 'UPCOMING',
        weddingDate: eventDate, venueName: quote.venueName, venueCity: quote.venueCity, totalQuotation: quote.grandTotal,
        notes: `Booked from quotation ${quote.quotationNumber}${args.actor.type === 'CLIENT' ? ' (accepted online by the client)' : ''}.`,
        managerId: quote.lead?.ownerId ?? quote.createdById, createdById: quote.createdById,
        events: eventDate ? {
          create: Array.from({ length: days }, (_, d) => ({
            organizationId: args.organizationId, name: days > 1 ? `${label} — Day ${d + 1}` : label,
            eventDate: new Date(eventDate.getTime() + d * 86_400_000), venueName: quote.venueName, city: quote.venueCity, guestCount: quote.guestCount,
          })),
        } : undefined,
      },
    });
    await tx.projectStatusHistory.create({ data: { projectId: project.id, oldStatus: null, newStatus: 'UPCOMING', changedById: args.actor.id ?? null, reason: `Booked from ${quote.quotationNumber}` } });

    const plan = paymentPlan(quote.grandTotal, quote.advancePercent ?? defaults.advancePercent, quote.balanceDueDaysBefore ?? defaults.balanceDueDaysBefore, eventDate, today);
    await tx.paymentMilestone.createMany({ data: plan.map((s) => ({ organizationId: args.organizationId, projectId: project.id, title: s.title, amount: s.amount, dueDate: s.dueDate, notes: `From quotation ${quote.quotationNumber}` })) });

    // A draft invoice carrying the same lines, ready for the studio to review and issue.
    const invoiceNumber = await nextDocumentNumber(tx, args.organizationId, 'INVOICE');
    const computed = selected.map((i) => computeLine({ quantity: i.quantity, unitPrice: i.unitPrice, discountAmount: i.discountAmount, taxRate: i.taxRate }));
    await tx.invoice.create({
      data: {
        organizationId: args.organizationId, invoiceNumber, clientId, projectId: project.id, quotationId: quote.id, issueDate: today, dueDate: plan[plan.length - 1].dueDate,
        subtotal: totals.subtotal, discountAmount: totals.discountAmount, taxAmount: totals.taxAmount, total: totals.total, amountPaid: 0, amountDue: totals.total, status: 'DRAFT',
        notes: `From quotation ${quote.quotationNumber}`, createdById: args.actor.id ?? quote.createdById,
        items: { create: selected.map((i, idx) => ({ service: i.service, description: i.description, quantity: computed[idx].quantity, unitPrice: computed[idx].unitPrice, discountAmount: computed[idx].discountAmount, taxRate: computed[idx].taxRate, taxAmount: computed[idx].taxAmount, lineTotal: computed[idx].lineTotal, sortOrder: idx })) },
      },
    });

    await tx.quotation.update({ where: { id: quote.id }, data: { status: 'ACCEPTED', acceptedAt: quote.acceptedAt ?? new Date(), projectId: project.id, clientId } });
    if (quote.leadId) await tx.lead.update({ where: { id: quote.leadId }, data: { status: 'WON', convertedAt: new Date(), clientId } });
    await logQuoteEvent(tx, args.organizationId, quote.id, 'BOOKED', args.actor, { projectId: project.id, projectNumber, milestones: plan.length });
    await recordAudit(tx, { organizationId: args.organizationId, actorId: args.actor.id ?? null }, { action: 'CREATE', entityType: 'Project', entityId: project.id, summary: `Project ${projectNumber} booked from quotation ${quote.quotationNumber}`, newData: { total: Number(quote.grandTotal) } });

    return {
      projectId: project.id, projectNumber, clientId, alreadyBooked: false, advanceAmount: Number(plan[0].amount),
      milestones: plan.map((s) => ({ title: s.title, amount: Number(s.amount), dueDate: ymd(s.dueDate) })),
    };
  }, { timeout: 60_000, maxWait: 20_000 });
}
