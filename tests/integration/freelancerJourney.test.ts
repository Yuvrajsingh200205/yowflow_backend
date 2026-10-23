import crypto from 'crypto';
import supertest from 'supertest';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, app, authed, base, login } from '../helpers/api';
import { prisma, resetDatabase, seedTestOrganization, TestOrg } from '../helpers/factory';
import { env } from '../../src/config/env';
import { isFreelancerSearchable } from '../../src/services/freelancer.service';

const SECRET = 'test_secret_value_123';
const sign = (orderId: string, paymentId: string, secret = SECRET) => crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');

describe('freelancer journey: join a studio, sign in, buy a plan, get listed', () => {
  const mutable = env as unknown as Record<string, unknown>;
  let a: TestOrg; let b: TestOrg;

  beforeEach(async () => {
    await resetDatabase();
    mutable.RAZORPAY_KEY_ID = undefined; mutable.RAZORPAY_KEY_SECRET = undefined;
    a = await seedTestOrganization('studio-a');
    b = await seedTestOrganization('studio-b');
  });
  afterEach(() => { vi.restoreAllMocks(); mutable.RAZORPAY_KEY_ID = undefined; mutable.RAZORPAY_KEY_SECRET = undefined; });

  const join = (studio: string | undefined, over: Record<string, unknown> = {}) =>
    api().post(`${base}/freelancer-portal/applications`).send({ ...(studio ? { studio } : {}), fullName: 'Rohan Verma', phone: '9811122233', email: 'rohan@free.test', password: 'Freelance#2026', city: 'Jaipur', ...over });
  const signedIn = async (password: string, studio?: string) => {
    const agent = supertest.agent(app);
    const res = await agent.post(`${base}/freelancer-portal/auth/login`).send({ identifier: '9811122233', password, ...(studio ? { studio } : {}) });
    return { agent, res };
  };

  it('needs a studio when several exist, and files the application under the right one', async () => {
    expect((await join(undefined)).status).toBe(400);
    expect((await join('no-such-studio')).status).toBe(404);
    const info = await api().get(`${base}/freelancer-portal/studios/studio-a`).expect(200);
    expect(info.body.data).toMatchObject({ slug: 'studio-a' });
    const ok = await join('studio-b').expect(201);
    expect(ok.body.data.organizationId).toBe(b.organizationId);
    expect(await prisma.freelancer.count({ where: { organizationId: a.organizationId } })).toBe(0);
  });

  it('lets one person work with two studios: the password picks the account', async () => {
    await join('studio-a', { password: 'Alpha#Pass2026' }).expect(201);
    await join('studio-b', { password: 'Bravo#Pass2026' }).expect(201);

    const asA = await signedIn('Alpha#Pass2026');
    expect(asA.res.status).toBe(200);
    const idIn = async (orgId: string) => (await prisma.freelancer.findFirstOrThrow({ where: { organizationId: orgId, phone: '9811122233' } })).id;
    expect((await asA.agent.get(`${base}/freelancer-portal/me`).expect(200)).body.data.freelancer.id).toBe(await idIn(a.organizationId));
    const asB = await signedIn('Bravo#Pass2026');
    expect((await asB.agent.get(`${base}/freelancer-portal/me`).expect(200)).body.data.freelancer.id).toBe(await idIn(b.organizationId));
    expect((await signedIn('Wrong#Pass2026')).res.status).toBe(401);
    // an explicit studio narrows the choice
    expect((await signedIn('Alpha#Pass2026', 'studio-b')).res.status).toBe(401);

    // the main sign-in used by the web app resolves the same way instead of failing with "provide organizationSlug"
    const staffLogin = await api().post(`${base}/auth/login`).send({ email: 'rohan@free.test', password: 'Bravo#Pass2026' });
    expect(staffLogin.status).toBe(200);
    expect(staffLogin.body.data.user.organizationId).toBe(b.organizationId);
  });

  describe('plans and checkout', () => {
    let agent: supertest.Agent; let freelancerId: string;
    beforeEach(async () => {
      const app1 = (await join('studio-a').expect(201)).body.data;
      freelancerId = app1.freelancerId;
      agent = (await signedIn('Freelance#2026')).agent;
    });
    const plans = async () => (await agent.get(`${base}/freelancer-portal/plans`).expect(200)).body.data as Array<{ id: string; slug: string; price: string }>;
    const configure = () => { mutable.RAZORPAY_KEY_ID = 'rzp_test_abc123'; mutable.RAZORPAY_KEY_SECRET = SECRET; };
    const mockOrder = (id: string) => vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id, amount: 49900, currency: 'INR' }), { status: 200 }));

    it('offers default listing plans and says so plainly when payments are not configured', async () => {
      const list = await plans();
      expect(list.map((p) => p.slug)).toEqual(['listed-monthly', 'listed-yearly']);
      const res = await agent.post(`${base}/freelancer-portal/subscription/checkout`).send({ planId: list[0].id });
      expect(res.status).toBe(503);
      expect(res.body.error.message).toMatch(/not enabled/i); // a readable reason, not a generic error
      expect(await prisma.freelancerSubscription.count({ where: { freelancerId } })).toBe(0); // nothing left half-created
    });

    it('charges the plan price in paise, activates only on a valid signature, and is safe to repeat', async () => {
      configure(); const spy = mockOrder('order_FREE1');
      const list = await plans();
      const co = await agent.post(`${base}/freelancer-portal/subscription/checkout`).send({ planId: list[0].id }).expect(200);
      expect(co.body.data).toMatchObject({ activated: false, orderId: 'order_FREE1', keyId: 'rzp_test_abc123' });
      expect(JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string).amount).toBe(49900);
      expect(JSON.stringify(co.body)).not.toContain(SECRET);

      const bad = await agent.post(`${base}/freelancer-portal/subscription/verify`).send({ orderId: 'order_FREE1', paymentId: 'pay_12345', signature: sign('order_FREE1', 'pay_12345', 'other-secret') });
      expect(bad.status).toBe(400);
      expect((await prisma.freelancerSubscription.findFirstOrThrow({ where: { freelancerId } })).status).toBe('PENDING');

      await agent.post(`${base}/freelancer-portal/subscription/verify`).send({ orderId: 'order_FREE1', paymentId: 'pay_12345', signature: sign('order_FREE1', 'pay_12345') }).expect(200);
      const sub = await prisma.freelancerSubscription.findFirstOrThrow({ where: { freelancerId } });
      expect(sub.status).toBe('ACTIVE');
      expect(sub.currentPeriodEnd!.getTime()).toBeGreaterThan(Date.now() + 27 * 86_400_000);
      // a double click or page refresh does not break anything
      await agent.post(`${base}/freelancer-portal/subscription/verify`).send({ orderId: 'order_FREE1', paymentId: 'pay_12345', signature: sign('order_FREE1', 'pay_12345') }).expect(200);
    });

    it('cannot activate with someone else’s order, and switching plans retires the old one', async () => {
      configure(); mockOrder('order_ONE');
      const list = await plans();
      await agent.post(`${base}/freelancer-portal/subscription/checkout`).send({ planId: list[0].id }).expect(200);
      await agent.post(`${base}/freelancer-portal/subscription/verify`).send({ orderId: 'order_ONE', paymentId: 'pay_1111', signature: sign('order_ONE', 'pay_1111') }).expect(200);

      // a freelancer of another studio replays the same ids
      await join('studio-b', { phone: '9822233344', email: 'other@free.test' }).expect(201);
      const other = supertest.agent(app);
      await other.post(`${base}/freelancer-portal/auth/login`).send({ identifier: '9822233344', password: 'Freelance#2026' }).expect(200);
      expect((await other.post(`${base}/freelancer-portal/subscription/verify`).send({ orderId: 'order_ONE', paymentId: 'pay_1111', signature: sign('order_ONE', 'pay_1111') })).status).toBe(409);

      mockOrder('order_TWO');
      await agent.post(`${base}/freelancer-portal/subscription/checkout`).send({ planId: list[1].id }).expect(200);
      await agent.post(`${base}/freelancer-portal/subscription/verify`).send({ orderId: 'order_TWO', paymentId: 'pay_2222', signature: sign('order_TWO', 'pay_2222') }).expect(200);
      const subs = await prisma.freelancerSubscription.findMany({ where: { freelancerId }, orderBy: { createdAt: 'asc' } });
      expect(subs.map((s) => s.status)).toEqual(['CANCELED', 'ACTIVE']);
    });

    it('activates a free plan at once, can be cancelled, and an approved + subscribed freelancer becomes searchable', async () => {
      const adminToken = await login(a.admin);
      const free = await authed(adminToken).post(`${base}/freelancers/plans`).send({ name: 'Starter listing', slug: 'starter', price: 0, billingInterval: 'MONTHLY' });
      expect(free.status).toBe(201);
      const res = await agent.post(`${base}/freelancer-portal/subscription/checkout`).send({ planId: free.body.data.id }).expect(200);
      expect(res.body.data.activated).toBe(true);
      expect(await isFreelancerSearchable(a.organizationId, freelancerId)).toBe(false); // not approved yet

      const application = await prisma.freelancerApplication.findFirstOrThrow({ where: { freelancerId } });
      await authed(adminToken).post(`${base}/freelancers/applications/${application.id}/review`).send({ status: 'APPROVED' }).expect(200);
      expect(await isFreelancerSearchable(a.organizationId, freelancerId)).toBe(true);

      await agent.post(`${base}/freelancer-portal/subscription/cancel`).expect(200);
      expect(await isFreelancerSearchable(a.organizationId, freelancerId)).toBe(false);
      expect((await agent.post(`${base}/freelancer-portal/subscription/cancel`)).status).toBe(404);
    });
  });

  describe('portfolio uploads', () => {
    let agent: supertest.Agent;
    beforeEach(async () => {
      await join('studio-a').expect(201);
      agent = (await signedIn('Freelance#2026')).agent;
    });
    const upload = async (name = 'work.jpg', mimeType = 'image/jpeg') => {
      const bytes = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 120, b: 60 } } }).jpeg().toBuffer();
      const intent = await agent.post(`${base}/freelancer-portal/portfolio/upload-intent`).send({ originalName: name, mimeType });
      if (intent.status !== 200) return { intent };
      const u = new URL(intent.body.data.uploadUrl);
      await supertest(app).put(`${u.pathname}${u.search}`).set('content-type', mimeType).send(bytes).expect(204);
      const res = await agent.post(`${base}/freelancer-portal/portfolio/upload`).send({
        bucket: intent.body.data.bucket, objectKey: intent.body.data.objectKey, originalName: name, mimeType, sizeBytes: bytes.length, title: 'Haldi candid',
      });
      return { intent, res, bytes, objectKey: intent.body.data.objectKey as string, bucket: intent.body.data.bucket as string };
    };

    it('uploads a work sample and shows it on the profile with a viewable link', async () => {
      const r = await upload();
      expect(r.res!.status).toBe(201);
      expect(r.res!.body.data.fileObject.url).toMatch(/^https?:\/\//);
      const me = await agent.get(`${base}/freelancer-portal/me`).expect(200);
      expect(me.body.data.freelancer.portfolioItems).toHaveLength(1);
      expect(me.body.data.freelancer.portfolioItems[0]).toMatchObject({ title: 'Haldi candid', isPublished: true });
    });

    it('refuses other file types, oversized files and keys that were not issued for a portfolio', async () => {
      expect((await upload('virus.exe', 'application/x-msdownload')).intent.status).toBe(400);
      const ok = await upload();
      const base2 = { bucket: ok.bucket!, originalName: 'x.jpg', mimeType: 'image/jpeg', title: 'x' };
      expect((await agent.post(`${base}/freelancer-portal/portfolio/upload`).send({ ...base2, objectKey: ok.objectKey!, sizeBytes: 30 * 1024 * 1024 })).status).toBe(400);
      expect((await agent.post(`${base}/freelancer-portal/portfolio/upload`).send({ ...base2, objectKey: 'other-org/secret/doc.pdf', sizeBytes: 1000 })).status).toBe(400);
    });
  });
});
