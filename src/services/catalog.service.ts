import { CatalogItemKind, Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { AuthContext } from '../types';
import { conflict, notFound } from '../utils/errors';
import { AuditRequestContext, recordAudit } from './audit.service';
import { addDefaultKit } from './templateLibrary.service';

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
  // Editing an item means the studio has looked at it: its price is no longer just an example.
  const item = await prisma.catalogItem.update({ where: { id }, data: { ...rest, eventTypes: rest.eventTypes as never, isExample: false } });
  await recordAudit(prisma, ctx, { action: 'UPDATE', entityType: 'CatalogItem', entityId: id, summary: `Catalogue item “${item.name}” updated`, oldData: { unitPrice: Number(existing.unitPrice), isActive: existing.isActive }, newData: { unitPrice: Number(item.unitPrice), isActive: item.isActive } });
  return present(item);
}

export async function deleteCatalogItem(auth: AuthContext, id: string, ctx: AuditRequestContext) {
  const item = await requireItem(auth.organizationId, id);
  // Quotes keep their own copy of name and price, so removing an item never changes a quote already sent.
  await prisma.catalogItem.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: auth.userId, isActive: false, isPublic: false } });
  await recordAudit(prisma, ctx, { action: 'SOFT_DELETE', entityType: 'CatalogItem', entityId: id, summary: `Catalogue item “${item.name}” removed` });
}

/** The default set (the most common packages and add-ons), for a studio that has not set up anything yet. */
export async function seedStarterCatalog(auth: AuthContext, ctx: AuditRequestContext) {
  const existing = await prisma.catalogItem.count({ where: { organizationId: auth.organizationId, deletedAt: null } });
  if (existing > 0) throw conflict('Your catalogue already has items. Add or edit them instead.');
  const { added } = await addDefaultKit(prisma, auth.organizationId, auth.userId);
  await recordAudit(prisma, ctx, { action: 'CREATE', entityType: 'CatalogItem', summary: `Starter catalogue created (${added} items)` });
  return listCatalog(auth.organizationId, {});
}
