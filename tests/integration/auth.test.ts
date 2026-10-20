import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api, authed, base, eventually, login } from '../helpers/api';
import { prisma, resetDatabase, seedTestOrganization, TestOrg } from '../helpers/factory';

describe('authentication', () => {
  let org: TestOrg;

  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
    org = await seedTestOrganization();
  });

  it('signs in with valid credentials and returns roles and permissions', async () => {
    const response = await api()
      .post(`${base}/auth/login`)
      .send({ email: org.admin.email, password: org.admin.password });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.tokens.accessToken).toBeTruthy();
    expect(response.body.data.tokens.refreshToken).toBeTruthy();
    expect(response.body.data.user.roles).toContain('Admin');
    expect(response.body.data.user.permissions).toContain('PAYMENT_CREATE');
  });

  it('never returns a password hash', async () => {
    const response = await api()
      .post(`${base}/auth/login`)
      .send({ email: org.admin.email, password: org.admin.password });

    expect(JSON.stringify(response.body)).not.toContain('passwordHash');
    expect(response.body.data.user.passwordHash).toBeUndefined();
  });

  it('rejects a wrong password with an indistinguishable message', async () => {
    const wrongPassword = await api()
      .post(`${base}/auth/login`)
      .send({ email: org.admin.email, password: 'NotThePassword1!' });

    const unknownEmail = await api()
      .post(`${base}/auth/login`)
      .send({ email: 'nobody@test.test', password: 'NotThePassword1!' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    // User enumeration must not be possible from the response.
    expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
  });

  it('records every login attempt in login history', async () => {
    await api().post(`${base}/auth/login`).send({ email: org.admin.email, password: 'wrong-password' });
    await api()
      .post(`${base}/auth/login`)
      .send({ email: org.admin.email, password: org.admin.password });

    await eventually(async () => {
      const history = await prisma.loginHistory.findMany({ orderBy: { createdAt: 'asc' } });
      expect(history.map((h) => h.outcome)).toEqual(['INVALID_CREDENTIALS', 'SUCCESS']);
    });
  });

  it('locks the account after repeated failures', async () => {
    for (let i = 0; i < 5; i += 1) {
      await api().post(`${base}/auth/login`).send({ email: org.member.email, password: 'wrong-password' });
    }

    const response = await api()
      .post(`${base}/auth/login`)
      .send({ email: org.member.email, password: org.member.password });

    expect(response.status).toBe(403);
    expect(response.body.error.message).toMatch(/locked/i);
  });

  it('returns the current user from /auth/me', async () => {
    const token = await login(org.admin);
    const response = await authed(token).get(`${base}/auth/me`);

    expect(response.status).toBe(200);
    expect(response.body.data.email).toBe(org.admin.email);
    expect(response.body.data.organization.slug).toBe('test-studio');
  });

  it('rejects requests with no token', async () => {
    const response = await api().get(`${base}/auth/me`);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rotates the refresh token and retires the old one', async () => {
    const loginResponse = await api()
      .post(`${base}/auth/login`)
      .send({ email: org.admin.email, password: org.admin.password });
    const original = loginResponse.body.data.tokens.refreshToken;

    const first = await api().post(`${base}/auth/refresh`).send({ refreshToken: original });
    expect(first.status).toBe(200);
    expect(first.body.data.tokens.refreshToken).not.toBe(original);

    // Reusing a rotated token must fail — it is single-use.
    const replay = await api().post(`${base}/auth/refresh`).send({ refreshToken: original });
    expect(replay.status).toBe(401);
  });

  it('invalidates the session immediately on logout', async () => {
    const token = await login(org.admin);
    await authed(token).post(`${base}/auth/logout`).expect(200);

    const afterLogout = await authed(token).get(`${base}/auth/me`);
    expect(afterLogout.status).toBe(401);
  });

  it('revokes access the moment an account is disabled', async () => {
    const token = await login(org.member);
    await authed(token).get(`${base}/auth/me`).expect(200);

    await prisma.user.update({ where: { id: org.member.id }, data: { status: 'DISABLED' } });

    // Authority is re-read from PostgreSQL per request, so this does not wait
    // for the access token to expire.
    const response = await authed(token).get(`${base}/auth/me`);
    expect(response.status).toBe(403);
  });

  // --- Cookie session ----------------------------------------------------
  // The browser never sends an Authorization header on a cold start; it relies
  // entirely on the httpOnly cookies set by /auth/login.

  const setCookies = (response: { headers: Record<string, unknown> }): string[] => {
    const raw = response.headers['set-cookie'];
    return Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  };
  const cookieHeader = (cookies: string[]) => cookies.map((c) => c.split(';')[0]).join('; ');
  const cookieFor = (cookies: string[], name: string) =>
    cookies.find((c) => c.startsWith(`${name}=`));

  it('sets httpOnly access and refresh cookies on login', async () => {
    const response = await api()
      .post(`${base}/auth/login`)
      .send({ email: org.admin.email, password: org.admin.password });

    const cookies = setCookies(response);
    const access = cookieFor(cookies, 'fl_access_token');
    const refresh = cookieFor(cookies, 'fl_refresh_token');

    expect(access).toBeDefined();
    expect(refresh).toBeDefined();
    expect(access).toMatch(/HttpOnly/i);
    expect(refresh).toMatch(/HttpOnly/i);
    expect(access).toMatch(/Path=\//);
    expect(refresh).toMatch(/Path=\//);
    // A hardcoded Domain would break every deployment but the one it names.
    expect(access).not.toMatch(/Domain=/i);
  });

  it('authenticates /auth/me from the cookie alone', async () => {
    const loginResponse = await api()
      .post(`${base}/auth/login`)
      .send({ email: org.admin.email, password: org.admin.password });

    const response = await api()
      .get(`${base}/auth/me`)
      .set('Cookie', cookieHeader(setCookies(loginResponse)));

    expect(response.status).toBe(200);
    expect(response.body.data.email).toBe(org.admin.email);
  });

  it('refreshes from the cookie alone, with no refreshToken in the body', async () => {
    const loginResponse = await api()
      .post(`${base}/auth/login`)
      .send({ email: org.admin.email, password: org.admin.password });

    const refreshed = await api()
      .post(`${base}/auth/refresh`)
      .set('Cookie', cookieHeader(setCookies(loginResponse)))
      .send({});

    expect(refreshed.status).toBe(200);
    const rotated = setCookies(refreshed);
    expect(cookieFor(rotated, 'fl_refresh_token')).toBeDefined();

    const me = await api().get(`${base}/auth/me`).set('Cookie', cookieHeader(rotated));
    expect(me.status).toBe(200);
  });

  it('clears both auth cookies when a refresh is rejected', async () => {
    // Without this, the edge middleware keeps seeing an authenticated browser
    // and the app retries /me -> /refresh indefinitely.
    const rejected = await api()
      .post(`${base}/auth/refresh`)
      .set('Cookie', 'fl_access_token=stale; fl_refresh_token=not-a-real-token')
      .send({});

    expect(rejected.status).toBe(401);
    const cleared = setCookies(rejected);
    expect(cookieFor(cleared, 'fl_access_token')).toMatch(/fl_access_token=;/);
    expect(cookieFor(cleared, 'fl_refresh_token')).toMatch(/fl_refresh_token=;/);
  });

  it('clears both auth cookies when no refresh token is supplied', async () => {
    const response = await api().post(`${base}/auth/refresh`).send({});

    expect(response.status).toBe(401);
    // A CRM login also issues the freelancer portal pair for staff who have a
    // freelancer profile, so a dead session has to clear all four. Leaving the
    // portal cookies behind would survive a CRM logout.
    const cleared = setCookies(response);
    for (const name of [
      'fl_access_token',
      'fl_refresh_token',
      'fl_freelancer_access_token',
      'fl_freelancer_refresh_token',
    ]) {
      expect(cookieFor(cleared, name)).toMatch(new RegExp(`${name}=;`));
    }
  });

  it('clears the auth cookies on logout and stops accepting them', async () => {
    const loginResponse = await api()
      .post(`${base}/auth/login`)
      .send({ email: org.admin.email, password: org.admin.password });
    const cookies = cookieHeader(setCookies(loginResponse));

    const logout = await api().post(`${base}/auth/logout`).set('Cookie', cookies);
    expect(logout.status).toBe(200);
    expect(cookieFor(setCookies(logout), 'fl_access_token')).toMatch(/fl_access_token=;/);

    // Even if the browser ignored the deletion, the session is dead server-side.
    const after = await api().get(`${base}/auth/me`).set('Cookie', cookies);
    expect(after.status).toBe(401);
  });

  it('does not leak the refresh token into the /auth/me payload', async () => {
    const loginResponse = await api()
      .post(`${base}/auth/login`)
      .send({ email: org.admin.email, password: org.admin.password });
    const refreshToken = loginResponse.body.data.tokens.refreshToken as string;

    const me = await api()
      .get(`${base}/auth/me`)
      .set('Cookie', cookieHeader(setCookies(loginResponse)));

    expect(JSON.stringify(me.body)).not.toContain(refreshToken);
  });

  it('writes an audit row for a successful sign-in', async () => {
    await login(org.admin);
    await eventually(async () => {
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'LOGIN', actorId: org.admin.id },
      });
      expect(audit).not.toBeNull();
      expect(audit?.entityType).toBe('User');
    });
  });
});
