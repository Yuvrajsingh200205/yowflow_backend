import { RoleType } from '@prisma/client';
import { prisma } from '../config/prisma';
import { ALWAYS_GRANTED_KEYS, PERMISSIONS, SYSTEM_ROLES, permissionsForSystemRole } from '../types/permissions';

async function grantAlwaysOnPermissions() {
  const perms = await prisma.permission.findMany({
    where: { key: { in: [...ALWAYS_GRANTED_KEYS] } },
    select: { id: true },
  });
  if (!perms.length) return;
  const roles = await prisma.role.findMany({ where: { deletedAt: null }, select: { id: true } });
  if (!roles.length) return;
  await prisma.rolePermission.createMany({
    data: roles.flatMap((role) => perms.map((permission) => ({ roleId: role.id, permissionId: permission.id }))),
    skipDuplicates: true,
  });
}

/**
 * Upserts the in-code catalogue and grants newly added keys to system roles.
 *
 * `quietWhenCurrent` is for serverless cold starts, where this runs on every new instance: when the catalogue
 * already matches the database it returns after one read instead of re-asserting the always-on grants for
 * every role.
 */
export async function syncPermissionCatalogue(opts: { quietWhenCurrent?: boolean } = {}): Promise<number> {
  const existing = await prisma.permission.findMany({
    select: { key: true, module: true, label: true, isSensitive: true },
  });
  const existingByKey = new Map(existing.map((row) => [row.key, row]));

  // The catalogue is static in-code data, so on every boot after the first one
  // each row already matches. Comparing before writing turns what used to be
  // one sequential UPDATE per permission — 100+ round trips, and the dominant
  // cost of starting the process — into zero. `Permission` has no `updatedAt`,
  // so a skipped no-op UPDATE leaves the row byte-identical.
  const missing = PERMISSIONS.filter((permission) => !existingByKey.has(permission.key));
  const stale = PERMISSIONS.filter((permission) => {
    const row = existingByKey.get(permission.key);
    return (
      row !== undefined &&
      (row.module !== permission.module ||
        row.label !== permission.label ||
        row.isSensitive !== (permission.isSensitive ?? false))
    );
  });

  if (missing.length) {
    await prisma.permission.createMany({
      data: missing.map((permission) => ({
        key: permission.key,
        module: permission.module,
        label: permission.label,
        isSensitive: permission.isSensitive ?? false,
      })),
      skipDuplicates: true,
    });
  }

  for (const permission of stale) {
    await prisma.permission.update({
      where: { key: permission.key },
      data: {
        module: permission.module,
        label: permission.label,
        isSensitive: permission.isSensitive ?? false,
      },
    });
  }

  if (opts.quietWhenCurrent && !missing.length && !stale.length) return 0;
  await grantAlwaysOnPermissions();

  const created = missing.map((permission) => permission.key);
  if (!created.length) return 0;

  const rows = await prisma.permission.findMany({
    where: { key: { in: created } },
    select: { id: true, key: true },
  });
  const idByKey = new Map(rows.map((row) => [row.key, row.id]));

  // One read for every system role across every organization, rather than a
  // `findFirst` per organization-and-role pair.
  const roles = await prisma.role.findMany({
    where: { name: { in: [...SYSTEM_ROLES] }, type: RoleType.SYSTEM, deletedAt: null },
    select: { id: true, name: true },
  });

  const grants = roles.flatMap((role) => {
    const allowed = new Set(permissionsForSystemRole(role.name as (typeof SYSTEM_ROLES)[number]));
    return created
      .filter((key) => allowed.has(key))
      .map((key) => idByKey.get(key))
      .filter((id): id is string => Boolean(id))
      .map((permissionId) => ({ roleId: role.id, permissionId }));
  });

  if (grants.length) {
    await prisma.rolePermission.createMany({ data: grants, skipDuplicates: true });
  }

  return created.length;
}
