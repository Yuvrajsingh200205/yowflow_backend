import { beforeEach, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { api, app, authed, base, login } from '../helpers/api';
import { prisma, resetDatabase, seedTestOrganization } from '../helpers/factory';
import { outbox } from '../../src/services/mailer.service';
import { PORTAL_PASSWORD, PortalFixture, seedPortalStudio, signedInCouple, tokenFromMail } from '../helpers/portal';

describe('client portal authentication', () => {
  let f: PortalFixture;
  beforeEach(async () => {
    await resetDatabase();
    outbox.length = 0;
    f = await seedPortalStudio();
  });

  it('studio invites a client; the e-mailed link lets them set a password and signs them in', async () => {
    const invite = await f.staff.post(`${base}/clients/${f.clientId}/portal-access`).send({ email: f.inviteEmail, fullName: 'Aarav Sharma' });
    expect(invite.status).toBe(201);
    expect(invite.body.data.status).toBe('INVITED');
    expect(JSON.stringify(invite.body)).not.toMatch(/passwordHash|token/i);
    const mail = outbox[outbox.length - 1];
    expect(mail.to).toBe(f.inviteEmail);
    const token = tokenFromMail(mail);

    const preview = await api().get(`${base}/portal/auth/invite/${token}`);
    expect(preview.body.data).toMatchObject({ email: f.inviteEmail, fullName: 'Aarav Sharma' });

    const agent = supertest.agent(app);
    const accept = await agent.post(`${base}/portal/auth/invite/${token}/accept`).send({ password: PORTAL_PASSWORD });
    expect(accept.status).toBe(200);
    expect(accept.body.data.client.displayName).toBe('Aarav & Diya');
    expect((await agent.get(`${base}/portal/me`)).status).toBe(200);

    // the link is single-use
    expect((await api().post(`${base}/portal/auth/invite/${token}/accept`).send({ password: PORTAL_PASSWORD })).status).toBe(400);
  });

  it('rejects weak passwords and bogus tokens', async () => {
    await f.staff.post(`${base}/clients/${f.clientId}/portal-access`).send({ email: f.inviteEmail, fullName: 'Aarav Sharma' });
    const token = tokenFromMail(outbox[outbox.length - 1]);
    expect((await api().post(`${base}/portal/auth/invite/${token}/accept`).send({ password: 'short' })).status).toBe(400);
    expect((await api().get(`${base}/portal/auth/invite/${'x'.repeat(43)}`)).status).toBe(400);
  });

  it('signs in with email and password, rotates on refresh, and logout revokes the session', async () => {
    const { agent } = await signedInCouple(f);
    await agent.post(`${base}/portal/auth/logout`).expect(200);
    expect((await agent.get(`${base}/portal/me`)).status).toBe(401);

    const fresh = supertest.agent(app);
    expect((await fresh.post(`${base}/portal/auth/login`).send({ email: f.inviteEmail, password: 'Wrong#Pass1234' })).status).toBe(401);
    const ok = await fresh.post(`${base}/portal/auth/login`).send({ email: f.inviteEmail.toUpperCase(), password: PORTAL_PASSWORD });
    expect(ok.status).toBe(200);
    expect((ok.headers['set-cookie'] as unknown as string[]).join(';')).toMatch(/yf_portal_access_token=.*HttpOnly/i);

    const before = (ok.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('yf_portal_refresh_token'));
    const refreshed = await fresh.post(`${base}/portal/auth/refresh`).send({});
    expect(refreshed.status).toBe(200);
    expect((refreshed.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('yf_portal_refresh_token'))).not.toBe(before);
    expect((await fresh.get(`${base}/portal/me`)).status).toBe(200);
  });

  it('signs out with only the refresh cookie (expired access token) and the session is really gone', async () => {
    await signedInCouple(f);
    const res = await api().post(`${base}/portal/auth/login`).send({ email: f.inviteEmail, password: PORTAL_PASSWORD }).expect(200);
    const jar = (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]);
    const refreshOnly = jar.filter((c) => c.startsWith('yf_portal_refresh_token=')).join('; ');
    const out = await api().post(`${base}/portal/auth/logout`).set('Cookie', refreshOnly);
    expect(out.status).toBe(200);
    expect((out.headers['set-cookie'] as unknown as string[]).join(';')).toMatch(/yf_portal_refresh_token=;/);
    expect((await api().post(`${base}/portal/auth/refresh`).set('Cookie', refreshOnly).send({})).status).toBe(401);
    expect((await api().get(`${base}/portal/me`).set('Cookie', jar.join('; '))).status).toBe(401);
    // and with nothing at all it is still a harmless 200
    expect((await api().post(`${base}/portal/auth/logout`)).status).toBe(200);
  });

  it('never reveals whether an email has portal access', async () => {
    await signedInCouple(f);
    const a = await api().post(`${base}/portal/auth/login`).send({ email: 'nobody@portal.test', password: 'Whatever#12345' });
    const b = await api().post(`${base}/portal/auth/login`).send({ email: f.inviteEmail, password: 'Whatever#12345' });
    expect(a.status).toBe(401);
    expect(a.body.error.message).toBe(b.body.error.message);
  });

  it('locks the account after repeated failures', async () => {
    await signedInCouple(f);
    for (let i = 0; i < 5; i++) await api().post(`${base}/portal/auth/login`).send({ email: f.inviteEmail, password: 'Wrong#Pass1234' });
    const locked = await api().post(`${base}/portal/auth/login`).send({ email: f.inviteEmail, password: PORTAL_PASSWORD });
    expect(locked.status).toBe(401);
  });

  it('studio and portal identities never cross: a staff session is not a portal session and vice versa', async () => {
    const { agent } = await signedInCouple(f);
    const staffToken = await login(f.org.admin);
    expect((await api().get(`${base}/portal/me`).set('Authorization', `Bearer ${staffToken}`)).status).toBe(401);
    expect((await agent.get(`${base}/auth/me`)).status).toBe(401);
    expect((await agent.get(`${base}/clients`)).status).toBe(401);
  });

  it('forgot → reset password works once, ends old sessions and never enumerates accounts', async () => {
    const { agent } = await signedInCouple(f);
    outbox.length = 0;
    const known = await api().post(`${base}/portal/auth/forgot-password`).send({ email: f.inviteEmail });
    const unknown = await api().post(`${base}/portal/auth/forgot-password`).send({ email: 'ghost@portal.test' });
    expect(known.body.data).toEqual(unknown.body.data);
    expect(outbox).toHaveLength(1);
    const token = tokenFromMail(outbox[0]);

    expect((await api().post(`${base}/portal/auth/reset-password`).send({ token, password: 'NewPortal#Pass77' })).status).toBe(200);
    expect((await agent.get(`${base}/portal/me`)).status).toBe(401);
    expect((await api().post(`${base}/portal/auth/login`).send({ email: f.inviteEmail, password: 'NewPortal#Pass77' })).status).toBe(200);
    expect((await api().post(`${base}/portal/auth/reset-password`).send({ token, password: 'AnotherOne#99xy' })).status).toBe(400);
  });

  it('suspending a portal user kills their live session immediately; re-enabling restores access', async () => {
    const { agent, me } = await signedInCouple(f);
    expect((await f.staff.patch(`${base}/clients/${f.clientId}/portal-access/${me.user.id}`).send({ status: 'SUSPENDED' })).status).toBe(200);
    expect((await agent.get(`${base}/portal/me`)).status).toBe(401);
    expect((await api().post(`${base}/portal/auth/login`).send({ email: f.inviteEmail, password: PORTAL_PASSWORD })).status).toBe(403);
    await f.staff.patch(`${base}/clients/${f.clientId}/portal-access/${me.user.id}`).send({ status: 'ACTIVE' }).expect(200);
    expect((await api().post(`${base}/portal/auth/login`).send({ email: f.inviteEmail, password: PORTAL_PASSWORD })).status).toBe(200);
  });

  it('removing portal access revokes sessions; listing shows status without secrets', async () => {
    const { agent, me } = await signedInCouple(f);
    const list = await f.staff.get(`${base}/clients/${f.clientId}/portal-access`).expect(200);
    expect(list.body.data[0]).toMatchObject({ email: f.inviteEmail, status: 'ACTIVE' });
    expect(JSON.stringify(list.body)).not.toMatch(/passwordHash|refresh/i);
    await f.staff.delete(`${base}/clients/${f.clientId}/portal-access/${me.user.id}`).expect(200);
    expect((await agent.get(`${base}/portal/me`)).status).toBe(401);
    expect((await f.staff.get(`${base}/clients/${f.clientId}/portal-access`)).body.data).toHaveLength(0);
  });

  it('re-inviting an active user sends a fresh link without duplicating the account', async () => {
    await signedInCouple(f);
    outbox.length = 0;
    await f.staff.post(`${base}/clients/${f.clientId}/portal-access`).send({ email: f.inviteEmail, fullName: 'Aarav Sharma' }).expect(201);
    expect(await prisma.clientPortalUser.count({ where: { email: f.inviteEmail } })).toBe(1);
    expect(outbox).toHaveLength(1);
  });

  it('is tenant-safe: another studio cannot invite for, list or manage this studio\'s client', async () => {
    const other = await seedTestOrganization('other-studio');
    const otherStaff = authed(await login(other.admin));
    expect((await otherStaff.post(`${base}/clients/${f.clientId}/portal-access`).send({ email: 'x@y.test', fullName: 'Mallory' })).status).toBe(404);
    expect((await otherStaff.get(`${base}/clients/${f.clientId}/portal-access`)).status).toBe(404);
  });

  it('requires the right staff permission to invite', async () => {
    const memberRes = await api().post(`${base}/auth/login`).send({ email: f.org.member.email, password: f.org.member.password });
    const member = authed(memberRes.body.data.tokens.accessToken);
    expect((await member.post(`${base}/clients/${f.clientId}/portal-access`).send({ email: 'z@y.test', fullName: 'Zed Zed' })).status).toBe(403);
  });
});
