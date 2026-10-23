import { prisma } from '../config/prisma';
import { badRequest } from '../utils/errors';
import { todayIn, ymd } from '../utils/quotePricing';

/**
 * Which dates the studio can still sell. A date is taken when the number of live bookings on it reaches the
 * studio's daily capacity, and closed when the studio blocked it. "Live" means a project that is not cancelled
 * and not just a lead; a project occupies every date that carries one of its events (and its wedding date).
 */

export type DayStatus = 'AVAILABLE' | 'LIMITED' | 'FULL' | 'CLOSED' | 'PAST' | 'TOO_SOON' | 'TOO_FAR';

export interface AvailabilitySettings { capacityPerDay: number; minLeadDays: number; maxAdvanceDays: number; timezone: string }

export interface DayInfo {
  date: string;
  status: DayStatus;
  booked: number;
  capacity: number;
  /** Staff only. */
  bookings?: Array<{ projectId: string; projectNumber: string; name: string }>;
  closedReason?: string | null;
}

const NON_OCCUPYING = ['CANCELLED', 'LEAD'] as const;
const MAX_RANGE_DAYS = 400;
const DAY_MS = 86_400_000;

const parse = (value: string) => {
  const d = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(d.getTime())) throw badRequest('Use dates in YYYY-MM-DD format');
  return d;
};

export async function getAvailabilitySettings(organizationId: string): Promise<AvailabilitySettings> {
  const [org, setting] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timezone: true } }),
    prisma.organizationSetting.findUnique({ where: { organizationId }, select: { capacityPerDay: true, minLeadDays: true, maxAdvanceDays: true } }),
  ]);
  return { capacityPerDay: setting?.capacityPerDay ?? 1, minLeadDays: setting?.minLeadDays ?? 0, maxAdvanceDays: setting?.maxAdvanceDays ?? 730, timezone: org.timezone };
}

export async function dayStatuses(
  organizationId: string,
  from: string,
  to: string,
  opts: { details?: boolean; excludeProjectId?: string; now?: Date } = {},
): Promise<{ settings: AvailabilitySettings; days: DayInfo[] }> {
  const start = parse(from);
  const end = parse(to);
  if (end < start) throw badRequest('The end date cannot be before the start date');
  if ((end.getTime() - start.getTime()) / DAY_MS > MAX_RANGE_DAYS) throw badRequest(`Ask for at most ${MAX_RANGE_DAYS} days at a time`);

  const settings = await getAvailabilitySettings(organizationId);
  const projectWhere = {
    deletedAt: null,
    status: { notIn: [...NON_OCCUPYING] },
    ...(opts.excludeProjectId ? { id: { not: opts.excludeProjectId } } : {}),
  };
  const [events, weddings, blocks] = await Promise.all([
    prisma.event.findMany({
      where: { organizationId, deletedAt: null, eventDate: { gte: start, lte: end }, project: projectWhere },
      select: { eventDate: true, project: { select: { id: true, name: true, projectNumber: true } } },
    }),
    prisma.project.findMany({
      where: { organizationId, ...projectWhere, weddingDate: { gte: start, lte: end } },
      select: { id: true, name: true, projectNumber: true, weddingDate: true },
    }),
    prisma.blockedDate.findMany({ where: { organizationId, startDate: { lte: end }, endDate: { gte: start } }, select: { startDate: true, endDate: true, reason: true } }),
  ]);

  const byDay = new Map<string, Map<string, { projectId: string; projectNumber: string; name: string }>>();
  const occupy = (date: Date, p: { id: string; name: string; projectNumber: string }) => {
    const key = ymd(date);
    const set = byDay.get(key) ?? new Map();
    set.set(p.id, { projectId: p.id, projectNumber: p.projectNumber, name: p.name });
    byDay.set(key, set);
  };
  for (const e of events) occupy(e.eventDate, e.project);
  for (const w of weddings) if (w.weddingDate) occupy(w.weddingDate, w);

  const today = parse(todayIn(settings.timezone, opts.now));
  const earliest = today.getTime() + settings.minLeadDays * DAY_MS;
  const latest = today.getTime() + settings.maxAdvanceDays * DAY_MS;

  const days: DayInfo[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) {
    const date = new Date(t);
    const key = ymd(date);
    const booked = byDay.get(key)?.size ?? 0;
    const block = blocks.find((b) => b.startDate.getTime() <= t && b.endDate.getTime() >= t);
    let status: DayStatus;
    if (t < today.getTime()) status = 'PAST';
    else if (block) status = 'CLOSED';
    else if (booked >= settings.capacityPerDay) status = 'FULL';
    else if (t < earliest) status = 'TOO_SOON';
    else if (t > latest) status = 'TOO_FAR';
    else status = booked > 0 ? 'LIMITED' : 'AVAILABLE';
    days.push({
      date: key, status, booked, capacity: settings.capacityPerDay,
      ...(opts.details ? { bookings: [...(byDay.get(key)?.values() ?? [])], closedReason: block?.reason ?? null } : {}),
    });
  }
  return { settings, days };
}

export const isSellable = (status: DayStatus) => status === 'AVAILABLE' || status === 'LIMITED';

export async function checkDate(organizationId: string, date: string, opts: { excludeProjectId?: string; now?: Date } = {}): Promise<DayInfo> {
  const { days } = await dayStatuses(organizationId, date, date, opts);
  return days[0];
}

const REASONS: Record<DayStatus, string> = {
  AVAILABLE: 'Available',
  LIMITED: 'Available',
  FULL: 'This date is already fully booked.',
  CLOSED: 'The studio is not taking bookings on this date.',
  PAST: 'This date has already passed.',
  TOO_SOON: 'This date is too close to book online. Please call the studio.',
  TOO_FAR: 'This date is too far ahead to book online yet.',
};
export const reasonFor = (status: DayStatus) => REASONS[status];
