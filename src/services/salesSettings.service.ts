import { prisma } from '../config/prisma';
import { AuthContext } from '../types';
import { notFound } from '../utils/errors';
import { toDateOnly } from '../utils/date';
import { AuditRequestContext, recordAudit } from './audit.service';

/** Business details, sales defaults, availability rules, reminders, the enquiry page and closed dates. */

const SETTING_FIELDS = [
  'upiId', 'bankAccountName', 'bankName', 'bankAccountNumber', 'bankIfsc', 'defaultTerms', 'brandColor',
  'quoteValidDays', 'advancePercent', 'balanceDueDaysBefore', 'capacityPerDay', 'minLeadDays', 'maxAdvanceDays', 'remindersEnabled', 'remindersEmailClients',
] as const;

/** Studio details that live on the organisation but are edited here, so one permission covers the whole setup. */
const ORG_FIELDS = ['gstNumber', 'phone', 'email', 'website', 'addressLine', 'city', 'state', 'postalCode'] as const;

export async function getSalesSettings(organizationId: string) {
  const [org, setting] = await Promise.all([
    prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { name: true, slug: true, legalName: true, email: true, phone: true, website: true, gstNumber: true, panNumber: true, addressLine: true, city: true, state: true, postalCode: true, timezone: true },
    }),
    prisma.organizationSetting.findUnique({ where: { organizationId } }),
  ]);
  const pick = <K extends (typeof SETTING_FIELDS)[number]>(k: K) => (setting as Record<string, unknown> | null)?.[k];
  return {
    business: org,
    upiId: (pick('upiId') as string | null) ?? null,
    bankAccountName: (pick('bankAccountName') as string | null) ?? null,
    bankName: (pick('bankName') as string | null) ?? null,
    bankAccountNumber: (pick('bankAccountNumber') as string | null) ?? null,
    bankIfsc: (pick('bankIfsc') as string | null) ?? null,
    defaultTerms: (pick('defaultTerms') as string | null) ?? null,
    brandColor: (pick('brandColor') as string | null) ?? null,
    quoteValidDays: (pick('quoteValidDays') as number | undefined) ?? 7,
    advancePercent: (pick('advancePercent') as number | undefined) ?? 30,
    balanceDueDaysBefore: (pick('balanceDueDaysBefore') as number | undefined) ?? 7,
    capacityPerDay: (pick('capacityPerDay') as number | undefined) ?? 1,
    minLeadDays: (pick('minLeadDays') as number | undefined) ?? 0,
    maxAdvanceDays: (pick('maxAdvanceDays') as number | undefined) ?? 730,
    remindersEnabled: (pick('remindersEnabled') as boolean | undefined) ?? true,
    remindersEmailClients: (pick('remindersEmailClients') as boolean | undefined) ?? true,
  };
}

export async function updateSalesSettings(auth: AuthContext, input: Record<string, unknown>, ctx: AuditRequestContext) {
  const data: Record<string, unknown> = {};
  for (const key of SETTING_FIELDS) if (key in input && input[key] !== undefined) data[key] = input[key];
  const orgFields = ORG_FIELDS.filter((key) => key in input && input[key] !== undefined);
  const orgData = orgFields.length ? Object.fromEntries(orgFields.map((key) => [key, input[key] as string | null])) : null;

  await prisma.$transaction(async (tx) => {
    if (Object.keys(data).length) {
      await tx.organizationSetting.upsert({ where: { organizationId: auth.organizationId }, create: { organizationId: auth.organizationId, ...data }, update: data });
    }
    if (orgData) await tx.organization.update({ where: { id: auth.organizationId }, data: orgData });
    await recordAudit(tx, ctx, { action: 'UPDATE', entityType: 'OrganizationSetting', entityId: auth.organizationId, summary: 'Sales and business settings updated', newData: { fields: [...Object.keys(data), ...orgFields] } });
  });
  return getSalesSettings(auth.organizationId);
}

// ── Enquiry page ────────────────────────────────────────────────────────────
export async function getEnquiryPage(organizationId: string) {
  const [org, page] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { name: true, slug: true } }),
    prisma.enquiryPage.findUnique({ where: { organizationId } }),
  ]);
  return {
    slug: org.slug,
    isEnabled: page?.isEnabled ?? false,
    headline: page?.headline ?? `Plan your day with ${org.name}`,
    intro: page?.intro ?? 'Tell us about your event and pick a package. We will check the date and send you a quote.',
    thankYouMessage: page?.thankYouMessage ?? 'Thank you! We have your enquiry and will be in touch very soon.',
    autoQuoteMode: page?.autoQuoteMode ?? 'APPROVAL',
    showPrices: page?.showPrices ?? true,
    askGuestCount: page?.askGuestCount ?? false,
    askVenue: page?.askVenue ?? true,
    eventTypes: (page?.eventTypes ?? []) as string[],
  };
}

export async function updateEnquiryPage(auth: AuthContext, input: Record<string, unknown>, ctx: AuditRequestContext) {
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) if (v !== undefined) data[k] = v;
  await prisma.$transaction(async (tx) => {
    await tx.enquiryPage.upsert({ where: { organizationId: auth.organizationId }, create: { organizationId: auth.organizationId, ...data }, update: data });
    await recordAudit(tx, ctx, { action: 'UPDATE', entityType: 'EnquiryPage', entityId: auth.organizationId, summary: 'Enquiry page updated', newData: data });
  });
  return getEnquiryPage(auth.organizationId);
}

// ── Closed dates ────────────────────────────────────────────────────────────
export async function listBlockedDates(organizationId: string, from?: string, to?: string) {
  const rows = await prisma.blockedDate.findMany({
    where: { organizationId, ...(from ? { endDate: { gte: toDateOnly(from) } } : {}), ...(to ? { startDate: { lte: toDateOnly(to) } } : {}) },
    orderBy: { startDate: 'asc' },
    take: 500,
  });
  return rows.map((r) => ({ id: r.id, startDate: r.startDate.toISOString().slice(0, 10), endDate: r.endDate.toISOString().slice(0, 10), reason: r.reason }));
}

export async function createBlockedDate(auth: AuthContext, input: { startDate: string; endDate: string; reason?: string | null }, ctx: AuditRequestContext) {
  const row = await prisma.blockedDate.create({ data: { organizationId: auth.organizationId, createdById: auth.userId, startDate: toDateOnly(input.startDate), endDate: toDateOnly(input.endDate), reason: input.reason ?? null } });
  await recordAudit(prisma, ctx, { action: 'CREATE', entityType: 'BlockedDate', entityId: row.id, summary: `Dates closed: ${input.startDate} to ${input.endDate}` });
  return { id: row.id, startDate: input.startDate, endDate: input.endDate, reason: row.reason };
}

export async function deleteBlockedDate(auth: AuthContext, id: string, ctx: AuditRequestContext) {
  const row = await prisma.blockedDate.findFirst({ where: { id, organizationId: auth.organizationId } });
  if (!row) throw notFound('Closed date');
  await prisma.blockedDate.delete({ where: { id } });
  await recordAudit(prisma, ctx, { action: 'DELETE', entityType: 'BlockedDate', entityId: id, summary: 'Closed dates reopened' });
}
