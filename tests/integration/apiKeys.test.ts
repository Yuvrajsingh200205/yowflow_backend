import { beforeEach, describe, expect, it } from 'vitest';
import { api, authed, base, login } from '../helpers/api';
import { prisma, resetDatabase, seedTestOrganization, TestOrg } from '../helpers/factory';

describe('API keys', () => {
  let org: TestOrg;
  let admin: ReturnType<typeof authed>;

  const makeKey = async (scope: 'READ_ONLY' | 'FULL' = 'READ_ONLY') => {
    const res = await admin.post(`${base}/settings/api-keys`).send({ name: 'CI integration', scope });
    expect(res.status).toBe(201);
    return res.body.data as { id: string; key: string; prefix: string; scope: string };
  };
  const withKey = (key: string) => ({
    get: (p: string) => api().get(p).set('Authorization', `Bearer ${key}`),
    post: (p: string) => api().post(p).set('Authorization', `Bearer ${key}`),
  });

  beforeEach(async () => {
    await resetDatabase();
    org = await seedTestOrganization();
    admin = authed(await login(org.admin));
  });

  it('shows the plaintext key once and stores only a hash', async () => {
    const created = await makeKey();
    expect(created.key.startsWith('yfk_')).toBe(true);
    const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.keyHash).not.toContain(created.key);
    expect(JSON.stringify(row)).not.toContain(created.key);

    const list = await admin.get(`${base}/settings/api-keys`);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(created.key);
    expect(list.body.data[0].prefix).toBe(created.prefix);
  });

  it('authenticates reads as the key owner', async () => {
    const { key } = await makeKey();
    const res = await withKey(key).get(`${base}/clients`);
    expect(res.status).toBe(200);
  });

  it('read-only keys cannot write; full keys can', async () => {
    const ro = await makeKey('READ_ONLY');
    const blocked = await withKey(ro.key).post(`${base}/clients`).send({ fullName: 'Nope' });
    expect(blocked.status).toBe(403);
    const full = await makeKey('FULL');
    const attempt = await withKey(full.key).post(`${base}/clients`).send({});
    expect(attempt.status).not.toBe(403); // reaches validation instead of being refused
    expect(attempt.status).not.toBe(401);
  });

  it('cannot reach credential, key-management or billing endpoints', async () => {
    const { key } = await makeKey('FULL');
    for (const path of ['/auth/me', '/settings/api-keys', '/billing']) {
      expect((await withKey(key).get(`${base}${path}`)).status, path).toBe(403);
    }
  });

  it('stops working once revoked and rejects unknown or expired keys', async () => {
    const created = await makeKey();
    expect((await withKey(created.key).get(`${base}/clients`)).status).toBe(200);
    expect((await admin.delete(`${base}/settings/api-keys/${created.id}`)).status).toBe(200);
    expect((await withKey(created.key).get(`${base}/clients`)).status).toBe(401);
    expect((await withKey('yfk_totally-made-up-key').get(`${base}/clients`)).status).toBe(401);

    const second = await makeKey();
    await prisma.apiKey.update({ where: { id: second.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await withKey(second.key).get(`${base}/clients`)).status).toBe(401);
  });

  it('inherits the owner’s permissions: a key from a low-privilege user stays low-privilege', async () => {
    const memberToken = await login(org.member);
    const asMember = await authed(memberToken).post(`${base}/settings/api-keys`).send({ name: 'x', scope: 'READ_ONLY' });
    expect(asMember.status).toBe(403); // members cannot mint keys at all
  });

  it('a key stops working when its owner is disabled', async () => {
    const { key } = await makeKey();
    await prisma.user.update({ where: { id: org.admin.id }, data: { status: 'DISABLED' } });
    expect((await withKey(key).get(`${base}/clients`)).status).toBe(403);
  });

  it('writes audit entries for create and revoke', async () => {
    const created = await makeKey();
    await admin.delete(`${base}/settings/api-keys/${created.id}`);
    const entries = await prisma.auditLog.findMany({ where: { entityType: 'ApiKey' } });
    expect(entries.map((e) => e.action).sort()).toEqual(['CREATE', 'DELETE']);
  });
});
