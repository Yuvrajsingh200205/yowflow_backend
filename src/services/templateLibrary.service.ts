import { Prisma } from '@prisma/client';
import { Db, prisma } from '../config/prisma';
import { AuthContext } from '../types';
import { badRequest } from '../utils/errors';
import { DEFAULT_KIT_KEYS, TEMPLATE_GROUPS, TEMPLATE_ITEMS, TemplateItem, groupById, templateByKey } from '../data/quoteTemplates';
import { AuditRequestContext, recordAudit } from './audit.service';

/**
 * The ready-made library: packages and add-ons a studio can add to its own price list with one tap.
 * Added items carry `isExample` until the studio edits them or confirms its prices.
 */

const sortOrderOf = (key: string) => TEMPLATE_ITEMS.findIndex((t) => t.key === key) + 1;

const rowFor = (t: TemplateItem, organizationId: string, createdById: string | null): Prisma.CatalogItemCreateManyInput => {
  const group = groupById.get(t.group)!;
  return {
    organizationId, createdById, kind: t.kind, name: t.name, description: t.description, category: group.label, inclusions: t.inclusions ?? [],
    pricingType: t.pricingType ?? 'FIXED', unitPrice: t.unitPrice, unitLabel: t.unitLabel ?? null, taxRate: t.taxRate ?? 18,
    allowQuantity: t.allowQuantity ?? false, minQuantity: t.minQuantity ?? 1, maxQuantity: t.maxQuantity ?? null,
    eventTypes: t.kind === 'PACKAGE' ? group.eventTypes : [], isActive: true, isPublic: true, isPopular: t.isPopular ?? false,
    isExample: true, templateKey: t.key, sortOrder: sortOrderOf(t.key),
  };
};

/** Adds the chosen templates, skipping anything the studio already has (by template or by name). Returns how many were new. */
export async function addTemplates(db: Db, organizationId: string, createdById: string | null, keys: string[]): Promise<{ added: number; skipped: number }> {
  const wanted = [...new Set(keys)].map((k) => templateByKey.get(k));
  if (wanted.some((t) => !t)) throw badRequest('One of those templates does not exist any more. Reload the list and try again.');
  const items = wanted as TemplateItem[];
  const existing = await db.catalogItem.findMany({ where: { organizationId, deletedAt: null }, select: { kind: true, name: true, templateKey: true } });
  const have = (t: TemplateItem) => existing.some((e) => e.templateKey === t.key || (e.kind === t.kind && e.name.toLowerCase() === t.name.toLowerCase()));
  const fresh = items.filter((t) => !have(t));
  if (fresh.length) await db.catalogItem.createMany({ data: fresh.map((t) => rowFor(t, organizationId, createdById)) });
  return { added: fresh.length, skipped: items.length - fresh.length };
}

/** What every new studio starts with: the most common packages and add-ons across occasions. */
export const addDefaultKit = (db: Db, organizationId: string, createdById: string | null) => addTemplates(db, organizationId, createdById, DEFAULT_KIT_KEYS);

export async function listTemplates(organizationId: string) {
  const existing = await prisma.catalogItem.findMany({ where: { organizationId, deletedAt: null }, select: { kind: true, name: true, templateKey: true } });
  return {
    groups: TEMPLATE_GROUPS,
    items: TEMPLATE_ITEMS.map((t) => ({
      key: t.key, group: t.group, kind: t.kind, name: t.name, description: t.description, inclusions: t.inclusions ?? [], pricingType: t.pricingType ?? 'FIXED',
      unitPrice: t.unitPrice, unitLabel: t.unitLabel ?? null, taxRate: t.taxRate ?? 18, allowQuantity: t.allowQuantity ?? false,
      minQuantity: t.minQuantity ?? 1, maxQuantity: t.maxQuantity ?? null, isPopular: t.isPopular ?? false, inDefaultKit: t.inDefaultKit ?? false,
      added: existing.some((e) => e.templateKey === t.key || (e.kind === t.kind && e.name.toLowerCase() === t.name.toLowerCase())),
    })),
  };
}

export async function importTemplates(auth: AuthContext, keys: string[], ctx: AuditRequestContext) {
  const result = await addTemplates(prisma, auth.organizationId, auth.userId, keys);
  if (result.added) await recordAudit(prisma, ctx, { action: 'CREATE', entityType: 'CatalogItem', summary: `${result.added} ready-made template${result.added === 1 ? '' : 's'} added to the price list` });
  return result;
}

/** The studio says its example prices are its real prices. */
export async function confirmPrices(auth: AuthContext, ctx: AuditRequestContext) {
  const { count } = await prisma.catalogItem.updateMany({ where: { organizationId: auth.organizationId, deletedAt: null, isExample: true }, data: { isExample: false } });
  if (count) await recordAudit(prisma, ctx, { action: 'UPDATE', entityType: 'CatalogItem', summary: `Prices confirmed for ${count} item${count === 1 ? '' : 's'}` });
  return { confirmed: count };
}
