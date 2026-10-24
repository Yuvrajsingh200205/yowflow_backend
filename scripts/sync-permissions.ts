/**
 * Brings the permission catalogue in the database up to date and grants newly added keys to the system roles of
 * every studio. Safe to run any time and as often as you like. The deployed API also does this once per instance.
 *
 *   npm run permissions:sync
 */
import { prisma } from '../src/config/prisma';
import { syncPermissionCatalogue } from '../src/services/permissionCatalogue.service';

async function main(): Promise<void> {
  const added = await syncPermissionCatalogue();
  console.warn(added ? `Added ${added} permission(s) and granted them to the system roles.` : 'Permission catalogue is already up to date.');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
