import { PrismaClient, Prisma, RoleType } from '@prisma/client';
import { PERMISSIONS, SYSTEM_ROLES, permissionsForSystemRole } from '../types/permissions';

type Db = PrismaClient | Prisma.TransactionClient;

export const EVENT_TYPES = [
  { name: 'Roka', colorHex: '#f59e0b', sortOrder: 1 },
  { name: 'Engagement', colorHex: '#ec4899', sortOrder: 2 },
  { name: 'Haldi', colorHex: '#fbbf24', sortOrder: 3 },
  { name: 'Mehendi', colorHex: '#22c55e', sortOrder: 4 },
  { name: 'Sangeet', colorHex: '#8b5cf6', sortOrder: 5 },
  { name: 'Wedding', colorHex: '#ef4444', sortOrder: 6 },
  { name: 'Reception', colorHex: '#3b82f6', sortOrder: 7 },
  { name: 'Pre Wedding Shoot', colorHex: '#14b8a6', sortOrder: 8 },
];

export const EXPENSE_CATEGORIES = [
  { name: 'Crew Payout', description: 'Freelancer and external crew settlements' },
  { name: 'Travel & Fuel', description: 'Cabs, fuel and outstation travel' },
  { name: 'Equipment & Repair', description: 'Gear purchase, rental and servicing' },
  { name: 'Album & Printing', description: 'Album design, printing and framing' },
  { name: 'Studio Rent', description: 'Premises rent' },
  { name: 'Utilities', description: 'Electricity, water and internet' },
  { name: 'Software & Subscriptions', description: 'Editing suites and cloud storage' },
  { name: 'Marketing & Ads', description: 'Paid campaigns and collateral' },
  { name: 'Food & Refreshments', description: 'On-shoot and studio catering' },
  { name: 'Miscellaneous', description: 'Uncategorised studio spend' },
];

export const LEAD_SOURCES = ['Instagram', 'Meta Ads', 'Google Search', 'Referral', 'Website', 'Walk-in', 'WeddingWire', 'Other'];
export const DEPARTMENTS = ['Production', 'Post Production', 'Management', 'Sales & Marketing', 'Operations'];
export const DESIGNATIONS = ['Studio Owner', 'Studio Manager', 'Lead Photographer', 'Cinematographer', 'Photo Editor', 'Video Editor', 'Album Designer', 'Account Manager', 'Sales Executive'];

export const DEFAULT_SETTINGS: Array<{ key: string; value: unknown; description: string }> = [
  { key: 'invoice.default_due_days', value: 15, description: 'Default invoice payment window' },
  { key: 'quotation.default_validity_days', value: 30, description: 'Default quotation validity' },
  { key: 'attendance.late_after', value: '09:45', description: 'Time after which a check-in is late' },
  { key: 'project.auto_number_prefix', value: 'PRJ', description: 'Project number prefix' },
  { key: 'delivery.default_sla_days', value: 45, description: 'Default delivery SLA from wedding date' },
];

/** Upserts the global permission catalogue and returns key → id. */
export async function ensurePermissionCatalogue(db: Db): Promise<Map<string, string>> {
  const existing = await db.permission.findMany({ select: { id: true, key: true } });
  const have = new Map(existing.map((r) => [r.key, r.id]));
  const missing = PERMISSIONS.filter((p) => !have.has(p.key));
  if (missing.length) {
    await db.permission.createMany({
      data: missing.map((p) => ({ key: p.key, module: p.module, label: p.label, isSensitive: p.isSensitive ?? false })),
      skipDuplicates: true,
    });
  }
  const rows = await db.permission.findMany({ select: { id: true, key: true } });
  return new Map(rows.map((r) => [r.key, r.id]));
}

export interface ProvisionInput {
  name: string;
  slug: string;
  /** When true, role→permission bundles are rebuilt (seed behaviour). New tenants only need additions. */
  reassertRolePermissions?: boolean;
}

/**
 * Creates (or completes) everything a tenant needs before its first user can
 * sign in: organisation, head-office branch, system roles with their permission
 * bundles, reference data and default settings. Idempotent.
 */
export async function provisionOrganization(db: Db, input: ProvisionInput) {
  const permissionIds = await ensurePermissionCatalogue(db);

  const organization = await db.organization.upsert({
    where: { slug: input.slug },
    create: { name: input.name, slug: input.slug, currency: 'INR', timezone: 'Asia/Kolkata', country: 'IN' },
    update: {},
  });
  const orgId = organization.id;

  const branch = await db.branch.upsert({
    where: { organizationId_code: { organizationId: orgId, code: 'HO' } },
    create: { organizationId: orgId, name: 'Head Office', code: 'HO', isHeadOffice: true },
    update: {},
  });

  await db.role.createMany({
    data: SYSTEM_ROLES.map((roleName) => ({
      organizationId: orgId,
      name: roleName,
      type: RoleType.SYSTEM,
      description: `System role: ${roleName}`,
      isDefault: roleName === 'Account Manager',
    })),
    skipDuplicates: true,
  });
  const roles = await db.role.findMany({ where: { organizationId: orgId, name: { in: [...SYSTEM_ROLES] } }, select: { id: true, name: true } });
  const roleIds = new Map(roles.map((r) => [r.name, r.id]));

  if (input.reassertRolePermissions) {
    await db.rolePermission.deleteMany({ where: { roleId: { in: roles.map((r) => r.id) } } });
  }
  const bundle: Array<{ roleId: string; permissionId: string }> = [];
  for (const roleName of SYSTEM_ROLES) {
    const roleId = roleIds.get(roleName);
    if (!roleId) continue;
    for (const key of permissionsForSystemRole(roleName)) {
      const permissionId = permissionIds.get(key);
      if (permissionId) bundle.push({ roleId, permissionId });
    }
  }
  await db.rolePermission.createMany({ data: bundle, skipDuplicates: true });

  await db.department.createMany({ data: DEPARTMENTS.map((name) => ({ organizationId: orgId, name })), skipDuplicates: true });
  await db.designation.createMany({ data: DESIGNATIONS.map((title) => ({ organizationId: orgId, title })), skipDuplicates: true });
  await db.eventType.createMany({ data: EVENT_TYPES.map((e) => ({ organizationId: orgId, ...e })), skipDuplicates: true });
  await db.expenseCategory.createMany({ data: EXPENSE_CATEGORIES.map((c) => ({ organizationId: orgId, ...c })), skipDuplicates: true });
  await db.leadSource.createMany({ data: LEAD_SOURCES.map((name) => ({ organizationId: orgId, name })), skipDuplicates: true });
  await db.systemSetting.createMany({
    data: DEFAULT_SETTINGS.map((s) => ({ organizationId: orgId, key: s.key, value: s.value as never, description: s.description })),
    skipDuplicates: true,
  });

  return { organization, branch, roleIds, permissionIds };
}
