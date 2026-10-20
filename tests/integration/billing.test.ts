import crypto from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, authed, base, login } from '../helpers/api';
import { prisma, resetDatabase, seedTestOrganization } from '../helpers/factory';
import { env } from '../../src/config/env';
import { outbox } from '../../src/services/mailer.service';

const SECRET = 'test_secret_value_123';
const owner = { studioName: 'Billing Test Studio', fullName: 'Bela Shah', email: 'bela@billing.test', password: 'Sup3rSecret!x' };
const sign = (orderId: string, paymentId: string, secret = SECRET) => crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');

describe('billing (Razorpay test mode)', () => {
  const mutable = env as unknown as Record<string, unknown>;
  beforeEach(async () => {
    await resetDatabase();
    outbox.length = 0;
    mutable.RAZORPAY_KEY_ID = undefined;
    mutable.RAZORPAY_KEY_SECRET = undefined;
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const signedUp = async () => {
    await api().post(`${base}/auth/signup`).send(owner);
    return authed(await login({ email: owner.email, password: owner.password } as never));
  };
  const configure = () => { mutable.RAZORPAY_KEY_ID = 'rzp_test_abc123'; mutable.RAZORPAY_KEY_SECRET = SECRET; };
  const mockOrder = (id = 'order_TEST12345') =>
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id, amount: 0, currency: 'INR' }), { status: 200 }));

  it('reports a trial for a new studio and lists the plans', async () => {
    const a = await signedUp();
    const res = await a.get(`${base}/billing`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('trialing');
    expect(res.body.data.trialDaysLeft).toBeGreaterThan(10);
    expect(res.body.data.plans.map((p: { id: string }) => p.id)).toEqual(['starter', 'studio', 'scale']);
    expect(res.body.data.configured).toBe(false);
  });

  it('is unavailable (503) when no payment keys are configured', async () => {
    const a = await signedUp();
    expect((await a.post(`${base}/billing/checkout`).send({ plan: 'studio', interval: 'monthly' })).status).toBe(503);
  });

  it('creates an order for the exact plan price in paise and remembers it', async () => {
    const a = await signedUp(); configure();
    const spy = mockOrder();
    const res = await a.post(`${base}/billing/checkout`).send({ plan: 'studio', interval: 'yearly' });
    expect(res.status).toBe(200);
    expect(res.body.data.orderId).toBe('order_TEST12345');
    expect(res.body.data.keyId).toBe('rzp_test_abc123');
    const sent = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string);
    expect(sent.amount).toBe(3999 * 10 * 100); // yearly = 10 months, in paise
    expect(sent.currency).toBe('INR');
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it('activates the plan only for a valid signature on the pending order', async () => {
    const a = await signedUp(); configure(); mockOrder('order_ABC999');
    await a.post(`${base}/billing/checkout`).send({ plan: 'starter', interval: 'monthly' });

    const bad = await a.post(`${base}/billing/verify`).send({ orderId: 'order_ABC999', paymentId: 'pay_123456', signature: sign('order_ABC999', 'pay_123456', 'wrong-secret') });
    expect(bad.status).toBe(400);

    const good = await a.post(`${base}/billing/verify`).send({ orderId: 'order_ABC999', paymentId: 'pay_123456', signature: sign('order_ABC999', 'pay_123456') });
    expect(good.status).toBe(200);
    expect(good.body.data.status).toBe('active');
    expect(good.body.data.plan).toBe('starter');
    expect(good.body.data.currentPeriodEnd).toBeTruthy();

    const audit = await prisma.auditLog.findFirst({ where: { entityType: 'Billing' } });
    expect(audit?.summary).toContain('pay_123456');
  });

  it('refuses a payment for an order that was never created by this workspace', async () => {
    const a = await signedUp(); configure();
    const res = await a.post(`${base}/billing/verify`).send({ orderId: 'order_FOREIGN1', paymentId: 'pay_123456', signature: sign('order_FOREIGN1', 'pay_123456') });
    expect(res.status).toBe(409);
  });

  it('requires ORG_UPDATE to change plans', async () => {
    const org = await seedTestOrganization(); configure();
    const member = authed(await login(org.member));
    expect((await member.post(`${base}/billing/checkout`).send({ plan: 'studio', interval: 'monthly' })).status).toBe(403);
    expect((await member.get(`${base}/billing`)).status).toBe(200);
  });

  it('validates the request body', async () => {
    const a = await signedUp(); configure();
    expect((await a.post(`${base}/billing/checkout`).send({ plan: 'platinum', interval: 'monthly' })).status).toBe(400);
    expect((await a.post(`${base}/billing/verify`).send({ orderId: 'x' })).status).toBe(400);
  });
});
