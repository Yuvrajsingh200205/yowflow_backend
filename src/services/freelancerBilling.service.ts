import { FreelancerSubscriptionStatus } from '@prisma/client';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { brand } from '../config/brand';
import { badRequest, conflict, notFound, serviceUnavailable } from '../utils/errors';
import { AuditRequestContext, recordAudit } from './audit.service';
import { isConfigured, mode, razorpay, signaturesMatch } from './billing.service';

/**
 * A freelancer buying a listing plan. Paid plans go through Razorpay (order → hosted
 * checkout → signature-verified activation); free plans activate immediately.
 * The plan row is the single source of truth for the price, never the client.
 */

const periodEnd = (interval: string, from = new Date()) => {
  const end = new Date(from);
  if (interval === 'YEARLY') end.setFullYear(end.getFullYear() + 1);
  else if (interval === 'QUARTERLY') end.setMonth(end.getMonth() + 3);
  else if (interval === 'ONE_TIME') end.setFullYear(end.getFullYear() + 100);
  else end.setMonth(end.getMonth() + 1);
  return end;
};

const DEFAULT_PLANS = [
  { slug: 'listed-monthly', name: 'Listed — Monthly', description: 'Be found by studios: your profile, portfolio and availability appear in vendor search.', price: 499, billingInterval: 'MONTHLY' as const },
  { slug: 'listed-yearly', name: 'Listed — Yearly', description: 'Everything in Monthly, two months free.', price: 4990, billingInterval: 'YEARLY' as const },
];

/** First use in a studio: give its freelancers something to buy. Studios can edit or deactivate these afterwards. */
export async function ensureDefaultPlans(organizationId: string) {
  const any = await prisma.freelancerPlan.count({ where: { organizationId } });
  if (any > 0) return;
  await prisma.freelancerPlan.createMany({ data: DEFAULT_PLANS.map((p) => ({ organizationId, ...p, currency: 'INR' })), skipDuplicates: true });
}

async function activate(freelancerId: string, subscriptionId: string, interval: string, paymentId: string | null, ctx: AuditRequestContext, organizationId: string) {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    // One live plan at a time: switching plans retires the previous one.
    await tx.freelancerSubscription.updateMany({
      where: { freelancerId, id: { not: subscriptionId }, status: { in: ['ACTIVE', 'PAST_DUE'] as FreelancerSubscriptionStatus[] } },
      data: { status: 'CANCELED', canceledAt: now },
    });
    await tx.freelancerSubscription.update({
      where: { id: subscriptionId },
      data: { status: 'ACTIVE', startedAt: now, currentPeriodStart: now, currentPeriodEnd: periodEnd(interval, now), metadata: paymentId ? { paymentId } : undefined },
    });
    await recordAudit(tx, { ...ctx, organizationId }, { action: 'UPDATE', entityType: 'FreelancerSubscription', entityId: subscriptionId, summary: paymentId ? `Freelancer subscription activated; payment ${paymentId}` : 'Free freelancer plan activated' });
  });
}

export async function startCheckout(organizationId: string, freelancerId: string, planId: string, ctx: AuditRequestContext) {
  const [plan, freelancer] = await Promise.all([
    prisma.freelancerPlan.findFirst({ where: { id: planId, organizationId, isActive: true } }),
    prisma.freelancer.findFirst({ where: { id: freelancerId, organizationId, deletedAt: null }, select: { id: true, fullName: true } }),
  ]);
  if (!plan || !freelancer) throw notFound('Freelancer plan');
  const price = Number(plan.price);

  // Drop an abandoned earlier attempt so retries never pile up.
  await prisma.freelancerSubscription.deleteMany({ where: { freelancerId, status: 'PENDING' } });
  const sub = await prisma.freelancerSubscription.create({ data: { freelancerId, planId: plan.id, status: 'PENDING' } });

  if (price <= 0) {
    await activate(freelancerId, sub.id, plan.billingInterval, null, ctx, organizationId);
    return { activated: true as const };
  }
  if (!isConfigured()) {
    await prisma.freelancerSubscription.delete({ where: { id: sub.id } });
    throw serviceUnavailable('Online payments are not enabled for this deployment yet.');
  }
  const amount = Math.round(price * 100);
  const order = await razorpay<{ id: string; amount: number; currency: string }>('/orders', {
    amount, currency: plan.currency || 'INR', receipt: `fl-${sub.id.slice(0, 8)}-${Date.now()}`.slice(0, 40),
    notes: { organizationId, freelancerId, planId: plan.id, product: brand.name },
  });
  await prisma.freelancerSubscription.update({ where: { id: sub.id }, data: { externalSubscriptionId: order.id, metadata: { amount } } });
  return { activated: false as const, orderId: order.id, amount: order.amount, currency: order.currency, keyId: env.RAZORPAY_KEY_ID, mode: mode(), name: brand.name, description: plan.name };
}

export async function verifyCheckout(organizationId: string, freelancerId: string, input: { orderId: string; paymentId: string; signature: string }, ctx: AuditRequestContext) {
  if (!isConfigured()) throw serviceUnavailable('Online payments are not enabled for this deployment yet.');
  const sub = await prisma.freelancerSubscription.findFirst({
    where: { freelancerId, externalSubscriptionId: input.orderId, freelancer: { organizationId } },
    include: { plan: true },
  });
  if (!sub) throw conflict('No matching checkout is pending for this account');
  if (sub.status === 'ACTIVE') return { activated: true }; // already confirmed (page refreshed, webhook, double click)
  if (sub.status !== 'PENDING') throw conflict('This checkout is no longer valid');
  if (!signaturesMatch(input.orderId, input.paymentId, input.signature, env.RAZORPAY_KEY_SECRET as string)) throw badRequest('Payment signature could not be verified');
  await activate(freelancerId, sub.id, sub.plan.billingInterval, input.paymentId, ctx, organizationId);
  return { activated: true };
}

export async function cancelSubscription(organizationId: string, freelancerId: string, ctx: AuditRequestContext) {
  const live = await prisma.freelancerSubscription.findFirst({ where: { freelancerId, status: { in: ['ACTIVE', 'PAST_DUE'] }, freelancer: { organizationId } } });
  if (!live) throw notFound('Active subscription');
  await prisma.freelancerSubscription.update({ where: { id: live.id }, data: { status: 'CANCELED', canceledAt: new Date() } });
  await recordAudit(prisma, { ...ctx, organizationId }, { action: 'UPDATE', entityType: 'FreelancerSubscription', entityId: live.id, summary: 'Freelancer cancelled their plan' });
  return { canceled: true };
}
