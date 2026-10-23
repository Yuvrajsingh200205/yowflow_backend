import { z } from 'zod';
import { dateOnly, uuid } from './common.validator';

const EVENT_TYPES = ['ROKA', 'ENGAGEMENT', 'PRE_WEDDING', 'WEDDING', 'COMPLETE_WEDDING_SERVICES', 'HALDI_MEHENDI', 'SANGEET', 'RECEPTION', 'ANNIVERSARY', 'CORPORATE', 'OTHER'] as const;
export const eventTypeEnum = z.enum(EVENT_TYPES);

const money = z.coerce.number().min(0).max(100_000_000).transform((n) => Math.round(n * 100) / 100);
const pct = z.coerce.number().min(0).max(100).transform((n) => Math.round(n * 100) / 100);
const text = (max: number) => z.string().trim().max(max);

// ── Catalogue ────────────────────────────────────────────────────────────────
const catalogShape = {
  kind: z.enum(['PACKAGE', 'ADDON']),
  name: text(160).min(2, 'Give it a name'),
  description: text(2000).nullable().optional(),
  category: text(60).nullable().optional(),
  inclusions: z.array(text(200).min(1)).max(30).optional(),
  pricingType: z.enum(['FIXED', 'PER_DAY', 'PER_PERSON']).default('FIXED'),
  unitPrice: money,
  unitLabel: text(30).nullable().optional(),
  taxRate: pct.default(0),
  allowQuantity: z.boolean().default(false),
  minQuantity: z.coerce.number().int().min(1).max(100_000).default(1),
  maxQuantity: z.coerce.number().int().min(1).max(100_000).nullable().optional(),
  eventTypes: z.array(eventTypeEnum).max(11).optional(),
  isActive: z.boolean().default(true),
  isPublic: z.boolean().default(true),
  isPopular: z.boolean().default(false),
  sortOrder: z.coerce.number().int().min(0).max(100_000).default(0),
};
const catalogRules = (v: { maxQuantity?: number | null; minQuantity?: number; allowQuantity?: boolean; pricingType?: string; kind?: string }, ctx: z.RefinementCtx) => {
  if (v.maxQuantity != null && v.minQuantity != null && v.maxQuantity < v.minQuantity) ctx.addIssue({ code: 'custom', path: ['maxQuantity'], message: 'The maximum cannot be below the minimum' });
  if (v.allowQuantity && v.pricingType && v.pricingType !== 'FIXED') ctx.addIssue({ code: 'custom', path: ['allowQuantity'], message: 'Only fixed-price items can have a chosen quantity' });
  if (v.allowQuantity && v.kind === 'PACKAGE') ctx.addIssue({ code: 'custom', path: ['allowQuantity'], message: 'A package is sold once; use an add-on for items with a quantity' });
};
export const catalogCreateSchema = z.object(catalogShape).superRefine(catalogRules);
export const catalogUpdateSchema = z.object(catalogShape).partial().superRefine(catalogRules);
export const catalogListQuery = z.object({
  kind: z.enum(['PACKAGE', 'ADDON']).optional(),
  active: z.enum(['true', 'false']).optional(),
  search: text(120).optional(),
});

// ── Business details, sales defaults, availability, reminders ───────────────
const upi = z.string().trim().regex(/^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/, 'Enter a UPI ID like name@bank');
const ifsc = z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC looks like HDFC0001234');
const gstin = z.string().trim().toUpperCase().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Enter a valid 15-character GSTIN');
const empty = z.literal('').transform(() => null);

export const salesSettingsSchema = z.object({
  // printed on quotes and invoices
  upiId: z.union([upi, empty]).nullable().optional(),
  bankAccountName: z.union([text(160), empty]).nullable().optional(),
  bankName: z.union([text(120), empty]).nullable().optional(),
  bankAccountNumber: z.union([z.string().trim().regex(/^\d{6,34}$/, 'Digits only'), empty]).nullable().optional(),
  bankIfsc: z.union([ifsc, empty]).nullable().optional(),
  defaultTerms: z.union([text(6000), empty]).nullable().optional(),
  brandColor: z.union([z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #B4F03C'), empty]).nullable().optional(),
  gstNumber: z.union([gstin, empty]).nullable().optional(),
  // sales defaults
  quoteValidDays: z.coerce.number().int().min(1).max(365).optional(),
  advancePercent: z.coerce.number().int().min(0).max(100).optional(),
  balanceDueDaysBefore: z.coerce.number().int().min(0).max(365).optional(),
  // availability
  capacityPerDay: z.coerce.number().int().min(1).max(50).optional(),
  minLeadDays: z.coerce.number().int().min(0).max(365).optional(),
  maxAdvanceDays: z.coerce.number().int().min(30).max(1825).optional(),
  // reminders
  remindersEnabled: z.boolean().optional(),
  remindersEmailClients: z.boolean().optional(),
}).strict();

export const enquiryPageSchema = z.object({
  isEnabled: z.boolean().optional(),
  headline: z.union([text(160), empty]).nullable().optional(),
  intro: z.union([text(2000), empty]).nullable().optional(),
  thankYouMessage: z.union([text(1000), empty]).nullable().optional(),
  autoQuoteMode: z.enum(['OFF', 'APPROVAL', 'AUTO']).optional(),
  showPrices: z.boolean().optional(),
  askGuestCount: z.boolean().optional(),
  askVenue: z.boolean().optional(),
  eventTypes: z.array(eventTypeEnum).max(11).optional(),
}).strict();

export const blockedDateSchema = z.object({
  startDate: dateOnly,
  endDate: dateOnly,
  reason: z.union([text(200), empty]).nullable().optional(),
}).strict().refine((v) => v.endDate >= v.startDate, { path: ['endDate'], message: 'The end date cannot be before the start date' });

export const rangeQuery = z.object({ from: dateOnly, to: dateOnly });
export const rangeQueryOptional = z.object({ from: dateOnly.optional(), to: dateOnly.optional() });
export const checkQuery = z.object({ date: dateOnly, excludeProjectId: uuid.optional() });
export const idParamOnly = z.object({ id: uuid });

// ── Quotes ──────────────────────────────────────────────────────────────────
const qty = z.coerce.number().positive().max(1_000_000).transform((n) => Math.round(n * 100) / 100);
export const quoteLineSchema = z.object({
  service: text(200).min(1, 'Name the item'),
  description: text(2000).nullable().optional(),
  inclusions: z.array(text(200).min(1)).max(30).optional(),
  kind: z.enum(['PACKAGE', 'ADDON', 'CUSTOM']).default('CUSTOM'),
  catalogItemId: uuid.nullable().optional(),
  isOptional: z.boolean().optional(),
  isSelected: z.boolean().optional(),
  pricingType: z.enum(['FIXED', 'PER_DAY', 'PER_PERSON']).optional(),
  unitLabel: text(30).nullable().optional(),
  allowQuantity: z.boolean().optional(),
  minQuantity: z.coerce.number().int().min(1).max(100_000).optional(),
  maxQuantity: z.coerce.number().int().min(1).max(100_000).nullable().optional(),
  quantity: qty,
  unitPrice: money,
  discountAmount: money.optional(),
  taxRate: pct.optional(),
});

const header = {
  customerName: text(160).min(1).nullable().optional(),
  customerPhone: text(32).nullable().optional(),
  customerEmail: z.union([z.string().trim().toLowerCase().email().max(160), z.literal('').transform(() => null)]).nullable().optional(),
  eventType: eventTypeEnum.nullable().optional(),
  eventDate: dateOnly.nullable().optional(),
  eventDays: z.coerce.number().int().min(1).max(60).optional(),
  guestCount: z.coerce.number().int().min(1).max(100_000).nullable().optional(),
  venueName: text(200).nullable().optional(),
  venueCity: text(80).nullable().optional(),
  advancePercent: z.coerce.number().int().min(0).max(100).nullable().optional(),
  balanceDueDaysBefore: z.coerce.number().int().min(0).max(365).nullable().optional(),
  notes: text(5000).nullable().optional(),
  termsAndConditions: text(10000).nullable().optional(),
  validUntil: dateOnly.nullable().optional(),
};

export const quoteFromLeadSchema = z.object({
  leadId: uuid,
  packageId: uuid.nullable().optional(),
  addons: z.array(z.object({ id: uuid, quantity: z.coerce.number().int().min(1).max(1000).optional() })).max(30).optional(),
  customLines: z.array(quoteLineSchema).max(50).optional(),
  eventDate: dateOnly.nullable().optional(),
  eventDays: z.coerce.number().int().min(1).max(60).optional(),
  guestCount: z.coerce.number().int().min(1).max(100_000).nullable().optional(),
  venueName: text(200).nullable().optional(),
  venueCity: text(80).nullable().optional(),
  discountAmount: money.optional(),
  notes: text(5000).nullable().optional(),
  termsAndConditions: text(10000).nullable().optional(),
  validDays: z.coerce.number().int().min(1).max(365).optional(),
  advancePercent: z.coerce.number().int().min(0).max(100).optional(),
}).strict().refine((v) => v.packageId || v.customLines?.length || v.addons?.length, { message: 'Choose a package or add at least one line', path: ['packageId'] });

export const quoteUpdateSchema = z.object({ ...header, items: z.array(quoteLineSchema).min(1).max(80).optional(), discountAmount: money.optional() }).strict();
export const quoteSendSchema = z.object({ channel: z.enum(['EMAIL', 'LINK', 'WHATSAPP']) }).strict();
export const quoteConvertSchema = z.object({ overrideAvailability: z.boolean().optional() }).strict();

// ── Public (anonymous) ──────────────────────────────────────────────────────
export const slugParam = z.object({ slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,80}$/) });
export const tokenParam = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{20,64}$/) });
export const publicRangeQuery = z.object({ from: dateOnly, to: dateOnly });

/** Accepts the ways Indians write a mobile number and reduces them to the 10 digits. */
export const mobile = z.string().trim().max(24).transform((v) => {
  const d = v.replace(/\D/g, '');
  return d.length === 12 && d.startsWith('91') ? d.slice(2) : d.length === 11 && d.startsWith('0') ? d.slice(1) : d;
}).refine((d) => /^[6-9]\d{9}$/.test(d), 'Enter a valid 10-digit mobile number');

export const publicEnquirySchema = z.object({
  name: text(160).min(2, 'Enter your name'),
  phone: mobile,
  email: z.union([z.string().trim().toLowerCase().email('Enter a valid email').max(160), z.literal('').transform(() => null)]).nullable().optional(),
  eventType: eventTypeEnum,
  eventDate: dateOnly,
  eventDays: z.coerce.number().int().min(1).max(14).optional(),
  guestCount: z.coerce.number().int().min(1).max(100_000).nullable().optional(),
  venueName: text(200).nullable().optional(),
  venueCity: text(80).nullable().optional(),
  packageId: uuid.nullable().optional(),
  addonIds: z.array(uuid).max(20).optional(),
  notes: text(1000).nullable().optional(),
  consent: z.literal(true, { errorMap: () => ({ message: 'Please agree to be contacted' }) }),
  /** Honeypot: real visitors never see or fill this. */
  website: z.string().max(200).optional(),
}).strict();

const selectionItem = z.object({ itemId: uuid, selected: z.boolean().optional(), quantity: z.coerce.number().int().min(1).max(100_000).optional() });
export const publicSelectionSchema = z.object({ selection: z.array(selectionItem).max(80) }).strict();
export const publicAcceptSchema = z.object({ name: text(160).min(2, 'Type your full name to accept'), selection: z.array(selectionItem).max(80).optional(), agree: z.literal(true, { errorMap: () => ({ message: 'Please confirm you agree to the quotation and its terms' }) }) }).strict();
export const publicDeclineSchema = z.object({ reason: text(500).nullable().optional() }).strict();
export const publicMessageSchema = z.object({ message: text(1000).min(3, 'Write your question'), name: text(160).nullable().optional(), phone: text(32).nullable().optional() }).strict();
