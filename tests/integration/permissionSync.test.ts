import { describe, expect, it } from 'vitest';
import { prisma, seedTestOrganization } from '../helpers/factory';
import { syncPermissionCatalogue } from '../../src/services/permissionCatalogue.service';

describe('permission catalogue sync', () => {
  it('restores a missing permission, grants it to the system roles of existing studios, and is quiet once current', async () => {
    const org = await seedTestOrganization('perm-sync');
    await prisma.permission.delete({ where: { key: 'CATALOG_MANAGE' } });

    const added = await syncPermissionCatalogue({ quietWhenCurrent: true });
    expect(added).toBe(1);

    const grants = await prisma.rolePermission.findMany({
      where: { permission: { key: 'CATALOG_MANAGE' }, role: { organizationId: org.organizationId } },
      select: { role: { select: { name: true } } },
    });
    expect(grants.map((g) => g.role.name)).toContain('Admin');

    expect(await syncPermissionCatalogue({ quietWhenCurrent: true })).toBe(0);
  });
});
