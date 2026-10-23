import { prisma } from '../config/prisma';
import { logger } from '../config/logger';
import { MailMessage, sendMail } from './mailer.service';

/** Active staff of a studio who hold at least one of the given permissions. */
export async function usersWithPermission(organizationId: string, keys: string[]) {
  return prisma.user.findMany({
    where: {
      organizationId, deletedAt: null, status: 'ACTIVE',
      userRoles: { some: { role: { deletedAt: null, status: 'ACTIVE', rolePermissions: { some: { permission: { key: { in: keys } } } } } } },
    },
    select: { id: true, email: true, fullName: true },
    take: 50,
  });
}

export interface StaffNotice { title: string; message: string; entityType: string; entityId: string }

/**
 * Tells the people who should act on something: first the named users, otherwise everyone allowed to handle
 * that area. Never throws, so a failed notification cannot fail the customer's request.
 */
export async function notifyStaff(organizationId: string, notice: StaffNotice, opts: { userIds?: Array<string | null | undefined>; permissions: string[]; email?: (to: string) => MailMessage }) {
  try {
    const named = [...new Set((opts.userIds ?? []).filter((x): x is string => Boolean(x)))];
    let people = named.length
      ? await prisma.user.findMany({ where: { id: { in: named }, organizationId, deletedAt: null, status: 'ACTIVE' }, select: { id: true, email: true, fullName: true } })
      : [];
    if (people.length === 0) people = await usersWithPermission(organizationId, opts.permissions);
    if (people.length === 0) return;
    await prisma.notification.createMany({
      data: people.map((p) => ({ organizationId, userId: p.id, type: 'GENERAL' as const, title: notice.title.slice(0, 200), message: notice.message, entityType: notice.entityType, entityId: notice.entityId })),
    });
    if (opts.email) {
      await Promise.all(people.filter((p) => p.email && !p.email.endsWith('@freelancer.local')).map((p) => sendMail(opts.email!(p.email)).catch((error) => logger.warn({ err: error }, 'staff e-mail failed'))));
    }
  } catch (error) {
    logger.warn({ err: error }, 'could not notify staff');
  }
}
