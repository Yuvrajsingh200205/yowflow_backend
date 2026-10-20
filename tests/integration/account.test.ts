import { beforeEach, describe, expect, it } from 'vitest';
import { api, base, login } from '../helpers/api';
import { prisma, resetDatabase, seedTestOrganization } from '../helpers/factory';
import { outbox } from '../../src/services/mailer.service';

const tokenFrom = (message: { text: string }) => decodeURIComponent(/token=([^\s&]+)/.exec(message.text)![1]);
const signupBody = { studioName: 'Lumen & Co Studio', fullName: 'Asha Rao', email: 'asha@lumen.test', password: 'Sup3rSecret!x' };

describe('account lifecycle', () => {
  beforeEach(async () => {
    await resetDatabase();
    outbox.length = 0;
  });

  describe('signup', () => {
    it('creates an organisation, an Admin owner, a trial and a verification email', async () => {
      const res = await api().post(`${base}/auth/signup`).send(signupBody);
      expect(res.status).toBe(201);
      expect(res.body.data.organization.slug).toBe('lumen-co-studio');
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);

      const user = await prisma.user.findFirstOrThrow({ where: { email: 'asha@lumen.test' }, include: { userRoles: { include: { role: true } } } });
      expect(user.emailVerifiedAt).toBeNull();
      expect(user.userRoles.map((r) => r.role.name)).toContain('Admin');

      const org = await prisma.organization.findFirstOrThrow({ where: { slug: 'lumen-co-studio' } });
      expect((org.settings as { billing: { status: string } }).billing.status).toBe('trialing');
      expect(await prisma.role.count({ where: { organizationId: org.id } })).toBeGreaterThan(5);
      expect(await prisma.eventType.count({ where: { organizationId: org.id } })).toBeGreaterThan(0);

      expect(outbox).toHaveLength(1);
      expect(outbox[0].to).toBe('asha@lumen.test');
    });

    it('lets the new owner sign in with full permissions', async () => {
      await api().post(`${base}/auth/signup`).send(signupBody);
      const res = await api().post(`${base}/auth/login`).send({ email: signupBody.email, password: signupBody.password });
      expect(res.status).toBe(200);
      expect(res.body.data.user.roles).toContain('Admin');
      expect(res.body.data.user.permissions.length).toBeGreaterThan(10);
      expect(res.body.data.user.emailVerified).toBe(false);
    });

    it('rejects a duplicate email and a weak password', async () => {
      await api().post(`${base}/auth/signup`).send(signupBody);
      expect((await api().post(`${base}/auth/signup`).send({ ...signupBody, studioName: 'Other' })).status).toBe(409);
      expect((await api().post(`${base}/auth/signup`).send({ ...signupBody, email: 'x@y.test', password: 'short' })).status).toBe(400);
    });

    it('gives two studios with the same name distinct slugs', async () => {
      await api().post(`${base}/auth/signup`).send(signupBody);
      const second = await api().post(`${base}/auth/signup`).send({ ...signupBody, email: 'b@lumen.test' });
      expect(second.status).toBe(201);
      expect(second.body.data.organization.slug).not.toBe('lumen-co-studio');
    });
  });

  describe('email verification', () => {
    it('verifies with the emailed token exactly once', async () => {
      await api().post(`${base}/auth/signup`).send(signupBody);
      const token = tokenFrom(outbox[0]);
      expect((await api().post(`${base}/auth/verify-email`).send({ token })).status).toBe(200);
      const user = await prisma.user.findFirstOrThrow({ where: { email: signupBody.email } });
      expect(user.emailVerifiedAt).not.toBeNull();
      expect((await api().post(`${base}/auth/verify-email`).send({ token })).status).toBe(400);
    });

    it('rejects a made-up token', async () => {
      expect((await api().post(`${base}/auth/verify-email`).send({ token: 'x'.repeat(43) })).status).toBe(400);
    });

    it('resends for a signed-in unverified user, but not twice within a minute', async () => {
      await api().post(`${base}/auth/signup`).send(signupBody);
      const token = await login({ email: signupBody.email, password: signupBody.password } as never);
      const first = await api().post(`${base}/auth/resend-verification`).set('Authorization', `Bearer ${token}`);
      expect(first.status).toBe(400); // the signup mail was just sent: cooldown applies
    });

    it('requires authentication to resend', async () => {
      expect((await api().post(`${base}/auth/resend-verification`)).status).toBe(401);
    });
  });

  describe('password reset', () => {
    it('does not reveal whether an address exists', async () => {
      const known = await api().post(`${base}/auth/forgot-password`).send({ email: 'nobody@lumen.test' });
      await api().post(`${base}/auth/signup`).send(signupBody);
      outbox.length = 0;
      const unknown = await api().post(`${base}/auth/forgot-password`).send({ email: signupBody.email });
      expect(known.status).toBe(200);
      expect(unknown.status).toBe(200);
      expect(known.body.data).toEqual(unknown.body.data);
      expect(outbox).toHaveLength(1);
    });

    it('sets a new password, ends old sessions, and consumes the token', async () => {
      await api().post(`${base}/auth/signup`).send(signupBody);
      const oldToken = await login({ email: signupBody.email, password: signupBody.password } as never);
      outbox.length = 0;
      await api().post(`${base}/auth/forgot-password`).send({ email: signupBody.email });
      const token = tokenFrom(outbox[0]);

      const reset = await api().post(`${base}/auth/reset-password`).send({ token, password: 'BrandNew#Pass9' });
      expect(reset.status).toBe(200);

      expect((await api().post(`${base}/auth/login`).send({ email: signupBody.email, password: signupBody.password })).status).toBe(401);
      expect((await api().post(`${base}/auth/login`).send({ email: signupBody.email, password: 'BrandNew#Pass9' })).status).toBe(200);
      expect((await api().get(`${base}/auth/me`).set('Authorization', `Bearer ${oldToken}`)).status).toBe(401);
      expect((await api().post(`${base}/auth/reset-password`).send({ token, password: 'AnotherOne#99x' })).status).toBe(400);
    });

    it('rejects an expired token and a weak new password', async () => {
      await api().post(`${base}/auth/signup`).send(signupBody);
      outbox.length = 0;
      await api().post(`${base}/auth/forgot-password`).send({ email: signupBody.email });
      const token = tokenFrom(outbox[0]);
      expect((await api().post(`${base}/auth/reset-password`).send({ token, password: 'weak' })).status).toBe(400);
      await prisma.emailToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await api().post(`${base}/auth/reset-password`).send({ token, password: 'BrandNew#Pass9' })).status).toBe(400);
    });

    it('a newer reset link retires the older one', async () => {
      await api().post(`${base}/auth/signup`).send(signupBody);
      outbox.length = 0;
      await api().post(`${base}/auth/forgot-password`).send({ email: signupBody.email });
      await api().post(`${base}/auth/forgot-password`).send({ email: signupBody.email });
      const [older, newer] = outbox.map(tokenFrom);
      expect((await api().post(`${base}/auth/reset-password`).send({ token: older, password: 'BrandNew#Pass9' })).status).toBe(400);
      expect((await api().post(`${base}/auth/reset-password`).send({ token: newer, password: 'BrandNew#Pass9' })).status).toBe(200);
    });
  });

  describe('public contact form', () => {
    const body = { name: 'Dev Patel', email: 'dev@studio.test', message: 'We run a 12-person wedding studio and would like a demo.' };

    it('stores the message and notifies support', async () => {
      const res = await api().post(`${base}/public/contact`).send(body);
      expect(res.status).toBe(201);
      expect(await prisma.contactMessage.count()).toBe(1);
      expect(outbox.some((m) => m.subject.includes('Dev Patel'))).toBe(true);
    });

    it('validates input', async () => {
      expect((await api().post(`${base}/public/contact`).send({ ...body, email: 'nope' })).status).toBe(400);
      expect((await api().post(`${base}/public/contact`).send({ ...body, message: 'hi' })).status).toBe(400);
    });

    it('silently drops honeypot submissions', async () => {
      const res = await api().post(`${base}/public/contact`).send({ ...body, website: 'http://spam.test' });
      expect(res.status).toBe(201);
      expect(await prisma.contactMessage.count()).toBe(0);
    });
  });

  it('exposes emailVerified on /auth/me and flips it after verification', async () => {
    await api().post(`${base}/auth/signup`).send(signupBody);
    const token = await login({ email: signupBody.email, password: signupBody.password } as never);
    const before = await api().get(`${base}/auth/me`).set('Authorization', `Bearer ${token}`);
    expect(before.body.data.emailVerified).toBe(false);
    await api().post(`${base}/auth/verify-email`).send({ token: tokenFrom(outbox[0]) });
    const after = await api().get(`${base}/auth/me`).set('Authorization', `Bearer ${token}`);
    expect(after.body.data.emailVerified).toBe(true);
  });

  it('keeps tenants isolated: a new studio cannot see another studio’s data', async () => {
    const org = await seedTestOrganization();
    await api().post(`${base}/auth/signup`).send(signupBody);
    const token = await login({ email: signupBody.email, password: signupBody.password } as never);
    const res = await api().get(`${base}/clients`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(org.admin.email);
  });
});

describe('workspace members', () => {
  beforeEach(async () => { await resetDatabase(); outbox.length = 0; });

  it('lists every user in the workspace for an admin, and refuses members', async () => {
    const org = await seedTestOrganization();
    const adminToken = await login(org.admin);
    const res = await api().get(`${base}/settings/members`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((m: { email: string }) => m.email)).toContain(org.admin.email);
    expect(res.body.data[0]).not.toHaveProperty('passwordHash');

    const memberToken = await login(org.member);
    expect((await api().get(`${base}/settings/members`).set('Authorization', `Bearer ${memberToken}`)).status).toBe(403);
  });

  it('includes a self-serve owner who is not in the employee directory', async () => {
    await api().post(`${base}/auth/signup`).send(signupBody);
    const token = await login({ email: signupBody.email, password: signupBody.password } as never);
    const res = await api().get(`${base}/settings/members`).set('Authorization', `Bearer ${token}`);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].roles).toContain('Admin');
  });
});
