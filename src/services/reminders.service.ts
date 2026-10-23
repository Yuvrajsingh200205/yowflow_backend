import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { logger } from '../config/logger';
import { env } from '../config/env';
import { toDateOnly } from '../utils/date';
import { todayIn, ymd } from '../utils/quotePricing';
import { paymentReminderEmail, quoteNudgeEmail, sendMail } from './mailer.service';
import { effectiveStatus, logQuoteEvent, publicQuoteUrl, toWaPhone } from './quoteEngine.service';
import { notifyStaff } from './staffNotify.service';

/**
 * The daily reminder job, and the "today" list shown to staff.
 *
 * A reminder is claimed in `reminder_logs` before it is sent (the unique key makes a double run harmless), and
 * released if sending fails so the next run tries again. Tiers rather than exact days are used, so a missed day
 * still produces the right reminder once.
 */

const DAY = 86_400_000;
const OPEN_PROJECT = { notIn: ['CANCELLED', 'COMPLETED'] as ('CANCELLED' | 'COMPLETED')[] };

async function claim(organizationId: string, kind: string, entityType: string, entityId: string, channel: string, key: string): Promise<boolean> {
  try {
    await prisma.reminderLog.create({ data: { organizationId, kind, entityType, entityId, channel, dedupeKey: key } });
    return true;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return false;
    throw error;
  }
}
const release = (key: string) => prisma.reminderLog.deleteMany({ where: { dedupeKey: key } }).catch(() => undefined);

export type PaymentTier = 'SOON' | 'TODAY' | 'OVERDUE_1' | 'OVERDUE_2' | 'OVERDUE_3';
/** Which reminder a payment is due for, given how many days remain until (negative: since) its due date. */
export function paymentTier(daysUntil: number): PaymentTier | null {
  if (daysUntil >= 1 && daysUntil <= 3) return 'SOON';
  if (daysUntil === 0) return 'TODAY';
  if (daysUntil <= -1 && daysUntil >= -3) return 'OVERDUE_1';
  if (daysUntil <= -4 && daysUntil >= -7) return 'OVERDUE_2';
  if (daysUntil <= -8 && daysUntil >= -30) return 'OVERDUE_3';
  return null;
}

export interface ReminderRunResult { organizations: number; paymentEmails: number; paymentNotices: number; quoteNudges: number; quotesExpired: number; reviewNotices: number }

export async function runReminders(now = new Date(), only?: { organizationId: string }): Promise<ReminderRunResult> {
  const result: ReminderRunResult = { organizations: 0, paymentEmails: 0, paymentNotices: 0, quoteNudges: 0, quotesExpired: 0, reviewNotices: 0 };
  const orgs = await prisma.organization.findMany({
    where: { deletedAt: null, status: 'ACTIVE', ...(only ? { id: only.organizationId } : {}) },
    select: { id: true, name: true, email: true, phone: true, timezone: true },
  });
  for (const org of orgs) {
    try {
      const s = await prisma.organizationSetting.findUnique({ where: { organizationId: org.id }, select: { remindersEnabled: true, remindersEmailClients: true, upiId: true } });
      if (s && !s.remindersEnabled) continue;
      result.organizations += 1;
      const today = toDateOnly(todayIn(org.timezone, now));
      await paymentReminders(org, today, s?.remindersEmailClients ?? true, s?.upiId ?? null, result);
      await quoteReminders(org, today, now, s?.remindersEmailClients ?? true, result);
    } catch (error) {
      logger.error({ err: error, organizationId: org.id }, 'reminder run failed for studio');
    }
  }
  return result;
}

type Org = { id: string; name: string; email: string | null; phone: string | null; timezone: string };

async function paymentReminders(org: Org, today: Date, emailClients: boolean, upiId: string | null, out: ReminderRunResult) {
  const horizonFrom = new Date(today.getTime() - 30 * DAY);
  const horizonTo = new Date(today.getTime() + 3 * DAY);
  const milestones = await prisma.paymentMilestone.findMany({
    where: { organizationId: org.id, status: { in: ['PENDING', 'OVERDUE'] }, amount: { gt: 0 }, dueDate: { gte: horizonFrom, lte: horizonTo }, project: { deletedAt: null, status: OPEN_PROJECT } },
    include: { project: { select: { id: true, name: true, managerId: true, createdById: true, client: { select: { displayName: true, primaryEmail: true } } } } },
    take: 500,
  });
  for (const m of milestones) {
    const daysUntil = Math.round(((m.dueDate as Date).getTime() - today.getTime()) / DAY);
    const tier = paymentTier(daysUntil);
    if (!tier) continue;
    const overdue = daysUntil < 0;
    const amount = Number(m.amount);

    if (await claim(org.id, `PAYMENT_${tier}`, 'PaymentMilestone', m.id, 'IN_APP', `pm:${m.id}:${tier}:app`)) {
      await notifyStaff(org.id, {
        title: overdue ? `Payment overdue: ${m.project.client.displayName}` : `Payment due ${daysUntil === 0 ? 'today' : `in ${daysUntil} day${daysUntil > 1 ? 's' : ''}`}: ${m.project.client.displayName}`,
        message: `${m.title} of ₹${new Intl.NumberFormat('en-IN').format(amount)} for ${m.project.name}${overdue ? ` was due on ${ymd(m.dueDate as Date)}` : ''}. Send a reminder on WhatsApp from the Quotes page.`,
        entityType: 'Project', entityId: m.project.id,
      }, { userIds: [m.project.managerId, m.project.createdById], permissions: ['PAYMENT_VIEW'] });
      out.paymentNotices += 1;
    }
    const email = m.project.client.primaryEmail;
    if (emailClients && email && (tier === 'SOON' || tier === 'OVERDUE_1' || tier === 'OVERDUE_3')) {
      const key = `pm:${m.id}:${tier}:mail`;
      if (await claim(org.id, `PAYMENT_${tier}`, 'PaymentMilestone', m.id, 'EMAIL', key)) {
        try {
          await sendMail(paymentReminderEmail({ to: email, name: m.project.client.displayName, studioName: org.name, title: m.title, amount, dueDate: m.dueDate as Date, overdue, projectName: m.project.name, upiId, replyTo: org.email }));
          out.paymentEmails += 1;
        } catch (error) {
          logger.warn({ err: error }, 'payment reminder e-mail failed');
          await release(key);
        }
      }
    }
  }
}

async function quoteReminders(org: Org, today: Date, now: Date, emailClients: boolean, out: ReminderRunResult) {
  const open = await prisma.quotation.findMany({
    where: { organizationId: org.id, deletedAt: null, status: { in: ['DRAFT', 'SENT'] } },
    select: { id: true, status: true, quotationNumber: true, needsReview: true, customerName: true, customerEmail: true, validUntil: true, sentAt: true, firstViewedAt: true, createdAt: true, createdById: true, publicToken: true, lead: { select: { ownerId: true } } },
    take: 500,
  });
  for (const q of open) {
    const who = { userIds: [q.createdById, q.lead?.ownerId], permissions: ['QUOTATION_UPDATE'] };
    if (q.status === 'DRAFT') {
      if (q.needsReview && now.getTime() - q.createdAt.getTime() > 4 * 3_600_000 && (await claim(org.id, 'QUOTE_REVIEW', 'Quotation', q.id, 'IN_APP', `q:${q.id}:review`))) {
        await notifyStaff(org.id, { title: `Enquiry waiting for review: ${q.customerName ?? q.quotationNumber}`, message: 'A quotation was prepared from their enquiry. Check it and send it.', entityType: 'Quotation', entityId: q.id }, who);
        out.reviewNotices += 1;
      }
      continue;
    }
    const status = effectiveStatus(q, today);
    if (status === 'EXPIRED') {
      await prisma.quotation.update({ where: { id: q.id }, data: { status: 'EXPIRED' } });
      await logQuoteEvent(prisma, org.id, q.id, 'EXPIRED', { type: 'SYSTEM' });
      if (await claim(org.id, 'QUOTE_EXPIRED', 'Quotation', q.id, 'IN_APP', `q:${q.id}:expired`)) {
        await notifyStaff(org.id, { title: `Quotation expired: ${q.customerName ?? q.quotationNumber}`, message: 'It was not accepted in time. You can send it again with a fresh validity.', entityType: 'Quotation', entityId: q.id }, who);
      }
      out.quotesExpired += 1;
      continue;
    }
    const link = q.publicToken ? publicQuoteUrl(q.publicToken) : null;
    const hoursSinceSent = q.sentAt ? (now.getTime() - q.sentAt.getTime()) / 3_600_000 : 0;

    if (!q.firstViewedAt && hoursSinceSent >= 48 && (await claim(org.id, 'QUOTE_NOT_OPENED', 'Quotation', q.id, 'IN_APP', `q:${q.id}:notopened:app`))) {
      await notifyStaff(org.id, { title: `Not opened yet: ${q.customerName ?? q.quotationNumber}`, message: 'The quotation was sent two days ago and has not been opened. A WhatsApp nudge often helps.', entityType: 'Quotation', entityId: q.id }, who);
      out.quoteNudges += 1;
    }
    if (!q.firstViewedAt && hoursSinceSent >= 48 && emailClients && q.customerEmail && link) {
      const key = `q:${q.id}:notopened:mail`;
      if (await claim(org.id, 'QUOTE_NOT_OPENED', 'Quotation', q.id, 'EMAIL', key)) {
        try { await sendMail(quoteNudgeEmail({ to: q.customerEmail, name: q.customerName ?? '', studioName: org.name, link, kind: 'NOT_OPENED', replyTo: org.email })); } catch (error) { logger.warn({ err: error }, 'quote nudge failed'); await release(key); }
      }
    }
    const daysLeft = q.validUntil ? Math.round((q.validUntil.getTime() - today.getTime()) / DAY) : null;
    if (daysLeft !== null && daysLeft >= 0 && daysLeft <= 2) {
      if (await claim(org.id, 'QUOTE_EXPIRING', 'Quotation', q.id, 'IN_APP', `q:${q.id}:expiring:app`)) {
        await notifyStaff(org.id, { title: `Expires ${daysLeft === 0 ? 'today' : `in ${daysLeft} day${daysLeft > 1 ? 's' : ''}`}: ${q.customerName ?? q.quotationNumber}`, message: 'Follow up before the quotation lapses.', entityType: 'Quotation', entityId: q.id }, who);
        out.quoteNudges += 1;
      }
      if (emailClients && q.customerEmail && link) {
        const key = `q:${q.id}:expiring:mail`;
        if (await claim(org.id, 'QUOTE_EXPIRING', 'Quotation', q.id, 'EMAIL', key)) {
          try { await sendMail(quoteNudgeEmail({ to: q.customerEmail, name: q.customerName ?? '', studioName: org.name, link, kind: 'EXPIRING', validUntil: q.validUntil, replyTo: org.email })); } catch (error) { logger.warn({ err: error }, 'quote expiry nudge failed'); await release(key); }
        }
      }
    }
  }
}

// ── The staff "today" list ──────────────────────────────────────────────────
const waLink = (phone: string | null | undefined, text: string) => {
  const p = toWaPhone(phone);
  return p ? `https://wa.me/${p}?text=${encodeURIComponent(text)}` : null;
};

export async function todayList(organizationId: string, can: { payments: boolean }) {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { name: true, timezone: true } });
  const today = toDateOnly(todayIn(org.timezone));
  const now = new Date();
  const [quotes, milestones, leads] = await Promise.all([
    prisma.quotation.findMany({
      where: { organizationId, deletedAt: null, status: { in: ['DRAFT', 'SENT'] } },
      select: { id: true, status: true, quotationNumber: true, needsReview: true, customerName: true, customerPhone: true, grandTotal: true, validUntil: true, sentAt: true, firstViewedAt: true, viewCount: true, publicToken: true, createdAt: true },
      orderBy: { createdAt: 'desc' }, take: 200,
    }),
    can.payments
      ? prisma.paymentMilestone.findMany({
          where: { organizationId, status: { in: ['PENDING', 'OVERDUE'] }, amount: { gt: 0 }, dueDate: { lte: new Date(today.getTime() + 7 * DAY) }, project: { deletedAt: null, status: OPEN_PROJECT } },
          include: { project: { select: { id: true, name: true, client: { select: { displayName: true, primaryPhone: true } } } } },
          orderBy: { dueDate: 'asc' }, take: 100,
        })
      : Promise.resolve([]),
    prisma.lead.findMany({
      where: { organizationId, deletedAt: null, status: { notIn: ['WON', 'LOST'] }, nextFollowUpAt: { lte: new Date(today.getTime() + DAY) } },
      select: { id: true, name: true, phone: true, nextFollowUpAt: true, eventDate: true }, orderBy: { nextFollowUpAt: 'asc' }, take: 50,
    }),
  ]);

  const quoteRow = (q: (typeof quotes)[number], hint: string) => ({
    id: q.id, number: q.quotationNumber, customer: q.customerName, total: Number(q.grandTotal), hint, viewCount: q.viewCount,
    whatsappUrl: q.publicToken && q.status === 'SENT' ? waLink(q.customerPhone, `Hi ${q.customerName ?? ''}, a quick follow-up on your quotation from ${org.name}: ${publicQuoteUrl(q.publicToken)}`) : null,
  });
  const live = quotes.map((q) => ({ q, status: effectiveStatus(q, today) }));
  const hoursSince = (d: Date | null) => (d ? (now.getTime() - d.getTime()) / 3_600_000 : 0);

  return {
    toReview: live.filter(({ q }) => q.status === 'DRAFT' && q.needsReview).map(({ q }) => quoteRow(q, 'Prepared from an enquiry. Review and send.')),
    notOpened: live.filter(({ q, status }) => status === 'SENT' && !q.firstViewedAt && hoursSince(q.sentAt) >= 24).map(({ q }) => quoteRow(q, 'Sent over a day ago and not opened yet.')),
    openedNotAccepted: live.filter(({ q, status }) => status === 'SENT' && q.firstViewedAt && hoursSince(q.firstViewedAt) >= 24).map(({ q }) => quoteRow(q, `Opened ${q.viewCount} time${q.viewCount === 1 ? '' : 's'}, not accepted yet.`)),
    expiringSoon: live.filter(({ q, status }) => status === 'SENT' && q.validUntil && (q.validUntil.getTime() - today.getTime()) / DAY <= 2).map(({ q }) => quoteRow(q, `Expires ${ymd(q.validUntil as Date)}.`)),
    payments: milestones.map((m) => {
      const due = m.dueDate as Date;
      const days = Math.round((due.getTime() - today.getTime()) / DAY);
      const rupees = `₹${new Intl.NumberFormat('en-IN').format(Number(m.amount))}`;
      return {
        id: m.id, projectId: m.project.id, project: m.project.name, client: m.project.client.displayName, title: m.title, amount: Number(m.amount), dueDate: ymd(due), daysUntil: days, overdue: days < 0,
        whatsappUrl: waLink(m.project.client.primaryPhone, days < 0 ? `Hi ${m.project.client.displayName}, a gentle reminder from ${org.name}: your ${m.title.toLowerCase()} payment of ${rupees} was due on ${ymd(due)}. Please let us know once it is done. Thank you!` : `Hi ${m.project.client.displayName}, a gentle reminder from ${org.name}: your ${m.title.toLowerCase()} payment of ${rupees} is due on ${ymd(due)}. Thank you!`),
      };
    }),
    followUps: leads.map((l) => ({ id: l.id, name: l.name, phone: l.phone, dueAt: l.nextFollowUpAt, eventDate: l.eventDate ? ymd(l.eventDate) : null, whatsappUrl: waLink(l.phone, `Hi ${l.name}, this is ${org.name}. Just following up on your enquiry.`) })),
  };
}

export const cronConfigured = () => Boolean(env.CRON_SECRET);
