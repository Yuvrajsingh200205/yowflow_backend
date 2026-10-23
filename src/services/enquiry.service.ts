import { Prisma, ProjectType } from '@prisma/client';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { AppError, badRequest, notFound } from '../utils/errors';
import { toDateOnly } from '../utils/date';
import { todayIn, ymd } from '../utils/quotePricing';
import { dayStatuses, isSellable, reasonFor } from './availability.service';
import { buildCatalogLines, createQuoteRecord, loadSalesDefaults, logQuoteEvent } from './quoteEngine.service';
import { notifyStaff } from './staffNotify.service';
import { newEnquiryStaffEmail } from './mailer.service';
import { DATE_UNAVAILABLE } from './booking.service';
import { openLeadIdByPhoneAndDate } from '../utils/phoneMatch';

/** The studio's public page: what it offers, which dates are free, and what happens when someone enquires. */

const DEFAULT_EVENT_TYPES: ProjectType[] = ['WEDDING', 'PRE_WEDDING', 'ENGAGEMENT', 'ROKA', 'HALDI_MEHENDI', 'SANGEET', 'RECEPTION', 'ANNIVERSARY', 'CORPORATE', 'OTHER'];
const ENQUIRY_SOURCE = 'Enquiry page';

async function loadPage(slug: string) {
  if (!/^[a-z0-9-]{2,80}$/.test(slug)) throw notFound('Booking page');
  const org = await prisma.organization.findFirst({
    where: { slug, deletedAt: null, status: 'ACTIVE' },
    select: { id: true, name: true, slug: true, phone: true, email: true, website: true, city: true, timezone: true, enquiryPage: true },
  });
  if (!org || !org.enquiryPage?.isEnabled) throw notFound('Booking page');
  return { org, page: org.enquiryPage };
}

export async function getPublicPage(slug: string) {
  const { org, page } = await loadPage(slug);
  const [items, settings, defaults] = await Promise.all([
    prisma.catalogItem.findMany({ where: { organizationId: org.id, isActive: true, isPublic: true, deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }),
    prisma.organizationSetting.findUnique({ where: { organizationId: org.id }, select: { brandColor: true, minLeadDays: true, maxAdvanceDays: true } }),
    loadSalesDefaults(prisma, org.id),
  ]);
  const shape = (i: (typeof items)[number]) => ({
    id: i.id, kind: i.kind, name: i.name, description: i.description, category: i.category, inclusions: i.inclusions, pricingType: i.pricingType, unitLabel: i.unitLabel,
    isPopular: i.isPopular, allowQuantity: i.allowQuantity, minQuantity: i.minQuantity, maxQuantity: i.maxQuantity, eventTypes: i.eventTypes,
    // Prices are the studio's choice to show; when hidden the customer still gets a quote with prices after submitting.
    unitPrice: page.showPrices ? Number(i.unitPrice) : null, taxRate: page.showPrices ? Number(i.taxRate) : null,
  });
  return {
    studio: { name: org.name, slug: org.slug, phone: org.phone, email: org.email, website: org.website, city: org.city, brandColor: settings?.brandColor ?? null },
    page: { headline: page.headline ?? `Plan your day with ${org.name}`, intro: page.intro, askGuestCount: page.askGuestCount, askVenue: page.askVenue, showPrices: page.showPrices, quoteMode: page.autoQuoteMode, eventTypes: page.eventTypes.length ? page.eventTypes : DEFAULT_EVENT_TYPES },
    packages: items.filter((i) => i.kind === 'PACKAGE').map(shape),
    addons: items.filter((i) => i.kind === 'ADDON').map(shape),
    rules: { minLeadDays: settings?.minLeadDays ?? 0, maxAdvanceDays: settings?.maxAdvanceDays ?? 730, today: todayIn(defaults.timezone) },
  };
}

/** Free or taken, nothing more: customers must not learn who else has booked. */
export async function getPublicAvailability(slug: string, from: string, to: string) {
  const { org } = await loadPage(slug);
  if ((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000 > 100) throw badRequest('Ask for at most 100 days at a time');
  const { days } = await dayStatuses(org.id, from, to);
  return { days: days.map((d) => ({ date: d.date, status: d.status === 'LIMITED' ? 'AVAILABLE' : d.status, bookable: isSellable(d.status) })) };
}

export interface EnquiryInput {
  name: string;
  phone: string;
  email?: string | null;
  eventType: ProjectType;
  eventDate: string;
  eventDays?: number;
  guestCount?: number | null;
  venueName?: string | null;
  venueCity?: string | null;
  packageId?: string | null;
  addonIds?: string[];
  notes?: string | null;
}

const normalizePhone = (p: string) => p.replace(/\D/g, '').slice(-10);

async function enquirySource(organizationId: string) {
  const key = { organizationId_name: { organizationId, name: ENQUIRY_SOURCE } };
  const existing = await prisma.leadSource.findUnique({ where: key });
  if (existing) return existing;
  try {
    return await prisma.leadSource.create({ data: { organizationId, name: ENQUIRY_SOURCE, description: 'Customers who used your public booking page' } });
  } catch {
    // Two enquiries arrived together and the other one created it first.
    return prisma.leadSource.findUniqueOrThrow({ where: key });
  }
}

export async function submitEnquiry(slug: string, input: EnquiryInput) {
  const { org, page } = await loadPage(slug);
  const phone = normalizePhone(input.phone);
  const eventDays = Math.min(Math.max(input.eventDays ?? 1, 1), 14);

  // The date must be one the studio can actually sell.
  const { days } = await dayStatuses(org.id, input.eventDate, input.eventDate);
  const day = days[0];
  if (!isSellable(day.status)) throw new AppError(409, 'CONFLICT', reasonFor(day.status), [{ field: 'eventDate', message: DATE_UNAVAILABLE }]);

  // Only what the studio publishes can be picked here; a made-up or hidden id is not found.
  const wanted = [input.packageId, ...(input.addonIds ?? [])].filter((x): x is string => Boolean(x));
  if (wanted.length) {
    const found = await prisma.catalogItem.findMany({ where: { id: { in: wanted }, organizationId: org.id, isActive: true, isPublic: true, deletedAt: null }, select: { id: true, kind: true } });
    const kinds = new Map(found.map((i) => [i.id, i.kind]));
    if (wanted.some((id) => !kinds.has(id)) || (input.packageId && kinds.get(input.packageId) !== 'PACKAGE') || (input.addonIds ?? []).some((id) => kinds.get(id) !== 'ADDON')) throw notFound('Package');
  }

  const wantsQuote = page.autoQuoteMode !== 'OFF' && Boolean(input.packageId);
  const eventDate = toDateOnly(input.eventDate);

  const result = await prisma.$transaction(async (tx) => {
    const source = await enquirySource(org.id);

    // One person enquiring twice is one lead: reuse the open lead for this phone number and date.
    const existingId = await openLeadIdByPhoneAndDate(tx, org.id, phone, eventDate);
    let lead = existingId ? await tx.lead.findUnique({ where: { id: existingId } }) : null;
    const note = [input.notes?.trim(), input.venueName ? `Venue: ${input.venueName.trim()}` : null].filter(Boolean).join('\n') || null;
    if (lead) {
      lead = await tx.lead.update({ where: { id: lead.id }, data: { name: input.name, email: input.email?.toLowerCase() ?? lead.email, eventType: input.eventType, guestCount: input.guestCount ?? lead.guestCount, venueCity: input.venueCity ?? lead.venueCity, interestedPackageId: input.packageId ?? lead.interestedPackageId, notes: note ? `${lead.notes ? `${lead.notes}\n---\n` : ''}${note}` : lead.notes } });
    } else {
      lead = await tx.lead.create({
        data: {
          organizationId: org.id, sourceId: source.id, name: input.name, phone, email: input.email?.toLowerCase() ?? null, eventType: input.eventType, eventDate, venueCity: input.venueCity ?? null,
          guestCount: input.guestCount ?? null, interestedPackageId: input.packageId ?? null, status: 'NEW', notes: note,
          customFields: { enquiry: { eventDays, addons: input.addonIds ?? [] } } as Prisma.InputJsonValue,
        },
      });
    }

    let quote: Awaited<ReturnType<typeof createQuoteRecord>> | null = null;
    if (wantsQuote) {
      // Same lead, same package and date, still open: hand back the quote that exists instead of piling up copies.
      const open = await tx.quotation.findFirst({
        where: { organizationId: org.id, leadId: lead.id, deletedAt: null, status: { in: ['DRAFT', 'SENT'] }, autoGenerated: true, eventDate },
        include: { items: { orderBy: { sortOrder: 'asc' } } }, orderBy: { createdAt: 'desc' },
      });
      const samePackage = open?.items.some((i) => i.kind === 'PACKAGE' && i.catalogItemId === input.packageId);
      if (open && samePackage) quote = open;
      else {
        const lines = await buildCatalogLines(tx, org.id, { packageId: input.packageId, addons: (input.addonIds ?? []).map((id) => ({ id })), eventType: input.eventType, ctx: { eventDays, guestCount: input.guestCount }, suggestRest: true });
        const auto = page.autoQuoteMode === 'AUTO';
        quote = await createQuoteRecord(tx, {
          organizationId: org.id, createdById: null, leadId: lead.id, clientId: lead.clientId, autoGenerated: true, needsReview: !auto, status: auto ? 'SENT' : 'DRAFT',
          header: { customerName: input.name, customerPhone: phone, customerEmail: input.email ?? null, eventType: input.eventType, eventDate: input.eventDate, eventDays, guestCount: input.guestCount ?? null, venueName: input.venueName ?? null, venueCity: input.venueCity ?? null },
          lines, actor: { type: 'CLIENT' },
        });
        if (auto) {
          await tx.quotation.update({ where: { id: quote.id }, data: { sentAt: new Date(), sentVia: 'AUTO' } });
          await logQuoteEvent(tx, org.id, quote.id, 'SENT', { type: 'SYSTEM' }, { channel: 'AUTO' });
          await tx.lead.update({ where: { id: lead.id }, data: { status: 'PROPOSAL_SENT', estimatedValue: quote.grandTotal } });
        } else {
          await tx.lead.update({ where: { id: lead.id }, data: { estimatedValue: quote.grandTotal } });
        }
      }
    }
    return { lead, quote };
  }, { timeout: 30_000 });

  const auto = page.autoQuoteMode === 'AUTO' && result.quote && result.quote.status === 'SENT';
  const note = result.quote
    ? (auto ? 'A quotation was sent to them automatically.' : 'A draft quotation is waiting for your review.')
    : 'No quotation was generated (no package chosen).';
  void notifyStaff(org.id, {
    title: `New enquiry: ${input.name}`, message: `${input.eventType.replace(/_/g, ' ').toLowerCase()} on ${ymd(eventDate)}. ${note}`,
    entityType: result.quote ? 'Quotation' : 'Lead', entityId: result.quote?.id ?? result.lead.id,
  }, {
    userIds: [result.lead.ownerId], permissions: ['LEAD_UPDATE', 'QUOTATION_UPDATE'],
    email: (to) => newEnquiryStaffEmail({ to, name: input.name, phone, eventType: input.eventType, eventDate, quoteNote: note, link: `${env.APP_URL.replace(/\/$/, '')}/${result.quote ? 'quotes' : 'leads'}` }),
  });

  return {
    received: true,
    message: page.thankYouMessage ?? 'Thank you! We have your enquiry and will be in touch very soon.',
    quoteToken: auto ? result.quote!.publicToken : null,
  };
}

