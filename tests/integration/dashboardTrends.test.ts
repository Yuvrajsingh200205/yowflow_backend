import { beforeEach, describe, expect, it } from 'vitest';
import { api, base, login } from '../helpers/api';
import { resetDatabase, seedTestOrganization, TestOrg } from '../helpers/factory';

describe('dashboard trends', () => {
  let org: TestOrg;
  beforeEach(async () => { await resetDatabase(); org = await seedTestOrganization(); });

  it('returns aligned month series with money for an admin', async () => {
    const token = await login(org.admin);
    const res = await api().get(`${base}/dashboard/trends?months=6`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.months).toHaveLength(6);
    for (const k of ['revenue', 'expenses', 'leads', 'bookings']) expect(d[k], k).toHaveLength(6);
    expect(d.months[5]).toBe(new Date().toISOString().slice(0, 7));
  });

  it('counts leads created this month', async () => {
    const token = await login(org.admin);
    const before = await api().get(`${base}/dashboard/trends?months=3`).set('Authorization', `Bearer ${token}`);
    for (const name of ['Trend Lead A', 'Trend Lead B']) {
      const created = await api().post(`${base}/leads`).set('Authorization', `Bearer ${token}`).send({ name, phone: '9876543210' });
      expect(created.status).toBe(201);
    }
    const after = await api().get(`${base}/dashboard/trends?months=3`).set('Authorization', `Bearer ${token}`);
    const last = (r: { body: { data: { leads: number[] } } }) => r.body.data.leads[2];
    expect(last(after) - last(before)).toBe(2);
  });

  it('clamps the window and rejects anonymous callers', async () => {
    const token = await login(org.admin);
    const big = await api().get(`${base}/dashboard/trends?months=999`).set('Authorization', `Bearer ${token}`);
    expect(big.body.data.months).toHaveLength(24);
    const small = await api().get(`${base}/dashboard/trends?months=0`).set('Authorization', `Bearer ${token}`);
    expect(small.body.data.months).toHaveLength(3);
    expect((await api().get(`${base}/dashboard/trends`)).status).toBe(401);
  });

  it('hides money series from roles without payment or expense access', async () => {
    const token = await login(org.member);
    const res = await api().get(`${base}/dashboard/trends`).set('Authorization', `Bearer ${token}`);
    if (res.status === 200) {
      expect(res.body.data.revenue).toBeNull();
      expect(res.body.data.expenses).toBeNull();
    } else {
      expect(res.status).toBe(403); // role has no dashboard access at all
    }
  });
});
