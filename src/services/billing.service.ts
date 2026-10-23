import crypto from 'crypto';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { brand } from '../config/brand';
import { AuthContext } from '../types';
import { badRequest, conflict, internal, serviceUnavailable } from '../utils/errors';
import { AuditRequestContext, recordAudit } from './audit.service';

/** Monthly prices in rupees. Keep in sync with the marketing pricing page. Yearly = 10 months. */
export const PLAN_CATALOG = {
  starter: { name: 'Starter', monthly: 1499, seats: 2 },
  studio: { name: 'Studio', monthly: 3999, seats: 10 },
  scale: { name: 'Scale', monthly: 8999, seats: null },
} as const;
export type PlanId = keyof typeof PLAN_CATALOG;
export type Interval = 'monthly' | 'yearly';
export const YEARLY_MONTHS_CHARGED = 10;

export const priceFor = (plan: PlanId, interval: Interval) =>
  PLAN_CATALOG[plan].monthly * (interval === 'yearly' ? YEARLY_MONTHS_CHARGED : 1);

interface BillingState {
  plan?: PlanId;
  status?: 'trialing' | 'active' | 'past_due' | 'canceled';
  interval?: Interval;
  currentPeriodEnd?: string;
  pendingOrder?: { orderId: string; plan: PlanId; interval: Interval; amount: number };
  lastPaymentId?: string;
}
type OrgSettings = { plan?: string; trialEndsAt?: string; billing?: BillingState } & Record<string, unknown>;

export const isConfigured = () => Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
export const mode = () => (env.RAZORPAY_KEY_ID?.startsWith('rzp_live_') ? 'live' : 'test');

async function readSettings(organizationId: string): Promise<OrgSettings> {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { settings: true } });
  return (org.settings ?? {}) as OrgSettings;
}
const writeSettings = (organizationId: string, settings: OrgSettings) =>
  prisma.organization.update({ where: { id: organizationId }, data: { settings: settings as never } });

export async function getBilling(auth: AuthContext) {
  const settings = await readSettings(auth.organizationId);
  const billing = settings.billing ?? {};
  const trialEndsAt = settings.trialEndsAt ?? null;
  const trialDaysLeft = trialEndsAt ? Math.max(0, Math.ceil((new Date(trialEndsAt).getTime() - Date.now()) / 86_400_000)) : null;
  const seatsUsed = await prisma.user.count({ where: { organizationId: auth.organizationId, deletedAt: null, status: 'ACTIVE' } });
  // A workspace provisioned by an administrator (no trial, no subscription record) is treated as active.
  const status = billing.status === 'active' || (!billing.status && !trialEndsAt)
    ? 'active'
    : trialEndsAt && !billing.status && new Date(trialEndsAt) < new Date() ? 'trial_expired' : (billing.status ?? 'trialing');
  return {
    configured: isConfigured(),
    mode: isConfigured() ? mode() : null,
    status,
    plan: billing.plan ?? (settings.plan as PlanId | undefined) ?? 'studio',
    interval: billing.interval ?? null,
    currentPeriodEnd: billing.currentPeriodEnd ?? null,
    trialEndsAt,
    trialDaysLeft,
    seatsUsed,
    plans: (Object.keys(PLAN_CATALOG) as PlanId[]).map((id) => ({ id, name: PLAN_CATALOG[id].name, monthly: PLAN_CATALOG[id].monthly, yearly: priceFor(id, 'yearly'), seats: PLAN_CATALOG[id].seats })),
  };
}

export async function razorpay<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw internal('The payment provider rejected the request');
  return (await res.json()) as T;
}

export async function createCheckout(auth: AuthContext, input: { plan: PlanId; interval: Interval }) {
  if (!isConfigured()) throw serviceUnavailable('Online payments are not enabled for this deployment yet.');
  const amount = priceFor(input.plan, input.interval) * 100; // paise
  const order = await razorpay<{ id: string; amount: number; currency: string }>('/orders', {
    amount,
    currency: 'INR',
    receipt: `${auth.organizationId.slice(0, 8)}-${Date.now()}`.slice(0, 40),
    notes: { organizationId: auth.organizationId, plan: input.plan, interval: input.interval, product: brand.name },
  });
  const settings = await readSettings(auth.organizationId);
  settings.billing = { ...(settings.billing ?? {}), pendingOrder: { orderId: order.id, plan: input.plan, interval: input.interval, amount } };
  await writeSettings(auth.organizationId, settings);
  return { orderId: order.id, amount: order.amount, currency: order.currency, keyId: env.RAZORPAY_KEY_ID, mode: mode(), name: brand.name, description: `${PLAN_CATALOG[input.plan].name} · ${input.interval}` };
}

export const signaturesMatch = (orderId: string, paymentId: string, signature: string, secret: string) => {
  const expected = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
  const a = Buffer.from(expected); const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

export async function verifyPayment(auth: AuthContext, input: { orderId: string; paymentId: string; signature: string }, ctx: AuditRequestContext) {
  if (!isConfigured()) throw serviceUnavailable('Online payments are not enabled for this deployment yet.');
  const settings = await readSettings(auth.organizationId);
  const pending = settings.billing?.pendingOrder;
  if (!pending || pending.orderId !== input.orderId) throw conflict('No matching checkout is pending for this workspace');
  if (!signaturesMatch(input.orderId, input.paymentId, input.signature, env.RAZORPAY_KEY_SECRET as string)) {
    throw badRequest('Payment signature could not be verified');
  }
  const end = new Date();
  if (pending.interval === 'yearly') end.setFullYear(end.getFullYear() + 1); else end.setMonth(end.getMonth() + 1);
  settings.billing = { status: 'active', plan: pending.plan, interval: pending.interval, currentPeriodEnd: end.toISOString(), lastPaymentId: input.paymentId };
  settings.plan = pending.plan;
  await prisma.$transaction(async (tx) => {
    await tx.organization.update({ where: { id: auth.organizationId }, data: { settings: settings as never } });
    await recordAudit(tx, ctx, { action: 'UPDATE', entityType: 'Billing', entityId: auth.organizationId, summary: `Subscribed to ${PLAN_CATALOG[pending.plan].name} (${pending.interval}); payment ${input.paymentId}` });
  });
  return getBilling(auth);
}
