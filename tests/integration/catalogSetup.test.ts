import { beforeEach, describe, expect, it } from 'vitest';
import { api, authed, base, login } from '../helpers/api';
import { prisma, resetDatabase, seedTestOrganization } from '../helpers/factory';
import { seedSalesStudio, SalesFixture, ymdPlus } from '../helpers/sales';

describe('catalogue and sales setup', () => {
  let f: SalesFixture;
  beforeEach(async () => { await resetDatabase(); f = await seedSalesStudio(); });

  it('creates, lists, edits and removes packages and add-ons, rejecting bad prices and duplicates', async () => {
    const list = await f.staff.get(`${base}/catalog`).expect(200);
    expect(list.body.data.map((i: { name: string }) => i.name).sort()).toEqual(['Drone', 'Extra album', 'Signature']);
    expect(list.body.data.find((i: { name: string }) => i.name === 'Signature')).toMatchObject({ unitPrice: 50000, taxRate: 18, pricingType: 'PER_DAY', kind: 'PACKAGE' });

    expect((await f.staff.post(`${base}/catalog`).send({ kind: 'PACKAGE', name: 'signature', unitPrice: 1 })).status).toBe(409); // same name, any case
    expect((await f.staff.post(`${base}/catalog`).send({ kind: 'PACKAGE', name: 'Bad', unitPrice: -5 })).status).toBe(400);
    expect((await f.staff.post(`${base}/catalog`).send({ kind: 'PACKAGE', name: 'Bad tax', unitPrice: 5, taxRate: 140 })).status).toBe(400);
    expect((await f.staff.post(`${base}/catalog`).send({ kind: 'PACKAGE', name: 'Qty package', unitPrice: 5, allowQuantity: true })).status).toBe(400);
    expect((await f.staff.post(`${base}/catalog`).send({ kind: 'ADDON', name: 'Per day qty', unitPrice: 5, pricingType: 'PER_DAY', allowQuantity: true })).status).toBe(400);
    expect((await f.staff.post(`${base}/catalog`).send({ kind: 'ADDON', name: 'Range', unitPrice: 5, allowQuantity: true, minQuantity: 5, maxQuantity: 2 })).status).toBe(400);

    const patched = await f.staff.patch(`${base}/catalog/${f.addonId}`).send({ unitPrice: 12500, isPopular: true }).expect(200);
    expect(patched.body.data).toMatchObject({ unitPrice: 12500, isPopular: true, kind: 'ADDON' });
    await f.staff.delete(`${base}/catalog/${f.addonId}`).expect(204);
    expect((await f.staff.get(`${base}/catalog?kind=ADDON`)).body.data.map((i: { name: string }) => i.name)).toEqual(['Extra album']);
    expect((await f.staff.patch(`${base}/catalog/${f.addonId}`).send({ unitPrice: 1 })).status).toBe(404);
  });

  it('offers a starter catalogue exactly once, and keeps every studio’s price list private', async () => {
    const fresh = await seedTestOrganization('other-studio');
    const other = authed(await login(fresh.admin));
    const seeded = await other.post(`${base}/catalog/starter`).expect(201);
    expect(seeded.body.data.length).toBeGreaterThanOrEqual(6);
    expect((await other.post(`${base}/catalog/starter`)).status).toBe(409);
    // this studio never sees the other studio's items, and cannot edit them
    expect((await f.staff.get(`${base}/catalog`)).body.data).toHaveLength(3);
    expect((await f.staff.patch(`${base}/catalog/${seeded.body.data[0].id}`).send({ unitPrice: 1 })).status).toBe(404);
  });

  it('needs the right permission to manage prices, but lets quote writers read them', async () => {
    const member = authed(await login(f.org.member));
    expect((await member.post(`${base}/catalog`).send({ kind: 'ADDON', name: 'X', unitPrice: 1 })).status).toBe(403);
    expect((await member.get(`${base}/catalog`)).status).toBe(403);
    expect((await api().get(`${base}/catalog`)).status).toBe(401);
    const manager = authed(await login(f.org.manager));
    expect((await manager.get(`${base}/catalog`)).status).toBe(200);
    expect((await manager.post(`${base}/catalog`).send({ kind: 'ADDON', name: 'Manager item', unitPrice: 10 })).status).toBe(201);
  });

  it('saves business details, sales defaults, availability rules and reminders, validating what is printed on documents', async () => {
    const saved = await f.staff.put(`${base}/sales-setup/settings`).send({
      upiId: 'studio@okbank', bankAccountName: 'Test Studio', bankName: 'HDFC Bank', bankAccountNumber: '123456789012', bankIfsc: 'hdfc0001234',
      gstNumber: '27ABCDE1234F1Z5', defaultTerms: '50% advance is non-refundable.', brandColor: '#112233',
      quoteValidDays: 10, advancePercent: 40, balanceDueDaysBefore: 5, capacityPerDay: 2, minLeadDays: 3, maxAdvanceDays: 365, remindersEnabled: false,
    }).expect(200);
    expect(saved.body.data).toMatchObject({ upiId: 'studio@okbank', bankIfsc: 'HDFC0001234', quoteValidDays: 10, advancePercent: 40, capacityPerDay: 2, remindersEnabled: false, brandColor: '#112233' });
    expect(saved.body.data.business.gstNumber).toBe('27ABCDE1234F1Z5');
    expect((await f.staff.get(`${base}/sales-setup/settings`)).body.data.defaultTerms).toBe('50% advance is non-refundable.');

    for (const bad of [{ upiId: 'not a upi' }, { bankIfsc: 'XYZ' }, { bankAccountNumber: 'abc' }, { gstNumber: '123' }, { brandColor: 'red' }, { advancePercent: 120 }, { capacityPerDay: 0 }, { unknown: 1 }]) {
      expect((await f.staff.put(`${base}/sales-setup/settings`).send(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    // the studio's contact details are edited here too, and printed on quotes and invoices
    const contact = await f.staff.put(`${base}/sales-setup/settings`).send({
      phone: '+91 98765 43210', email: 'Hello@Lumen.test', website: 'https://lumen.test', addressLine: '12, MG Road', city: 'Pune', state: 'Maharashtra', postalCode: '411001',
    }).expect(200);
    expect(contact.body.data.business).toMatchObject({ phone: '+91 98765 43210', email: 'hello@lumen.test', website: 'https://lumen.test', addressLine: '12, MG Road', city: 'Pune', state: 'Maharashtra', postalCode: '411001' });
    for (const bad of [{ phone: 'call me' }, { email: 'nope' }, { website: 'lumen.test' }, { postalCode: '1'.repeat(17) }]) {
      expect((await f.staff.put(`${base}/sales-setup/settings`).send(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    await f.staff.put(`${base}/sales-setup/settings`).send({ website: '', addressLine: '' }).expect(200);
    expect((await f.staff.get(`${base}/sales-setup/settings`)).body.data.business).toMatchObject({ website: null, addressLine: null, city: 'Pune' });

    // blanking a field clears it
    await f.staff.put(`${base}/sales-setup/settings`).send({ upiId: '' }).expect(200);
    expect((await f.staff.get(`${base}/sales-setup/settings`)).body.data.upiId).toBeNull();
    expect((await authed(await login(f.org.member)).put(`${base}/sales-setup/settings`).send({ advancePercent: 10 })).status).toBe(403);
  });

  it('manages the enquiry page and closed dates', async () => {
    const page = await f.staff.get(`${base}/sales-setup/enquiry-page`).expect(200);
    expect(page.body.data).toMatchObject({ slug: 'test-studio', isEnabled: true, autoQuoteMode: 'APPROVAL' });
    const updated = await f.staff.put(`${base}/sales-setup/enquiry-page`).send({ headline: 'Book Test Studio', autoQuoteMode: 'AUTO', showPrices: false, eventTypes: ['WEDDING', 'ENGAGEMENT'] }).expect(200);
    expect(updated.body.data).toMatchObject({ headline: 'Book Test Studio', autoQuoteMode: 'AUTO', showPrices: false, eventTypes: ['WEDDING', 'ENGAGEMENT'] });
    expect((await f.staff.put(`${base}/sales-setup/enquiry-page`).send({ autoQuoteMode: 'MAGIC' })).status).toBe(400);

    const block = await f.staff.post(`${base}/sales-setup/blocked-dates`).send({ startDate: ymdPlus(40), endDate: ymdPlus(42), reason: 'Family wedding' }).expect(201);
    expect((await f.staff.get(`${base}/sales-setup/blocked-dates`)).body.data).toHaveLength(1);
    expect((await f.staff.post(`${base}/sales-setup/blocked-dates`).send({ startDate: ymdPlus(5), endDate: ymdPlus(1) })).status).toBe(400);
    await f.staff.delete(`${base}/sales-setup/blocked-dates/${block.body.data.id}`).expect(204);
    expect((await f.staff.get(`${base}/sales-setup/blocked-dates`)).body.data).toHaveLength(0);
    expect(await prisma.blockedDate.count()).toBe(0);
  });

  describe('availability', () => {
    const projectOn = async (date: string, status: 'UPCOMING' | 'CANCELLED' | 'LEAD' = 'UPCOMING') => {
      const client = await prisma.client.create({ data: { organizationId: f.org.organizationId, clientCode: `CLI-T${Math.random().toString(36).slice(2, 7)}`, displayName: 'Booked Couple', primaryPhone: '9000000001' } });
      return prisma.project.create({ data: { organizationId: f.org.organizationId, clientId: client.id, projectNumber: `PRJ-T${Math.random().toString(36).slice(2, 7)}`, name: 'Booked wedding', status, weddingDate: new Date(`${date}T00:00:00Z`) } });
    };
    const day = async (date: string) => (await f.staff.get(`${base}/sales-setup/availability?from=${date}&to=${date}`).expect(200)).body.data.days[0];

    it('marks a date full once capacity is reached, ignores cancelled and lead-stage projects, and shows staff who holds it', async () => {
      const d = ymdPlus(70);
      expect((await day(d)).status).toBe('AVAILABLE');
      await projectOn(d, 'CANCELLED'); await projectOn(d, 'LEAD');
      expect((await day(d)).status).toBe('AVAILABLE');
      const booked = await projectOn(d);
      const info = await day(d);
      expect(info).toMatchObject({ status: 'FULL', booked: 1, capacity: 1 });
      expect(info.bookings[0].name).toBe('Booked wedding');
      // with room for two events a day it is merely limited
      await f.staff.put(`${base}/sales-setup/settings`).send({ capacityPerDay: 2 }).expect(200);
      expect((await day(d)).status).toBe('LIMITED');
      await projectOn(d);
      expect((await day(d)).status).toBe('FULL');
      // a project can be moved without clashing with itself
      const check = await f.staff.get(`${base}/sales-setup/availability/check?date=${d}&excludeProjectId=${booked.id}`).expect(200);
      expect(check.body.data.sellable).toBe(true);
    });

    it('closes blocked dates and applies lead-time and booking-window rules', async () => {
      await f.staff.post(`${base}/sales-setup/blocked-dates`).send({ startDate: ymdPlus(50), endDate: ymdPlus(51), reason: 'Holiday' });
      expect((await day(ymdPlus(51)))).toMatchObject({ status: 'CLOSED', closedReason: 'Holiday' });
      await f.staff.put(`${base}/sales-setup/settings`).send({ minLeadDays: 10, maxAdvanceDays: 100 }).expect(200);
      expect((await day(ymdPlus(3))).status).toBe('TOO_SOON');
      expect((await day(ymdPlus(200))).status).toBe('TOO_FAR');
      expect((await day(ymdPlus(30))).status).toBe('AVAILABLE');
      expect((await day(ymdPlus(-3))).status).toBe('PAST');
    });

    it('rejects absurd ranges, bad dates and other studios’ data', async () => {
      expect((await f.staff.get(`${base}/sales-setup/availability?from=${ymdPlus(0)}&to=${ymdPlus(500)}`)).status).toBe(400);
      expect((await f.staff.get(`${base}/sales-setup/availability?from=${ymdPlus(5)}&to=${ymdPlus(1)}`)).status).toBe(400);
      expect((await f.staff.get(`${base}/sales-setup/availability?from=nope&to=nope`)).status).toBe(400);
      const d = ymdPlus(80);
      await projectOn(d);
      const other = authed(await login((await seedTestOrganization('studio-two')).admin));
      expect((await other.get(`${base}/sales-setup/availability?from=${d}&to=${d}`)).body.data.days[0].status).toBe('AVAILABLE');
    });
  });
});
