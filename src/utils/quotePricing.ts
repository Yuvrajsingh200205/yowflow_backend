import { Prisma } from '@prisma/client';
import { computeDocumentTotals, computeLine, money, round2 } from './money';

/**
 * Quote arithmetic in one place so the staff builder, the public quote page, the PDF and the booking
 * all reach the same total. Everything here is pure.
 */

export type PricingType = 'FIXED' | 'PER_DAY' | 'PER_PERSON';

export interface PriceableItem {
  pricingType: PricingType;
  unitPrice: Prisma.Decimal.Value;
  taxRate: Prisma.Decimal.Value;
  allowQuantity: boolean;
  minQuantity: number;
  maxQuantity: number | null;
}

export interface PricingContext {
  eventDays: number;
  guestCount?: number | null;
}

const clamp = (n: number, lo: number, hi: number | null) => Math.min(Math.max(n, lo), hi ?? Number.MAX_SAFE_INTEGER);

/** How many units a line is charged for, given what the customer told us about the event. */
export function quantityFor(item: PriceableItem, ctx: PricingContext, requested?: number): number {
  switch (item.pricingType) {
    case 'PER_DAY':
      return Math.max(1, Math.floor(ctx.eventDays) || 1);
    case 'PER_PERSON': {
      // A guest count is the customer's estimate; a catalogue minimum (for example 100 plates) always applies.
      const guests = Math.max(0, Math.floor(ctx.guestCount ?? 0));
      return Math.max(item.minQuantity, guests || item.minQuantity);
    }
    default: {
      if (!item.allowQuantity) return 1;
      const wanted = Number.isFinite(requested) ? Math.floor(requested as number) : item.minQuantity;
      return clamp(wanted, item.minQuantity, item.maxQuantity);
    }
  }
}

export interface LineLike {
  quantity: Prisma.Decimal.Value;
  unitPrice: Prisma.Decimal.Value;
  discountAmount?: Prisma.Decimal.Value;
  taxRate?: Prisma.Decimal.Value;
  isSelected?: boolean;
}

/** Totals over the lines the customer has switched on (optional add-ons that are off cost nothing). */
export function totalsFor(lines: LineLike[], documentDiscount: Prisma.Decimal.Value = 0) {
  const computed = lines.filter((l) => l.isSelected !== false).map((l) => computeLine(l));
  return computeDocumentTotals(computed, documentDiscount);
}

export interface PaymentStep { title: string; amount: Prisma.Decimal; dueDate: Date }

const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/**
 * Advance on acceptance, balance shortly before the event. A 100% advance, a very near event or a missing
 * date collapse into sensible single payments instead of producing a due date in the past.
 */
export function paymentPlan(total: Prisma.Decimal.Value, advancePercent: number, balanceDueDaysBefore: number, eventDate: Date | null, today: Date): PaymentStep[] {
  const grand = round2(money(total));
  const day0 = startOfUtcDay(today);
  const pct = Math.min(100, Math.max(0, Math.round(advancePercent)));
  const advance = pct >= 100 ? grand : round2(grand.times(pct).dividedBy(100));
  const balance = round2(grand.minus(advance));
  const steps: PaymentStep[] = [];
  if (advance.gt(0)) steps.push({ title: 'Advance', amount: advance, dueDate: day0 });
  if (balance.gt(0)) {
    const due = eventDate ? addDays(startOfUtcDay(eventDate), -Math.max(0, balanceDueDaysBefore)) : addDays(day0, 30);
    steps.push({ title: 'Balance', amount: balance, dueDate: due.getTime() < day0.getTime() ? day0 : due });
  }
  if (steps.length === 0) steps.push({ title: 'Payment', amount: grand, dueDate: day0 });
  return steps;
}

export const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Today's calendar date in an IANA time zone, as `YYYY-MM-DD`. */
export function todayIn(timezone: string, now = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    return parts;
  } catch {
    return ymd(now);
  }
}
