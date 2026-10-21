import { prisma } from '../config/prisma';
import { logger } from '../config/logger';

/**
 * Tells the studio's people that a client did something. The project's manager
 * and creator are told (not the whole studio), and a failure here never fails
 * the client's request.
 */
export async function notifyStudioStaff(organizationId: string, projectId: string, n: { title: string; message: string; entityType: string; entityId: string }) {
  try {
    const project = await prisma.project.findFirst({ where: { id: projectId, organizationId }, select: { managerId: true, createdById: true } });
    const ids = [...new Set([project?.managerId, project?.createdById].filter((x): x is string => Boolean(x)))];
    if (ids.length === 0) return;
    await prisma.notification.createMany({
      data: ids.map((userId) => ({ organizationId, userId, type: 'GENERAL' as const, title: n.title.slice(0, 200), message: n.message, entityType: n.entityType, entityId: n.entityId })),
    });
  } catch (error) {
    logger.warn({ err: error }, 'could not notify studio staff');
  }
}

/** Tells every active portal user of the project's client (used for gallery-ready, replies, payments). */
export async function notifyClient(organizationId: string, projectId: string, n: { type: 'GALLERY_READY' | 'SECTION_UPLOADED' | 'REQUEST_UPDATE' | 'PAYMENT_RECEIVED' | 'PAYMENT_DUE' | 'GENERAL'; title: string; message: string; actionPath?: string; actionLabel?: string }) {
  try {
    const project = await prisma.project.findFirst({ where: { id: projectId, organizationId }, select: { clientId: true } });
    if (!project) return;
    const users = await prisma.clientPortalUser.findMany({ where: { organizationId, clientId: project.clientId, deletedAt: null, status: 'ACTIVE' }, select: { id: true } });
    if (users.length === 0) return;
    await prisma.clientPortalNotification.createMany({
      data: users.map((u) => ({ portalUserId: u.id, projectId, type: n.type, title: n.title.slice(0, 200), message: n.message, actionPath: n.actionPath ?? `/client/projects/${projectId}`, actionLabel: n.actionLabel ?? 'Open' })),
    });
  } catch (error) {
    logger.warn({ err: error }, 'could not notify client');
  }
}
