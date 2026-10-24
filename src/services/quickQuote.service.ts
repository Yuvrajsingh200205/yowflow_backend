import { ProjectType } from '@prisma/client';
import { prisma } from '../config/prisma';
import { AuthContext } from '../types';
import { forbidden } from '../utils/errors';
import { toDateOnly } from '../utils/date';
import { lastTen, openLeadIdByPhoneAndDate } from '../utils/phoneMatch';
import { AuditRequestContext, recordAudit } from './audit.service';
import { createQuoteForLead } from './quoteEngine.service';

/**
 * "Quick quote": the few things a studio knows at the moment someone calls or walks in (name, mobile, occasion,
 * a package) become a lead and a priced quotation in one step, ready to share.
 */

const SOURCE = 'Quick quote';

export interface QuickQuoteInput {
  name: string;
  phone: string;
  email?: string | null;
  eventType?: ProjectType | null;
  eventDate?: string | null;
  eventDays?: number;
  guestCount?: number | null;
  venueCity?: string | null;
  packageId?: string | null;
  addonIds?: string[];
  custom?: { service: string; unitPrice: number; taxRate?: number };
}

async function quickSource(organizationId: string) {
  const key = { organizationId_name: { organizationId, name: SOURCE } };
  const existing = await prisma.leadSource.findUnique({ where: key });
  if (existing) return existing;
  try {
    return await prisma.leadSource.create({ data: { organizationId, name: SOURCE, description: 'Quotes made straight from the Quotes screen' } });
  } catch {
    return prisma.leadSource.findUniqueOrThrow({ where: key }); // someone created it a moment ago
  }
}

export async function createQuickQuote(auth: AuthContext, input: QuickQuoteInput, ctx: AuditRequestContext) {
  if (!auth.permissions.has('LEAD_CREATE')) throw forbidden('Making a quote for a new customer needs the LEAD_CREATE permission.');
  const phone = lastTen(input.phone);
  const eventDate = input.eventDate ? toDateOnly(input.eventDate) : null;

  // The same person and date is the same lead: a second quote for them, not a second lead.
  const existingId = eventDate ? await openLeadIdByPhoneAndDate(prisma, auth.organizationId, phone, eventDate) : null;
  let leadId = existingId;
  if (!leadId) {
    const source = await quickSource(auth.organizationId);
    const lead = await prisma.lead.create({
      data: {
        organizationId: auth.organizationId, sourceId: source.id, name: input.name.trim(), phone, email: input.email?.toLowerCase() ?? null, eventType: input.eventType ?? null,
        eventDate, venueCity: input.venueCity ?? null, guestCount: input.guestCount ?? null, status: 'NEW', ownerId: auth.userId, createdById: auth.userId,
      },
    });
    leadId = lead.id;
    await recordAudit(prisma, ctx, { action: 'CREATE', entityType: 'Lead', entityId: lead.id, summary: `Lead ${lead.name} created from a quick quote` });
  }

  const quote = await createQuoteForLead(auth, {
    leadId, packageId: input.packageId ?? null, addons: input.packageId ? (input.addonIds ?? []).map((id) => ({ id })) : [], eventDate: input.eventDate ?? null,
    customLines: input.custom ? [{ service: input.custom.service.trim(), kind: 'CUSTOM', quantity: 1, unitPrice: input.custom.unitPrice, taxRate: input.custom.taxRate ?? 0 }] : undefined,
    eventDays: input.eventDays, guestCount: input.guestCount ?? null, venueCity: input.venueCity ?? null,
  }, ctx);
  return { id: quote.id, quotationNumber: quote.quotationNumber, grandTotal: Number(quote.grandTotal), status: quote.status, leadId, reusedLead: Boolean(existingId) };
}
