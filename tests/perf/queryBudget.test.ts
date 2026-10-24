import { beforeAll, describe, expect, it } from 'vitest';
import { api, base, login } from '../helpers/api';
import { resetDatabase, seedTestOrganization, TestOrg } from '../helpers/factory';
import { queryStats } from '../../src/config/prisma';

/**
 * Every SQL statement is a network round trip to the database (≈1–360 ms depending on region),
 * so each endpoint gets a hard budget. A change that adds queries to a hot path fails here
 * instead of silently making the product slower.
 */
const BUDGET: Array<[string, number]> = [
  ['/auth/me', 2],
  ['/dashboard/summary', 12],
  ['/dashboard/trends?months=8', 6],
  ['/billing', 4],
  ['/notifications', 4],
  ['/leads?limit=25', 5],
  ['/clients?limit=25', 5],
  ['/projects?limit=25', 6],
  ['/shoots?limit=25', 6],
  ['/settings/workspace', 8],
  ['/settings/members', 3],
  ['/freelancers?limit=25', 6],
  ['/quotations?limit=25', 5],
  ['/quotations/today', 6],
  ['/catalog', 3],
  ['/sales-setup/settings', 4],
  ['/sales-setup/enquiry-page', 4],
];

describe('query budget (set PRISMA_COUNT_QUERIES=1)', () => {
  let token = '';
  beforeAll(async () => {
    await resetDatabase();
    const org: TestOrg = await seedTestOrganization();
    token = await login(org.admin);
  });

  it.skipIf(process.env.PRISMA_COUNT_QUERIES !== '1')('keeps hot endpoints within their query budget', async () => {
    const rows: string[] = [];
    const over: string[] = [];
    for (const [path, max] of BUDGET) {
      await api().get(`${base}${path}`).set('Authorization', `Bearer ${token}`); // warm
      queryStats.count = 0;
      const res = await api().get(`${base}${path}`).set('Authorization', `Bearer ${token}`);
      rows.push(`${String(queryStats.count).padStart(3)} / ${String(max).padEnd(3)} ${res.status} ${path}`);
      if (queryStats.count > max) over.push(`${path}: ${queryStats.count} > ${max}`);
    }
    console.warn('\nqueries/budget status path\n' + rows.join('\n'));
    expect(over).toEqual([]);
  });
});
