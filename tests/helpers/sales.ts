import { authed, base, login } from './api';
import { prisma, seedTestOrganization, TestOrg } from './factory';

export const ymdPlus = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

export interface SalesFixture {
  org: TestOrg;
  staff: ReturnType<typeof authed>;
  token: string;
  slug: string;
  packageId: string;
  addonId: string;
  quantityAddonId: string;
}

/** A studio with a small catalogue, the enquiry page switched on, and an admin signed in. */
export async function seedSalesStudio(opts: { slug?: string; mode?: 'OFF' | 'APPROVAL' | 'AUTO'; capacity?: number } = {}): Promise<SalesFixture> {
  const slug = opts.slug ?? 'test-studio';
  const org = await seedTestOrganization(slug);
  const token = await login(org.admin);
  const staff = authed(token);
  const pkg = await staff.post(`${base}/catalog`).send({ kind: 'PACKAGE', name: 'Signature', unitPrice: 50000, pricingType: 'PER_DAY', unitLabel: 'day', taxRate: 18, inclusions: ['2 photographers', 'Highlight film'] }).expect(201);
  const addon = await staff.post(`${base}/catalog`).send({ kind: 'ADDON', name: 'Drone', unitPrice: 10000, taxRate: 18 }).expect(201);
  const qtyAddon = await staff.post(`${base}/catalog`).send({ kind: 'ADDON', name: 'Extra album', unitPrice: 5000, taxRate: 18, allowQuantity: true, minQuantity: 1, maxQuantity: 4, unitLabel: 'copy' }).expect(201);
  await staff.put(`${base}/sales-setup/enquiry-page`).send({ isEnabled: true, autoQuoteMode: opts.mode ?? 'APPROVAL' }).expect(200);
  if (opts.capacity) await staff.put(`${base}/sales-setup/settings`).send({ capacityPerDay: opts.capacity }).expect(200);
  return { org, staff, token, slug, packageId: pkg.body.data.id, addonId: addon.body.data.id, quantityAddonId: qtyAddon.body.data.id };
}

export const enquiryBody = (f: SalesFixture, over: Record<string, unknown> = {}) => ({
  name: 'Aarav Sharma', phone: '9812345678', email: 'aarav@example.test', eventType: 'WEDDING', eventDate: ymdPlus(90), eventDays: 2, guestCount: 300,
  venueCity: 'Jaipur', packageId: f.packageId, addonIds: [f.addonId], notes: 'Evening ceremony', consent: true, ...over,
});

export { prisma };
