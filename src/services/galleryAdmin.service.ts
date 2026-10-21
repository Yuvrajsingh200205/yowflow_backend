import { ClientPortalRequestStatus, GalleryStatus, GallerySectionStatus, Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { AuthContext } from '../types';
import { conflict, notFound } from '../utils/errors';
import { AuditRequestContext, recordAudit } from './audit.service';
import { requireProject } from './galleryMedia.service';
import { notifyClient } from './portalNotify.service';
import { sendMail } from './mailer.service';
import { logger } from '../config/logger';
import { brand } from '../config/brand';

/** Studio-side control of what the couple sees in their portal, plus the client's activity. */

async function requireGallery(auth: AuthContext, projectId: string) {
  await requireProject(auth, projectId);
  const g = await prisma.gallery.findFirst({ where: { projectId, organizationId: auth.organizationId, deletedAt: null }, select: { id: true, title: true, status: true } });
  if (!g) throw notFound('Gallery');
  return g;
}

/** Returns the project's gallery, creating an unpublished one so the studio can set it up before uploading. */
export async function ensureGallery(auth: AuthContext, projectId: string) {
  const project = await requireProject(auth, projectId);
  return prisma.gallery.upsert({
    where: { projectId },
    create: { organizationId: auth.organizationId, projectId, title: project.name ?? 'Wedding Gallery', status: 'DRAFT' },
    update: { deletedAt: null },
    select: { id: true, title: true, status: true },
  });
}

const GALLERY_VIEW = { id: true, title: true, status: true, welcomeMessage: true, albumSelectionTarget: true, expectedDeliveryDate: true, publishedAt: true } as const;

export async function getGallerySettings(auth: AuthContext, projectId: string) {
  const g = await ensureGallery(auth, projectId);
  const [gallery, sections, counts, pendingDerivatives] = await Promise.all([
    prisma.gallery.findUniqueOrThrow({ where: { id: g.id }, select: GALLERY_VIEW }),
    prisma.gallerySection.findMany({
      where: { galleryId: g.id, deletedAt: null }, orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, name: true, description: true, sectionDate: true, venueName: true, status: true, orderIndex: true, isVisibleToClient: true, isDownloadAllowed: true, isShareAllowed: true, hasWatermark: true, subFolders: { where: { deletedAt: null }, orderBy: [{ orderIndex: 'asc' }, { name: 'asc' }], select: { id: true, name: true, isClientVisible: true } } },
    }),
    prisma.galleryMedia.groupBy({ by: ['sectionId'], where: { galleryId: g.id, deletedAt: null }, _count: { _all: true } }),
    prisma.galleryMedia.count({ where: { galleryId: g.id, deletedAt: null, mediaType: 'IMAGE', derivatives: { none: {} } } }),
  ]);
  const count = new Map(counts.map((c) => [c.sectionId, c._count._all]));
  return { gallery, sections: sections.map((s) => ({ ...s, mediaCount: count.get(s.id) ?? 0 })), pendingDerivatives };
}

export async function updateGallery(auth: AuthContext, projectId: string, input: { title?: string; welcomeMessage?: string | null; albumSelectionTarget?: number; expectedDeliveryDate?: string | null; status?: GalleryStatus }, ctx: AuditRequestContext) {
  const g = await ensureGallery(auth, projectId);
  const publishing = input.status === 'PUBLISHED' && g.status !== 'PUBLISHED';
  const updated = await prisma.gallery.update({
    where: { id: g.id },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.welcomeMessage !== undefined ? { welcomeMessage: input.welcomeMessage } : {}),
      ...(input.albumSelectionTarget !== undefined ? { albumSelectionTarget: input.albumSelectionTarget } : {}),
      ...(input.expectedDeliveryDate !== undefined ? { expectedDeliveryDate: input.expectedDeliveryDate ? new Date(`${input.expectedDeliveryDate}T00:00:00Z`) : null } : {}),
      ...(input.status ? { status: input.status, ...(publishing ? { publishedAt: new Date() } : {}) } : {}),
    },
    select: GALLERY_VIEW,
  });
  await recordAudit(prisma, ctx, { action: 'UPDATE', entityType: 'Gallery', entityId: g.id, summary: publishing ? 'Gallery published to the client portal' : 'Gallery settings updated', newData: input });
  if (publishing) await announceGallery(auth.organizationId, projectId, updated.title);
  return updated;
}

async function announceGallery(organizationId: string, projectId: string, title: string) {
  await notifyClient(organizationId, projectId, { type: 'GALLERY_READY', title: 'Your gallery is ready', message: `${title} is now available in your portal.`, actionLabel: 'View gallery', actionPath: `/client/projects/${projectId}?tab=gallery` });
  try {
    const project = await prisma.project.findFirst({ where: { id: projectId, organizationId }, select: { clientId: true, organization: { select: { name: true } } } });
    const users = project ? await prisma.clientPortalUser.findMany({ where: { organizationId, clientId: project.clientId, status: 'ACTIVE', deletedAt: null }, select: { email: true, fullName: true } }) : [];
    const link = `${env.APP_URL.replace(/\/$/, '')}/client/projects/${projectId}?tab=gallery`;
    await Promise.all(users.map((u) => sendMail({
      to: u.email,
      subject: `Your ${project?.organization.name ?? brand.name} gallery is ready`,
      text: `Hi ${u.fullName.split(' ')[0]},\n\n${title} is ready to view in your private portal:\n${link}`,
      html: `<p>Hi ${u.fullName.split(' ')[0]},</p><p><strong>${title}</strong> is ready to view in your private portal.</p><p><a href="${link}">Open my gallery</a></p>`,
    })));
  } catch (error) {
    logger.warn({ err: error }, 'could not e-mail gallery announcement');
  }
}

// ── Sections and sub-folders ────────────────────────────────────────────────
export interface SectionInput {
  name?: string; description?: string | null; sectionDate?: string | null; venueName?: string | null; status?: GallerySectionStatus; orderIndex?: number;
  isVisibleToClient?: boolean; isDownloadAllowed?: boolean; isShareAllowed?: boolean; hasWatermark?: boolean; eventId?: string | null;
}
const sectionData = (i: SectionInput): Prisma.GallerySectionUncheckedUpdateInput => ({
  ...(i.name !== undefined ? { name: i.name } : {}), ...(i.description !== undefined ? { description: i.description } : {}),
  ...(i.sectionDate !== undefined ? { sectionDate: i.sectionDate ? new Date(`${i.sectionDate}T00:00:00Z`) : null } : {}),
  ...(i.venueName !== undefined ? { venueName: i.venueName } : {}), ...(i.status ? { status: i.status } : {}), ...(i.orderIndex !== undefined ? { orderIndex: i.orderIndex } : {}),
  ...(i.isVisibleToClient !== undefined ? { isVisibleToClient: i.isVisibleToClient } : {}), ...(i.isDownloadAllowed !== undefined ? { isDownloadAllowed: i.isDownloadAllowed } : {}),
  ...(i.isShareAllowed !== undefined ? { isShareAllowed: i.isShareAllowed } : {}), ...(i.hasWatermark !== undefined ? { hasWatermark: i.hasWatermark } : {}),
  ...(i.eventId !== undefined ? { eventId: i.eventId } : {}),
});

export async function createSection(auth: AuthContext, projectId: string, input: SectionInput & { name: string }, ctx: AuditRequestContext) {
  const g = await ensureGallery(auth, projectId);
  const clash = await prisma.gallerySection.findFirst({ where: { galleryId: g.id, name: input.name, deletedAt: null }, select: { id: true } });
  if (clash) throw conflict('A section with this name already exists.');
  const section = await prisma.gallerySection.create({
    data: { organizationId: auth.organizationId, galleryId: g.id, name: input.name, ...(sectionData(input) as Prisma.GallerySectionUncheckedUpdateInput as Record<string, unknown>) } as Prisma.GallerySectionUncheckedCreateInput,
    select: { id: true, name: true },
  });
  await recordAudit(prisma, ctx, { action: 'CREATE', entityType: 'GallerySection', entityId: section.id, summary: `Gallery section "${section.name}" created` });
  return section;
}

export async function updateSection(auth: AuthContext, projectId: string, sectionId: string, input: SectionInput, ctx: AuditRequestContext) {
  const g = await requireGallery(auth, projectId);
  const found = await prisma.gallerySection.findFirst({ where: { id: sectionId, galleryId: g.id, deletedAt: null }, select: { id: true } });
  if (!found) throw notFound('Section');
  const section = await prisma.gallerySection.update({ where: { id: sectionId }, data: sectionData(input), select: { id: true, name: true, isVisibleToClient: true, isDownloadAllowed: true, isShareAllowed: true, hasWatermark: true } });
  await recordAudit(prisma, ctx, { action: 'UPDATE', entityType: 'GallerySection', entityId: sectionId, summary: `Gallery section "${section.name}" updated`, newData: input });
  return section;
}

export async function deleteSection(auth: AuthContext, projectId: string, sectionId: string, ctx: AuditRequestContext) {
  const g = await requireGallery(auth, projectId);
  const section = await prisma.gallerySection.findFirst({ where: { id: sectionId, galleryId: g.id, deletedAt: null }, select: { id: true, name: true, _count: { select: { media: { where: { deletedAt: null } } } } } });
  if (!section) throw notFound('Section');
  if (section._count.media > 0) throw conflict('Move or delete the photographs in this section first.');
  await prisma.gallerySection.update({ where: { id: sectionId }, data: { deletedAt: new Date(), deletedBy: auth.userId } });
  await recordAudit(prisma, ctx, { action: 'DELETE', entityType: 'GallerySection', entityId: sectionId, summary: `Gallery section "${section.name}" deleted` });
}

export async function createSubFolder(auth: AuthContext, projectId: string, sectionId: string, input: { name: string }, ctx: AuditRequestContext) {
  const g = await requireGallery(auth, projectId);
  const section = await prisma.gallerySection.findFirst({ where: { id: sectionId, galleryId: g.id, deletedAt: null }, select: { id: true } });
  if (!section) throw notFound('Section');
  const clash = await prisma.gallerySubFolder.findFirst({ where: { sectionId, name: input.name }, select: { id: true } });
  if (clash) throw conflict('A folder with this name already exists in the section.');
  const folder = await prisma.gallerySubFolder.create({ data: { organizationId: auth.organizationId, galleryId: g.id, sectionId, name: input.name }, select: { id: true, name: true } });
  await recordAudit(prisma, ctx, { action: 'CREATE', entityType: 'GallerySubFolder', entityId: folder.id, summary: `Gallery folder "${folder.name}" created` });
  return folder;
}

export async function updateSubFolder(auth: AuthContext, projectId: string, folderId: string, input: { name?: string; isClientVisible?: boolean }) {
  const g = await requireGallery(auth, projectId);
  const found = await prisma.gallerySubFolder.findFirst({ where: { id: folderId, galleryId: g.id, deletedAt: null }, select: { id: true } });
  if (!found) throw notFound('Folder');
  return prisma.gallerySubFolder.update({ where: { id: folderId }, data: { ...(input.name ? { name: input.name } : {}), ...(input.isClientVisible !== undefined ? { isClientVisible: input.isClientVisible } : {}) }, select: { id: true, name: true, isClientVisible: true } });
}

export async function deleteSubFolder(auth: AuthContext, projectId: string, folderId: string) {
  const g = await requireGallery(auth, projectId);
  const found = await prisma.gallerySubFolder.findFirst({ where: { id: folderId, galleryId: g.id, deletedAt: null }, select: { id: true } });
  if (!found) throw notFound('Folder');
  // Photographs keep existing; they simply fall back to the section root.
  await prisma.$transaction([
    prisma.galleryMedia.updateMany({ where: { subFolderId: folderId }, data: { subFolderId: null } }),
    prisma.gallerySubFolder.update({ where: { id: folderId }, data: { deletedAt: new Date(), deletedBy: auth.userId } }),
  ]);
}

// ── Media curation ──────────────────────────────────────────────────────────
export interface MediaPatch { title?: string; isClientVisible?: boolean; isDownloadAllowed?: boolean; sectionId?: string; subFolderId?: string | null; orderIndex?: number }

export async function updateMedia(auth: AuthContext, projectId: string, mediaIds: string[], patch: MediaPatch, ctx: AuditRequestContext) {
  const g = await requireGallery(auth, projectId);
  if (patch.sectionId) {
    const sec = await prisma.gallerySection.findFirst({ where: { id: patch.sectionId, galleryId: g.id, deletedAt: null }, select: { id: true } });
    if (!sec) throw notFound('Section');
  }
  if (patch.subFolderId) {
    const folder = await prisma.gallerySubFolder.findFirst({ where: { id: patch.subFolderId, galleryId: g.id, deletedAt: null, ...(patch.sectionId ? { sectionId: patch.sectionId } : {}) }, select: { id: true, sectionId: true } });
    if (!folder) throw notFound('Folder');
  }
  const data: Prisma.GalleryMediaUncheckedUpdateManyInput = {
    ...(patch.title !== undefined ? { title: patch.title } : {}), ...(patch.isClientVisible !== undefined ? { isClientVisible: patch.isClientVisible } : {}),
    ...(patch.isDownloadAllowed !== undefined ? { isDownloadAllowed: patch.isDownloadAllowed } : {}), ...(patch.sectionId ? { sectionId: patch.sectionId, ...(patch.subFolderId === undefined ? { subFolderId: null } : {}) } : {}),
    ...(patch.subFolderId !== undefined ? { subFolderId: patch.subFolderId } : {}), ...(patch.orderIndex !== undefined ? { orderIndex: patch.orderIndex } : {}),
  };
  const result = await prisma.galleryMedia.updateMany({ where: { id: { in: mediaIds }, galleryId: g.id, organizationId: auth.organizationId, deletedAt: null }, data });
  if (result.count === 0) throw notFound('Gallery media');
  await recordAudit(prisma, ctx, { action: 'UPDATE', entityType: 'GalleryMedia', entityId: mediaIds[0], summary: `${result.count} gallery item(s) updated`, newData: patch });
  return { updated: result.count };
}

// ── Client activity ─────────────────────────────────────────────────────────
export async function getClientActivity(auth: AuthContext, projectId: string) {
  const g = await requireGallery(auth, projectId);
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { clientId: true } });
  const [users, requests, comments, favorites, album, shares] = await Promise.all([
    prisma.clientPortalUser.findMany({ where: { clientId: project.clientId, organizationId: auth.organizationId, deletedAt: null }, select: { id: true, fullName: true, email: true, status: true, lastLoginAt: true } }),
    prisma.clientPortalRequest.findMany({ where: { projectId, organizationId: auth.organizationId, deletedAt: null }, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], take: 100, select: { id: true, type: true, status: true, title: true, description: true, adminResponse: true, createdAt: true, resolvedAt: true, relatedMediaId: true, portalUser: { select: { fullName: true } } } }),
    prisma.clientPortalComment.findMany({ where: { galleryId: g.id, deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, body: true, type: true, isResolved: true, createdAt: true, mediaId: true, media: { select: { title: true } }, portalUser: { select: { fullName: true } }, authorUser: { select: { fullName: true } } } }),
    prisma.galleryMediaSelection.groupBy({ by: ['portalUserId'], where: { kind: 'FAVORITE', media: { galleryId: g.id, deletedAt: null } }, _count: { _all: true } }),
    prisma.galleryMediaSelection.findMany({ where: { kind: 'ALBUM', media: { galleryId: g.id, deletedAt: null } }, distinct: ['mediaId'], orderBy: { createdAt: 'asc' }, select: { mediaId: true, createdAt: true, media: { select: { title: true, file: { select: { originalName: true } }, section: { select: { name: true } } } } } }),
    prisma.galleryShareLink.findMany({ where: { galleryId: g.id, createdByPortalUserId: { not: null } }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, title: true, accessType: true, status: true, viewsCount: true, downloadsCount: true, expiresAt: true, createdAt: true } }),
  ]);
  const favBy = new Map(favorites.map((f) => [f.portalUserId, f._count._all]));
  return {
    portalUsers: users.map((u) => ({ ...u, favorites: favBy.get(u.id) ?? 0 })),
    requests: requests.map((r) => ({ id: r.id, type: r.type, status: r.status, title: r.title, description: r.description, adminResponse: r.adminResponse, createdAt: r.createdAt, resolvedAt: r.resolvedAt, relatedMediaId: r.relatedMediaId, from: r.portalUser.fullName })),
    comments: comments.map((c) => ({ id: c.id, body: c.body, type: c.type, isResolved: c.isResolved, createdAt: c.createdAt, mediaId: c.mediaId, mediaTitle: c.media?.title ?? null, from: c.portalUser?.fullName ?? c.authorUser?.fullName ?? 'Studio', fromStudio: !c.portalUser })),
    albumSelection: album.map((a) => ({ mediaId: a.mediaId, title: a.media.title, fileName: a.media.file.originalName, section: a.media.section.name, selectedAt: a.createdAt })),
    shareLinks: shares,
  };
}

export async function respondToRequest(auth: AuthContext, projectId: string, requestId: string, input: { status?: ClientPortalRequestStatus; adminResponse?: string }, ctx: AuditRequestContext) {
  const g = await requireGallery(auth, projectId);
  const found = await prisma.clientPortalRequest.findFirst({ where: { id: requestId, galleryId: g.id, deletedAt: null }, select: { id: true, title: true, status: true } });
  if (!found) throw notFound('Request');
  const done = input.status === 'COMPLETED' || input.status === 'CLOSED';
  const updated = await prisma.clientPortalRequest.update({
    where: { id: requestId },
    data: { ...(input.status ? { status: input.status, resolvedAt: done ? new Date() : null } : {}), ...(input.adminResponse !== undefined ? { adminResponse: input.adminResponse } : {}), assignedToId: auth.userId },
    select: { id: true, status: true, adminResponse: true, resolvedAt: true, title: true },
  });
  await recordAudit(prisma, ctx, { action: 'UPDATE', entityType: 'ClientPortalRequest', entityId: requestId, summary: `Client request "${found.title}" → ${updated.status}`, newData: input });
  await notifyClient(auth.organizationId, projectId, { type: 'REQUEST_UPDATE', title: `Update on your request: ${updated.title}`, message: input.adminResponse ? input.adminResponse.slice(0, 160) : `Status: ${updated.status.replace(/_/g, ' ').toLowerCase()}`, actionLabel: 'View request', actionPath: `/client/projects/${projectId}?tab=requests` });
  return updated;
}

export async function replyToComment(auth: AuthContext, projectId: string, commentId: string, body: string, ctx: AuditRequestContext) {
  const g = await requireGallery(auth, projectId);
  const parent = await prisma.clientPortalComment.findFirst({ where: { id: commentId, galleryId: g.id, deletedAt: null }, select: { id: true, mediaId: true } });
  if (!parent) throw notFound('Comment');
  const reply = await prisma.clientPortalComment.create({ data: { organizationId: auth.organizationId, galleryId: g.id, mediaId: parent.mediaId, authorUserId: auth.userId, type: 'GENERAL', body: body.trim() }, select: { id: true, createdAt: true } });
  await prisma.clientPortalComment.update({ where: { id: parent.id }, data: { isResolved: true, resolvedAt: new Date(), resolvedById: auth.userId } });
  await recordAudit(prisma, ctx, { action: 'CREATE', entityType: 'ClientPortalComment', entityId: reply.id, summary: 'Studio replied to a client comment' });
  await notifyClient(auth.organizationId, projectId, { type: 'REQUEST_UPDATE', title: 'The studio replied to your note', message: body.trim().slice(0, 160), actionLabel: 'Open gallery', actionPath: `/client/projects/${projectId}?tab=gallery` });
  return reply;
}
