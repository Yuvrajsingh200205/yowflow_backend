import { RoleType } from '@prisma/client';
import { hashPassword } from '../../src/utils/password';
import { PERMISSIONS, SYSTEM_ROLES, permissionsForSystemRole } from '../../src/types/permissions';

// Share the application's client rather than opening a second pool. Two pools
// against one database made the reset TRUNCATE deadlock against connections the
// app under test still held, failing whichever file happened to run next.
export { prisma } from '../../src/config/prisma';
import { prisma } from '../../src/config/prisma';

/** Tables truncated between test cases. `permissions` is a static catalogue. */
const TRUNCATE_EXCLUDE = new Set(['_prisma_migrations', 'permissions']);

const isLockContention = (error: unknown): boolean => {
  // 40P01 deadlock_detected, 55P03 lock_not_available.
  const code = (error as { meta?: { code?: string } })?.meta?.code;
  return code === '40P01' || code === '55P03';
};

export async function resetDatabase(): Promise<void> {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;

  const targets = tables
    .map((t) => t.tablename)
    .filter((name) => !TRUNCATE_EXCLUDE.has(name))
    .map((name) => `"public"."${name}"`);

  if (targets.length === 0) return;

  // TRUNCATE needs an ACCESS EXCLUSIVE lock on every table at once. A pooled
  // connection still finishing the previous case can hold a row lock and
  // deadlock the reset, which failed whichever file happened to run next. A
  // bounded lock wait plus retry makes the reset deterministic instead.
  const statement = `TRUNCATE TABLE ${targets.join(', ')} RESTART IDENTITY CASCADE`;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await prisma.$transaction([
        prisma.$executeRawUnsafe(`SET LOCAL lock_timeout = '4s'`),
        prisma.$executeRawUnsafe(statement),
      ]);
      return;
    } catch (error) {
      if (attempt === 5 || !isLockContention(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

export async function ensurePermissions(): Promise<Map<string, string>> {
  for (const permission of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: permission.key },
      create: {
        key: permission.key,
        module: permission.module,
        label: permission.label,
        isSensitive: permission.isSensitive ?? false,
      },
      update: {},
    });
  }
  const rows = await prisma.permission.findMany({ select: { id: true, key: true } });
  return new Map(rows.map((r) => [r.key, r.id]));
}

export interface TestOrg {
  organizationId: string;
  branchId: string;
  roleIds: Record<string, string>;
  admin: TestUser;
  manager: TestUser;
  member: TestUser;
  expenseCategoryId: string;
  eventTypeId: string;
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
}

const PASSWORD = 'TestPassw0rd!';

/** Builds a complete, realistic tenant: org, branch, roles, three users. */
export async function seedTestOrganization(slug = 'test-studio'): Promise<TestOrg> {
  const permissionIds = await ensurePermissions();

  const organization = await prisma.organization.create({
    data: { name: 'Test Studio', slug, currency: 'INR' },
  });

  const branch = await prisma.branch.create({
    data: { organizationId: organization.id, name: 'Head Office', code: 'HO', isHeadOffice: true },
  });

  const roleIds: Record<string, string> = {};
  for (const roleName of SYSTEM_ROLES) {
    const role = await prisma.role.create({
      data: { organizationId: organization.id, name: roleName, type: RoleType.SYSTEM },
    });
    roleIds[roleName] = role.id;
    roleIds[roleName.toUpperCase()] = role.id;
    if (roleName === 'Admin') roleIds.ADMIN = role.id;
    if (roleName === 'Manager') roleIds.MANAGER = role.id;
    await prisma.rolePermission.createMany({
      data: permissionsForSystemRole(roleName)
        .map((key) => permissionIds.get(key))
        .filter((id): id is string => Boolean(id))
        .map((permissionId) => ({ roleId: role.id, permissionId })),
      skipDuplicates: true,
    });
  }

  const passwordHash = await hashPassword(PASSWORD);

  let employeeSeq = 1;
  const makeUser = async (email: string, fullName: string, role: string): Promise<TestUser> => {
    const user = await prisma.user.create({
      data: {
        organizationId: organization.id,
        branchId: branch.id,
        email,
        fullName,
        employeeCode: `EMP-S${String(employeeSeq++).padStart(2, '0')}`,
        passwordHash,
        status: 'ACTIVE',
        userRoles: { create: [{ roleId: roleIds[role] }] },
        // The team directory lists employees, not bare user rows, so a seeded
        // staff member needs the profile a real one would always have.
        employeeProfile: { create: {} },
      },
    });
    return { id: user.id, email, password: PASSWORD };
  };

  const admin = await makeUser(`admin@${slug}.test`, 'Admin User', 'ADMIN');
  const manager = await makeUser(`manager@${slug}.test`, 'Manager User', 'MANAGER');
  const member = await makeUser(`member@${slug}.test`, 'Member User', 'Account Manager');
  roleIds.MEMBER = roleIds['ACCOUNT MANAGER'];

  const category = await prisma.expenseCategory.create({
    data: { organizationId: organization.id, name: 'Travel & Fuel' },
  });
  const eventType = await prisma.eventType.create({
    data: { organizationId: organization.id, name: 'Wedding' },
  });

  return {
    organizationId: organization.id,
    branchId: branch.id,
    roleIds,
    admin,
    manager,
    member,
    expenseCategoryId: category.id,
    eventTypeId: eventType.id,
  };
}
