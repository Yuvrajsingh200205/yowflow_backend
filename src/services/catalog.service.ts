import { CatalogItemKind, Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { AuthContext } from '../types';
import { conflict, notFound } from '../utils/errors';
import { AuditRequestContext, recordAudit } from './audit.service';

/** The studio's price list: packages and add-ons that quotes are assembled from. */

export interface CatalogInput {
  kind: CatalogItemKind;
  name: string;
  description?: string | null;
  category?: string | null;
  inclusions?: string[];
  pricingType?: 'FIXED' | 'PER_DAY' | 'PER_PERSON';
  unitPrice: number;
  unitLabel?: string | null;
  taxRate?: number;
  allowQuantity?: boolean;
  minQuantity?: number;
  maxQuantity?: number | null;
  eventTypes?: string[];
  isActive?: boolean;
  isPublic?: boolean;
  isPopular?: boolean;
  sortOrder?: number;
}

const present = (i: Prisma.CatalogItemGetPayload<object>) => ({ ...i, unitPrice: Number(i.unitPrice), taxRate: Number(i.taxRate), createdById: undefined, deletedBy: undefined, deletedAt: undefined });

export async function listCatalog(organizationId: string, q: { kind?: CatalogItemKind; active?: 'true' | 'false'; search?: string }) {
  const items = await prisma.catalogItem.findMany({
    where: {
      organizationId, deletedAt: null,
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.active ? { isActive: q.active === 'true' } : {}),
      ...(q.search ? { name: { contains: q.search, mode: 'insensitive' as const } } : {}),
    },
    orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  return items.map(present);
}

async function requireItem(organizationId: string, id: string) {
  const item = await prisma.catalogItem.findFirst({ where: { id, organizationId, deletedAt: null } });
  if (!item) throw notFound('Catalogue item');
  return item;
}

export async function createCatalogItem(auth: AuthContext, input: CatalogInput, ctx: AuditRequestContext) {
  const clash = await prisma.catalogItem.findFirst({ where: { organizationId: auth.organizationId, deletedAt: null, kind: input.kind, name: { equals: input.name, mode: 'insensitive' } }, select: { id: true } });
  if (clash) throw conflict(`You already have a ${input.kind === 'PACKAGE' ? 'package' : 'add-on'} called “${input.name}”.`);
  const item = await prisma.catalogItem.create({
    data: {
      organizationId: auth.organizationId, createdById: auth.userId, kind: input.kind, name: input.name, description: input.description ?? null, category: input.category ?? null,
      inclusions: input.inclusions ?? [], pricingType: input.pricingType ?? 'FIXED', unitPrice: input.unitPrice, unitLabel: input.unitLabel ?? null, taxRate: input.taxRate ?? 0,
      allowQuantity: input.allowQuantity ?? false, minQuantity: input.minQuantity ?? 1, maxQuantity: input.maxQuantity ?? null,
      eventTypes: (input.eventTypes ?? []) as never, isActive: input.isActive ?? true, isPublic: input.isPublic ?? true, isPopular: input.isPopular ?? false, sortOrder: input.sortOrder ?? 0,
    },
  });
  await recordAudit(prisma, ctx, { action: 'CREATE', entityType: 'CatalogItem', entityId: item.id, summary: `Catalogue ${input.kind.toLowerCase()} “${item.name}” created` });
  return present(item);
}

export async function updateCatalogItem(auth: AuthContext, id: string, input: Partial<CatalogInput>, ctx: AuditRequestContext) {
  const existing = await requireItem(auth.organizationId, id);
  const next = { ...existing, ...input };
  if (next.maxQuantity != null && next.maxQuantity < (next.minQuantity ?? 1)) throw conflict('The maximum quantity cannot be below the minimum.');
  if (input.name && input.name.toLowerCase() !== existing.name.toLowerCase()) {
    const clash = await prisma.catalogItem.findFirst({ where: { organizationId: auth.organizationId, deletedAt: null, kind: existing.kind, id: { not: id }, name: { equals: input.name, mode: 'insensitive' } }, select: { id: true } });
    if (clash) throw conflict(`You already have an item called “${input.name}”.`);
  }
  const { kind: _kind, ...rest } = input;
  void _kind; // an item never changes between package and add-on
  const item = await prisma.catalogItem.update({ where: { id }, data: { ...rest, eventTypes: rest.eventTypes as never } });
  await recordAudit(prisma, ctx, { action: 'UPDATE', entityType: 'CatalogItem', entityId: id, summary: `Catalogue item “${item.name}” updated`, oldData: { unitPrice: Number(existing.unitPrice), isActive: existing.isActive }, newData: { unitPrice: Number(item.unitPrice), isActive: item.isActive } });
  return present(item);
}

export async function deleteCatalogItem(auth: AuthContext, id: string, ctx: AuditRequestContext) {
  const item = await requireItem(auth.organizationId, id);
  // Quotes keep their own copy of name and price, so removing an item never changes a quote already sent.
  await prisma.catalogItem.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: auth.userId, isActive: false, isPublic: false } });
  await recordAudit(prisma, ctx, { action: 'SOFT_DELETE', entityType: 'CatalogItem', entityId: id, summary: `Catalogue item “${item.name}” removed` });
}

/** A sensible first catalogue for a photography and film studio, so nobody starts from a blank page. */
const STARTER: CatalogInput[] = [
  { kind: 'PACKAGE', name: 'Wedding Essentials', category: 'Photography', description: 'Everything you need to remember the day, beautifully delivered.', unitPrice: 45000, pricingType: 'PER_DAY', unitLabel: 'day', taxRate: 18, sortOrder: 1,
    inclusions: ['1 candid photographer', '1 traditional photographer', '300+ edited photographs', 'Online gallery with private link', 'Delivery in 21 days'] },
  { kind: 'PACKAGE', name: 'Wedding Signature', category: 'Photography + Film', description: 'Photographs and a cinematic highlight film.', unitPrice: 85000, pricingType: 'PER_DAY', unitLabel: 'day', taxRate: 18, isPopular: true, sortOrder: 2,
    inclusions: ['2 candid photographers', '1 traditional photographer', '1 cinematographer', '500+ edited photographs', '4–6 minute highlight film', 'Premium album (30 spreads)', 'Online gallery with private link'] },
  { kind: 'PACKAGE', name: 'Wedding Cinematic', category: 'Photography + Film', description: 'The full production: team, drone, film and album.', unitPrice: 150000, pricingType: 'PER_DAY', unitLabel: 'day', taxRate: 18, sortOrder: 3,
    inclusions: ['3 photographers', '2 cinematographers', 'Drone coverage', '800+ edited photographs', 'Cinematic film (8–10 minutes) + teaser', 'Two premium albums', 'Same-week sneak peeks'] },
  { kind: 'ADDON', name: 'Drone coverage', category: 'Add-ons', description: 'Aerial shots of the venue and baraat.', unitPrice: 12000, taxRate: 18, sortOrder: 1 },
  { kind: 'ADDON', name: 'Pre-wedding shoot', category: 'Add-ons', description: 'Half-day outdoor shoot with 50 edited photographs.', unitPrice: 25000, taxRate: 18, sortOrder: 2 },
  { kind: 'ADDON', name: 'Extra album copy', category: 'Add-ons', description: 'Matching copy for parents (30 spreads).', unitPrice: 8000, taxRate: 18, allowQuantity: true, minQuantity: 1, maxQuantity: 6, unitLabel: 'copy', sortOrder: 3 },
  { kind: 'ADDON', name: 'Same-day edit film', category: 'Add-ons', description: 'A short film played at the reception.', unitPrice: 30000, taxRate: 18, sortOrder: 4 },
  { kind: 'ADDON', name: 'Extra photographer', category: 'Add-ons', description: 'One more photographer for the whole day.', unitPrice: 9000, pricingType: 'PER_DAY', unitLabel: 'day', taxRate: 18, sortOrder: 5 },
];

export async function seedStarterCatalog(auth: AuthContext, ctx: AuditRequestContext) {
  const existing = await prisma.catalogItem.count({ where: { organizationId: auth.organizationId, deletedAt: null } });
  if (existing > 0) throw conflict('Your catalogue already has items. Add or edit them instead.');
  await prisma.catalogItem.createMany({
    data: STARTER.map((i) => ({
      organizationId: auth.organizationId, createdById: auth.userId, kind: i.kind, name: i.name, description: i.description ?? null, category: i.category ?? null, inclusions: i.inclusions ?? [],
      pricingType: i.pricingType ?? 'FIXED', unitPrice: i.unitPrice, unitLabel: i.unitLabel ?? null, taxRate: i.taxRate ?? 0, allowQuantity: i.allowQuantity ?? false,
      minQuantity: i.minQuantity ?? 1, maxQuantity: i.maxQuantity ?? null, isPopular: i.isPopular ?? false, sortOrder: i.sortOrder ?? 0,
    })),
  });
  await recordAudit(prisma, ctx, { action: 'CREATE', entityType: 'CatalogItem', summary: `Starter catalogue created (${STARTER.length} items)` });
  return listCatalog(auth.organizationId, {});
}
