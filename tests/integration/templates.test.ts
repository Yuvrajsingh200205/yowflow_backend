import { beforeEach, describe, expect, it } from 'vitest';
import { api, authed, base, login } from '../helpers/api';
import { prisma, resetDatabase, seedTestOrganization, TestOrg } from '../helpers/factory';
import { DEFAULT_KIT_KEYS, TEMPLATE_GROUPS, TEMPLATE_ITEMS } from '../../src/data/quoteTemplates';
import { ymdPlus } from '../helpers/sales';

describe('ready-made templates and quick quotes', () => {
  let org: TestOrg;
  let staff: ReturnType<typeof authed>;
  beforeEach(async () => {
    await resetDatabase();
    org = await seedTestOrganization('tpl-studio');
    staff = authed(await login(org.admin));
  });

  describe('the library', () => {
    it('is well formed: unique keys, every item in a real group, sensible prices and quantities', () => {
      const keys = TEMPLATE_ITEMS.map((t) => t.key);
      expect(new Set(keys).size).toBe(keys.length);
      const groups = new Set(TEMPLATE_GROUPS.map((g) => g.id));
      for (const t of TEMPLATE_ITEMS) {
        expect(groups.has(t.group), t.key).toBe(true);
        expect(t.unitPrice, t.key).toBeGreaterThan(0);
        expect((t.minQuantity ?? 1) <= (t.maxQuantity ?? 9999), t.key).toBe(true);
        if (t.allowQuantity) expect(t.pricingType ?? 'FIXED', t.key).toBe('FIXED');
        if (t.kind === 'PACKAGE') expect(t.inclusions?.length ?? 0, t.key).toBeGreaterThan(0);
      }
      expect(TEMPLATE_ITEMS.filter((t) => t.kind === 'PACKAGE').length).toBeGreaterThanOrEqual(25);
      expect(DEFAULT_KIT_KEYS.length).toBeGreaterThanOrEqual(10);
    });

    it('lists every template with what the studio already has, and adds the chosen ones once', async () => {
      const before = await staff.get(`${base}/catalog/templates`).expect(200);
      expect(before.body.data.groups.length).toBe(TEMPLATE_GROUPS.length);
      expect(before.body.data.items.every((i: { added: boolean }) => !i.added)).toBe(true);

      const keys = ['wedding-signature', 'prewedding-photo', 'addon-drone'];
      const first = await staff.post(`${base}/catalog/templates/import`).send({ keys }).expect(201);
      expect(first.body.data).toEqual({ added: 3, skipped: 0 });
      const again = await staff.post(`${base}/catalog/templates/import`).send({ keys: [...keys, 'birthday-party'] }).expect(201);
      expect(again.body.data).toEqual({ added: 1, skipped: 3 });

      const items = (await staff.get(`${base}/catalog`)).body.data as Array<{ name: string; kind: string; isExample: boolean; templateKey: string; category: string; eventTypes: string[]; unitPrice: number }>;
      expect(items).toHaveLength(4);
      const signature = items.find((i) => i.templateKey === 'wedding-signature')!;
      expect(signature).toMatchObject({ name: 'Wedding Signature', kind: 'PACKAGE', isExample: true, category: 'Wedding', unitPrice: 85000 });
      expect(signature.eventTypes).toEqual(['WEDDING', 'COMPLETE_WEDDING_SERVICES']);
      expect(items.find((i) => i.templateKey === 'addon-drone')!.eventTypes).toEqual([]);

      const after = await staff.get(`${base}/catalog/templates`).expect(200);
      expect(after.body.data.items.filter((i: { added: boolean }) => i.added).map((i: { key: string }) => i.key).sort()).toEqual([...keys, 'birthday-party'].sort());
    });

    it('rejects unknown templates and an empty choice, and needs the manage permission to add', async () => {
      expect((await staff.post(`${base}/catalog/templates/import`).send({ keys: ['no-such-template'] })).status).toBe(400);
      expect((await staff.post(`${base}/catalog/templates/import`).send({ keys: [] })).status).toBe(400);
      expect((await api().get(`${base}/catalog/templates`)).status).toBe(401);
      const manager = authed(await login(org.manager)); // managers run the price list
      expect((await manager.get(`${base}/catalog/templates`)).status).toBe(200);
      expect((await manager.post(`${base}/catalog/templates/import`).send({ keys: ['wedding-signature'] })).status).toBe(201);
      const member = authed(await login(org.member)); // the rest of the team has no say in prices
      expect((await member.get(`${base}/catalog/templates`)).status).toBe(403);
      expect((await member.post(`${base}/catalog/templates/import`).send({ keys: ['wedding-signature'] })).status).toBe(403);
      expect((await member.post(`${base}/catalog/templates/confirm-prices`)).status).toBe(403);
    });

    it('remembers where an item came from, even after the studio renames it', async () => {
      await staff.post(`${base}/catalog/templates/import`).send({ keys: ['wedding-signature'] }).expect(201);
      const item = (await staff.get(`${base}/catalog`)).body.data[0];
      await staff.patch(`${base}/catalog/${item.id}`).send({ name: 'Gold Wedding' }).expect(200);
      const lib = (await staff.get(`${base}/catalog/templates`)).body.data.items.find((i: { key: string }) => i.key === 'wedding-signature');
      expect(lib.added).toBe(true);
      expect((await staff.post(`${base}/catalog/templates/import`).send({ keys: ['wedding-signature'] })).body.data).toEqual({ added: 0, skipped: 1 });
    });

    it('keeps one studio’s price list out of another’s', async () => {
      await staff.post(`${base}/catalog/templates/import`).send({ keys: ['wedding-signature'] }).expect(201);
      const other = authed(await login((await seedTestOrganization('tpl-other')).admin));
      expect((await other.get(`${base}/catalog`)).body.data).toHaveLength(0);
      expect((await other.get(`${base}/catalog/templates`)).body.data.items.some((i: { added: boolean }) => i.added)).toBe(false);
    });
  });

  describe('example prices', () => {
    it('are flagged on import, cleared by editing an item, and cleared for everything by confirming', async () => {
      await staff.post(`${base}/catalog/templates/import`).send({ keys: ['wedding-signature', 'wedding-essentials', 'addon-drone'] }).expect(201);
      expect((await staff.get(`${base}/sales-setup/readiness`)).body.data).toMatchObject({ packages: 2, addons: 1, examplePrices: 3 });

      const items = (await staff.get(`${base}/catalog`)).body.data as Array<{ id: string; templateKey: string }>;
      const essentials = items.find((i) => i.templateKey === 'wedding-essentials')!;
      const edited = await staff.patch(`${base}/catalog/${essentials.id}`).send({ unitPrice: 41000 }).expect(200);
      expect(edited.body.data).toMatchObject({ unitPrice: 41000, isExample: false });
      expect((await staff.get(`${base}/sales-setup/readiness`)).body.data.examplePrices).toBe(2);

      const confirmed = await staff.post(`${base}/catalog/templates/confirm-prices`).expect(200);
      expect(confirmed.body.data.confirmed).toBe(2);
      expect((await staff.get(`${base}/sales-setup/readiness`)).body.data.examplePrices).toBe(0);
    });

    it('describe how ready the studio is to quote', async () => {
      const empty = (await staff.get(`${base}/sales-setup/readiness`)).body.data;
      expect(empty).toMatchObject({ packages: 0, addons: 0, examplePrices: 0, paymentDetails: false, bookingPageOn: false, slug: 'tpl-studio' });
      await staff.put(`${base}/sales-setup/settings`).send({ upiId: 'studio@okbank', phone: '+91 98765 43210' }).expect(200);
      await staff.put(`${base}/sales-setup/enquiry-page`).send({ isEnabled: true }).expect(200);
      expect((await staff.get(`${base}/sales-setup/readiness`)).body.data).toMatchObject({ paymentDetails: true, businessPhone: true, bookingPageOn: true });
    });

    it('the starter set is the default kit and is added only to an empty price list', async () => {
      const seeded = await staff.post(`${base}/catalog/starter`).expect(201);
      expect(seeded.body.data).toHaveLength(DEFAULT_KIT_KEYS.length);
      expect(seeded.body.data.every((i: { isExample: boolean }) => i.isExample)).toBe(true);
      expect((await staff.post(`${base}/catalog/starter`)).status).toBe(409);
    });

    it('a brand-new studio starts with the default kit already in its price list', async () => {
      await api().post(`${base}/auth/signup`).send({ studioName: 'Fresh Frames', fullName: 'Neha Verma', email: 'neha@fresh.test', password: 'Sup3rSecret!x' }).expect(201);
      const orgRow = await prisma.organization.findFirstOrThrow({ where: { slug: 'fresh-frames' } });
      const items = await prisma.catalogItem.findMany({ where: { organizationId: orgRow.id } });
      expect(items).toHaveLength(DEFAULT_KIT_KEYS.length);
      expect(items.every((i) => i.isExample)).toBe(true);
      expect(items.some((i) => i.kind === 'PACKAGE' && i.eventTypes.includes('PRE_WEDDING'))).toBe(true);
    });
  });

  describe('quick quote', () => {
    let packageId: string;
    let addonId: string;
    beforeEach(async () => {
      await staff.post(`${base}/catalog/templates/import`).send({ keys: ['wedding-signature', 'addon-drone'] }).expect(201);
      const items = (await staff.get(`${base}/catalog`)).body.data as Array<{ id: string; kind: string }>;
      packageId = items.find((i) => i.kind === 'PACKAGE')!.id;
      addonId = items.find((i) => i.kind === 'ADDON')!.id;
    });
    const body = (over: Record<string, unknown> = {}) => ({ name: 'Riya Kapoor', phone: '+91 98123 45678', eventType: 'WEDDING', eventDate: ymdPlus(90), eventDays: 2, packageId, ...over });

    it('turns a name, a mobile number and a package into a lead and a priced draft quote', async () => {
      const res = await staff.post(`${base}/quotations/quick`).send(body({ addonIds: [addonId] })).expect(201);
      // 85,000 x 2 days + 12,000 drone = 1,82,000 plus 18% GST
      expect(res.body.data).toMatchObject({ grandTotal: 214760, status: 'DRAFT', reusedLead: false });
      const lead = await prisma.lead.findFirstOrThrow({ where: { id: res.body.data.leadId }, include: { source: true } });
      expect(lead).toMatchObject({ name: 'Riya Kapoor', phone: '9812345678', eventType: 'WEDDING', status: 'NEW', ownerId: org.admin.id });
      expect(lead.source?.name).toBe('Quick quote');
      const quote = await prisma.quotation.findFirstOrThrow({ where: { id: res.body.data.id }, include: { items: true } });
      expect(quote.leadId).toBe(lead.id);
      expect(quote.items.find((i) => i.kind === 'ADDON' && i.service === 'Drone coverage')?.isSelected).toBe(true);
    });

    it('can price a quote by hand when no package fits', async () => {
      const res = await staff.post(`${base}/quotations/quick`).send({ name: 'Walk-in Customer', phone: '9811100022', packageId: null, custom: { service: 'Birthday shoot, 2 hours', unitPrice: 6000, taxRate: 18 } }).expect(201);
      expect(res.body.data.grandTotal).toBe(7080);
      const items = await prisma.quotationItem.findMany({ where: { quotationId: res.body.data.id } });
      expect(items.map((i) => [i.service, i.kind])).toEqual([['Birthday shoot, 2 hours', 'CUSTOM']]);
      expect((await staff.post(`${base}/quotations/quick`).send({ name: 'Walk-in Customer', phone: '9811100022' })).status).toBe(400);
    });

    it('reuses the open lead for the same person and date instead of piling up duplicates', async () => {
      const first = await staff.post(`${base}/quotations/quick`).send(body()).expect(201);
      const second = await staff.post(`${base}/quotations/quick`).send(body({ phone: '9812345678', packageId })).expect(201);
      expect(second.body.data.leadId).toBe(first.body.data.leadId);
      expect(second.body.data.reusedLead).toBe(true);
      expect(await prisma.lead.count({ where: { organizationId: org.organizationId } })).toBe(1);
      expect(await prisma.quotation.count({ where: { organizationId: org.organizationId } })).toBe(2);
    });

    it('works without an event date, and explains what is wrong when the details are not right', async () => {
      expect((await staff.post(`${base}/quotations/quick`).send(body({ eventDate: null, eventType: null })).expect(201)).body.data.grandTotal).toBeGreaterThan(0);
      const bad = await staff.post(`${base}/quotations/quick`).send(body({ phone: '12345' }));
      expect(bad.status).toBe(400);
      expect(JSON.stringify(bad.body)).toMatch(/valid 10-digit mobile number/);
      expect((await staff.post(`${base}/quotations/quick`).send(body({ name: '' }))).status).toBe(400);
      expect((await staff.post(`${base}/quotations/quick`).send({ ...body(), packageId: undefined })).status).toBe(400);
      expect((await staff.post(`${base}/quotations/quick`).send(body({ packageId: '00000000-0000-4000-8000-000000000000' }))).status).toBe(404);
    });

    it('cannot use another studio’s package, and needs a signed-in user who may quote', async () => {
      const other = authed(await login((await seedTestOrganization('tpl-other2')).admin));
      expect((await other.post(`${base}/quotations/quick`).send(body())).status).toBe(404);
      expect((await api().post(`${base}/quotations/quick`).send(body())).status).toBe(401);
    });
  });
});
