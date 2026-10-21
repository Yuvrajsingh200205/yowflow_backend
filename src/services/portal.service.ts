import crypto from 'crypto';
import { ClientPortalCommentType, ClientPortalRequestType, GallerySelectionKind, Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { PortalAuthContext } from '../types';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors';
import { hashPassword } from '../utils/password';
import { recordAudit } from './audit.service';
import { createSignedUrl } from './storage.service';
import { presentVariants } from './galleryMedia.service';
import { notifyStudioStaff } from './portalNotify.service';

// ===========================================================================
// Everything here is scoped to the signed-in portal user's own CRM client. The
// scope is part of every WHERE clause, so there is no code path where a couple
// can name another couple's project, gallery or photograph and get it back.
// ===========================================================================

const PAGE_SIZE_DEFAULT = 60;
const PAGE_SIZE_MAX = 120;

const projectScope = (p: PortalAuthContext, projectId?: string): Prisma.ProjectWhereInput => ({
  organizationId: p.organizationId, clientId: p.clientId, deletedAt: null, ...(projectId ? { id: projectId } : {}),
});

async function requireProject(p: PortalAuthContext, projectId: string) {
  const project = await prisma.project.findFirst({ where: projectScope(p, projectId), select: { id: true, name: true, projectNumber: true } });
  if (!project) throw notFound('Project');
  return project;
}

/** Media the couple may see: published gallery, visible section, visible file. */
const mediaScope = (p: PortalAuthContext, extra: Prisma.GalleryMediaWhereInput = {}): Prisma.GalleryMediaWhereInput => ({
  organizationId: p.organizationId,
  deletedAt: null,
  isClientVisible: true,
  section: { isVisibleToClient: true, deletedAt: null },
  gallery: { status: 'PUBLISHED', deletedAt: null, project: { clientId: p.clientId, deletedAt: null } },
  ...extra,
});

const MEDIA_SELECT = {
  id: true, sectionId: true, subFolderId: true, title: true, mediaType: true, width: true, height: true, orientation: true,
  durationSeconds: true, isDownloadAllowed: true, orderIndex: true, createdAt: true, galleryId: true,
  section: { select: { id: true, name: true, isDownloadAllowed: true, isShareAllowed: true, hasWatermark: true } },
  file: { select: { objectKey: true, bucket: true, originalName: true, mimeType: true, sizeBytes: true } },
  derivatives: { select: { kind: true, file: { select: { objectKey: true, bucket: true } } } },
} satisfies Prisma.GalleryMediaSelect;

async function requireMedia(p: PortalAuthContext, mediaId: string) {
  const media = await prisma.galleryMedia.findFirst({ where: mediaScope(p, { id: mediaId }), select: MEDIA_SELECT });
  if (!media) throw notFound('Photograph');
  return media;
}

const canDownload = (m: { isDownloadAllowed: boolean; section: { isDownloadAllowed: boolean } }) => m.isDownloadAllowed && m.section.isDownloadAllowed;

// ── Projects ────────────────────────────────────────────────────────────────
export async function listProjects(p: PortalAuthContext) {
  const projects = await prisma.project.findMany({
    where: projectScope(p),
    orderBy: [{ weddingDate: 'desc' }, { createdAt: 'desc' }],
    select: {
      id: true, projectNumber: true, name: true, type: true, status: true, weddingDate: true, deliveryDueDate: true, venueName: true, venueCity: true, totalQuotation: true,
      gallery: { select: { id: true, status: true, publishedAt: true, expectedDeliveryDate: true } },
    },
  });
  const ids = projects.map((x) => x.id);
  const [paid, media, unread, requests] = await Promise.all([
    prisma.payment.groupBy({ by: ['projectId'], where: { organizationId: p.organizationId, clientId: p.clientId, projectId: { in: ids }, status: 'COMPLETED' }, _sum: { amount: true } }),
    prisma.galleryMedia.groupBy({ by: ['galleryId'], where: mediaScope(p), _count: { _all: true } }),
    prisma.clientPortalNotification.count({ where: { portalUserId: p.portalUserId, isRead: false } }),
    prisma.clientPortalRequest.groupBy({ by: ['projectId'], where: { portalUserId: p.portalUserId, projectId: { in: ids }, status: { in: ['OPEN', 'IN_PROGRESS', 'WAITING_FOR_CLIENT'] }, deletedAt: null }, _count: { _all: true } }),
  ]);
  const paidBy = new Map(paid.map((r) => [r.projectId, Number(r._sum.amount ?? 0)]));
  const mediaBy = new Map(media.map((r) => [r.galleryId, r._count._all]));
  const reqBy = new Map(requests.map((r) => [r.projectId, r._count._all]));
  return {
    unreadNotifications: unread,
    projects: projects.map((x) => {
      const total = Number(x.totalQuotation);
      const received = paidBy.get(x.id) ?? 0;
      const published = x.gallery?.status === 'PUBLISHED';
      return {
        id: x.id, projectNumber: x.projectNumber, name: x.name, type: x.type, status: x.status,
        weddingDate: x.weddingDate, deliveryDueDate: x.deliveryDueDate, venueName: x.venueName, venueCity: x.venueCity,
        payments: { total, received, balance: Math.max(0, total - received) },
        gallery: { published, mediaCount: published && x.gallery ? mediaBy.get(x.gallery.id) ?? 0 : 0, expectedDeliveryDate: x.gallery?.expectedDeliveryDate ?? x.deliveryDueDate },
        openRequests: reqBy.get(x.id) ?? 0,
      };
    }),
  };
}

export async function getProject(p: PortalAuthContext, projectId: string) {
  const [project, events, milestones, invoices, payments, deliveries, studio] = await Promise.all([
    prisma.project.findFirst({ where: projectScope(p, projectId), select: { id: true, projectNumber: true, name: true, type: true, status: true, weddingDate: true, deliveryDueDate: true, venueName: true, venueAddress: true, venueCity: true, totalQuotation: true } }),
    prisma.event.findMany({ where: { projectId, organizationId: p.organizationId, deletedAt: null }, orderBy: [{ eventDate: 'asc' }, { startTime: 'asc' }], select: { id: true, name: true, eventDate: true, startTime: true, endTime: true, venueName: true, city: true, status: true } }),
    prisma.paymentMilestone.findMany({ where: { projectId, organizationId: p.organizationId }, orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }], select: { id: true, title: true, dueDate: true, amount: true, status: true } }),
    prisma.invoice.findMany({ where: { projectId, clientId: p.clientId, organizationId: p.organizationId, status: { notIn: ['DRAFT', 'CANCELLED'] } }, orderBy: { issueDate: 'desc' }, select: { id: true, invoiceNumber: true, issueDate: true, dueDate: true, total: true, amountPaid: true, amountDue: true, status: true } }),
    prisma.payment.findMany({ where: { projectId, clientId: p.clientId, organizationId: p.organizationId, status: 'COMPLETED' }, orderBy: { paymentDate: 'desc' }, take: 50, select: { id: true, paymentNumber: true, amount: true, paymentDate: true, paymentMethod: true } }),
    prisma.delivery.findMany({ where: { projectId, organizationId: p.organizationId, deletedAt: null, status: { not: 'CANCELLED' } }, orderBy: { expectedDate: 'asc' }, select: { id: true, title: true, type: true, status: true, expectedDate: true, deliveredDate: true } }),
    prisma.organization.findUnique({ where: { id: p.organizationId }, select: { name: true, phone: true, email: true, website: true } }),
  ]);
  if (!project) throw notFound('Project');
  const total = Number(project.totalQuotation);
  const received = payments.reduce((a, x) => a + Number(x.amount), 0);
  const num = (d: { toString(): string }) => Number(d.toString());
  return {
    project: { ...project, totalQuotation: total },
    events,
    payments: {
      total, received, balance: Math.max(0, total - received),
      milestones: milestones.map((m) => ({ ...m, amount: num(m.amount) })),
      invoices: invoices.map((i) => ({ ...i, total: num(i.total), amountPaid: num(i.amountPaid), amountDue: num(i.amountDue) })),
      history: payments.map((x) => ({ ...x, amount: num(x.amount) })),
    },
    deliveries,
    studio,
  };
}

// ── Gallery overview ────────────────────────────────────────────────────────
export async function getGallery(p: PortalAuthContext, projectId: string) {
  const project = await requireProject(p, projectId);
  const gallery = await prisma.gallery.findFirst({
    where: { projectId, organizationId: p.organizationId, deletedAt: null },
    select: {
      id: true, title: true, status: true, welcomeMessage: true, albumSelectionTarget: true, expectedDeliveryDate: true, publishedAt: true,
      sections: {
        where: { deletedAt: null, isVisibleToClient: true }, orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true, name: true, description: true, sectionDate: true, venueName: true, status: true, isDownloadAllowed: true, isShareAllowed: true, hasWatermark: true,
          subFolders: { where: { deletedAt: null, isClientVisible: true }, orderBy: [{ orderIndex: 'asc' }, { name: 'asc' }], select: { id: true, name: true } },
        },
      },
    },
  });
  const studio = await prisma.organization.findUnique({ where: { id: p.organizationId }, select: { name: true, phone: true, email: true, website: true } });
  if (!gallery || gallery.status !== 'PUBLISHED') {
    return { available: false, project, gallery: gallery ? { title: gallery.title, expectedDeliveryDate: gallery.expectedDeliveryDate } : null, sections: [], totals: { media: 0, photos: 0, videos: 0 }, selection: null, studio };
  }

  const scope = mediaScope(p, { galleryId: gallery.id });
  const [bySection, bySub, kinds, mine, albumRows, submitted] = await Promise.all([
    prisma.galleryMedia.groupBy({ by: ['sectionId'], where: scope, _count: { _all: true } }),
    prisma.galleryMedia.groupBy({ by: ['subFolderId'], where: { ...scope, subFolderId: { not: null } }, _count: { _all: true } }),
    prisma.galleryMedia.groupBy({ by: ['mediaType'], where: scope, _count: { _all: true } }),
    prisma.galleryMediaSelection.count({ where: { portalUserId: p.portalUserId, kind: 'FAVORITE', media: scope } }),
    prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(DISTINCT s.media_id) AS n FROM gallery_media_selections s JOIN client_portal_users u ON u.id = s.portal_user_id JOIN gallery_media m ON m.id = s.media_id WHERE s.kind = 'ALBUM' AND u.client_id = ${p.clientId}::uuid AND m.gallery_id = ${gallery.id}::uuid AND m.deleted_at IS NULL`,
    prisma.clientPortalRequest.findFirst({ where: { galleryId: gallery.id, portalUser: { clientId: p.clientId }, type: 'ALBUM_CHANGE', title: { startsWith: 'Album selection submitted' }, deletedAt: null }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, status: true } }),
  ]);
  const secCount = new Map(bySection.map((r) => [r.sectionId, r._count._all]));
  const subCount = new Map(bySub.map((r) => [r.subFolderId as string, r._count._all]));
  const kindCount = new Map(kinds.map((r) => [r.mediaType, r._count._all]));
  const total = [...secCount.values()].reduce((a, b) => a + b, 0);

  return {
    available: true,
    project,
    gallery: { id: gallery.id, title: gallery.title, welcomeMessage: gallery.welcomeMessage, albumSelectionTarget: gallery.albumSelectionTarget, expectedDeliveryDate: gallery.expectedDeliveryDate, publishedAt: gallery.publishedAt },
    sections: gallery.sections.map((s) => ({
      id: s.id, name: s.name, description: s.description, sectionDate: s.sectionDate, venueName: s.venueName, status: s.status,
      downloadAllowed: s.isDownloadAllowed, shareAllowed: s.isShareAllowed, watermark: s.hasWatermark, mediaCount: secCount.get(s.id) ?? 0,
      subFolders: s.subFolders.map((f) => ({ id: f.id, name: f.name, mediaCount: subCount.get(f.id) ?? 0 })),
    })),
    totals: { media: total, photos: kindCount.get('IMAGE') ?? 0, videos: kindCount.get('VIDEO') ?? 0 },
    selection: { favorites: mine, album: Number(albumRows[0]?.n ?? 0), albumTarget: gallery.albumSelectionTarget, submittedAt: submitted?.createdAt ?? null, submissionStatus: submitted?.status ?? null },
    studio,
  };
}

// ── Media listing (keyset pagination: stable and O(page) however large the gallery) ─
type Cursor = { o: number; c: string; i: string };
const encodeCursor = (m: { orderIndex: number; createdAt: Date; id: string }) => Buffer.from(JSON.stringify({ o: m.orderIndex, c: m.createdAt.toISOString(), i: m.id } satisfies Cursor)).toString('base64url');
function decodeCursor(raw?: string): Cursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString()) as Cursor;
    if (typeof c.o !== 'number' || typeof c.c !== 'string' || typeof c.i !== 'string' || Number.isNaN(Date.parse(c.c))) throw new Error('bad');
    return c;
  } catch { throw badRequest('Invalid cursor'); }
}

export interface MediaQuery { sectionId?: string; subFolderId?: string; filter?: 'favorites' | 'album' | 'photos' | 'videos'; limit?: number; cursor?: string }

export async function listMedia(p: PortalAuthContext, projectId: string, q: MediaQuery) {
  await requireProject(p, projectId);
  const limit = Math.min(Math.max(q.limit ?? PAGE_SIZE_DEFAULT, 1), PAGE_SIZE_MAX);
  const cur = decodeCursor(q.cursor);
  const where: Prisma.GalleryMediaWhereInput = mediaScope(p, {
    gallery: { projectId, status: 'PUBLISHED', deletedAt: null, project: { clientId: p.clientId, deletedAt: null } },
    ...(q.sectionId ? { sectionId: q.sectionId } : {}),
    ...(q.subFolderId ? { subFolderId: q.subFolderId } : {}),
    ...(q.filter === 'photos' ? { mediaType: 'IMAGE' } : q.filter === 'videos' ? { mediaType: 'VIDEO' } : {}),
    ...(q.filter === 'favorites' ? { selections: { some: { portalUserId: p.portalUserId, kind: 'FAVORITE' } } } : {}),
    ...(q.filter === 'album' ? { selections: { some: { kind: 'ALBUM', portalUser: { clientId: p.clientId } } } } : {}),
    ...(cur ? { OR: [
      { orderIndex: { gt: cur.o } },
      { orderIndex: cur.o, createdAt: { gt: new Date(cur.c) } },
      { orderIndex: cur.o, createdAt: new Date(cur.c), id: { gt: cur.i } },
    ] } : {}),
  });
  const rows = await prisma.galleryMedia.findMany({
    where, take: limit + 1, orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: { ...MEDIA_SELECT, selections: { where: { OR: [{ portalUserId: p.portalUserId, kind: 'FAVORITE' }, { kind: 'ALBUM', portalUser: { clientId: p.clientId } }] }, select: { kind: true, portalUserId: true } } },
  });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((m) => ({
      id: m.id, sectionId: m.sectionId, subFolderId: m.subFolderId, title: m.title, mediaType: m.mediaType, orientation: m.orientation, durationSeconds: m.durationSeconds,
      ...presentVariants(m),
      isFavorite: m.selections.some((s) => s.kind === 'FAVORITE' && s.portalUserId === p.portalUserId),
      isAlbumPick: m.selections.some((s) => s.kind === 'ALBUM'),
      downloadAllowed: canDownload(m),
      watermarked: m.section.hasWatermark,
    })),
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
  };
}

export async function getMedia(p: PortalAuthContext, mediaId: string) {
  const m = await requireMedia(p, mediaId);
  const [fav, album, comments] = await Promise.all([
    prisma.galleryMediaSelection.findFirst({ where: { mediaId, portalUserId: p.portalUserId, kind: 'FAVORITE' }, select: { id: true } }),
    prisma.galleryMediaSelection.findFirst({ where: { mediaId, kind: 'ALBUM', portalUser: { clientId: p.clientId } }, select: { id: true } }),
    listComments(p, { mediaId }),
  ]);
  return {
    id: m.id, title: m.title, mediaType: m.mediaType, sectionId: m.sectionId, sectionName: m.section.name, durationSeconds: m.durationSeconds,
    ...presentVariants(m), isFavorite: Boolean(fav), isAlbumPick: Boolean(album), downloadAllowed: canDownload(m), originalName: m.file.originalName, sizeBytes: Number(m.file.sizeBytes), comments,
  };
}

// ── Selections ──────────────────────────────────────────────────────────────
export async function setSelection(p: PortalAuthContext, mediaId: string, kind: GallerySelectionKind, on: boolean) {
  const media = await requireMedia(p, mediaId);
  if (!on) {
    await prisma.galleryMediaSelection.deleteMany({ where: { mediaId, kind, ...(kind === 'FAVORITE' ? { portalUserId: p.portalUserId } : { portalUser: { clientId: p.clientId } }) } });
  } else {
    if (kind === 'ALBUM') {
      const gallery = await prisma.gallery.findUniqueOrThrow({ where: { id: media.galleryId }, select: { albumSelectionTarget: true } });
      const [{ n }] = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(DISTINCT s.media_id) AS n FROM gallery_media_selections s JOIN client_portal_users u ON u.id = s.portal_user_id JOIN gallery_media m ON m.id = s.media_id WHERE s.kind = 'ALBUM' AND u.client_id = ${p.clientId}::uuid AND m.gallery_id = ${media.galleryId}::uuid AND m.deleted_at IS NULL`;
      const already = await prisma.galleryMediaSelection.findFirst({ where: { mediaId, kind: 'ALBUM', portalUser: { clientId: p.clientId } }, select: { id: true } });
      if (!already && Number(n) >= gallery.albumSelectionTarget) throw conflict(`Your album is full (${gallery.albumSelectionTarget} photographs). Remove one to add another.`);
    }
    await prisma.galleryMediaSelection.createMany({ data: [{ organizationId: p.organizationId, mediaId, portalUserId: p.portalUserId, kind }], skipDuplicates: true });
  }
  return { mediaId, kind, on };
}

export async function submitAlbumSelection(p: PortalAuthContext, projectId: string) {
  await requireProject(p, projectId);
  const g = await getGallery(p, projectId);
  if (!g.available || !g.gallery || !g.selection) throw badRequest('The gallery is not available yet.');
  if (g.selection.album === 0) throw badRequest('Choose at least one photograph for your album first.');
  const title = `Album selection submitted (${g.selection.album} of ${g.selection.albumTarget})`;
  const request = await prisma.clientPortalRequest.create({
    data: { organizationId: p.organizationId, galleryId: g.gallery.id, projectId, portalUserId: p.portalUserId, type: 'ALBUM_CHANGE', title, description: `${p.fullName} has finished choosing photographs for the album: ${g.selection.album} selected (target ${g.selection.albumTarget}).` },
    select: { id: true, createdAt: true },
  });
  await notifyStudioStaff(p.organizationId, projectId, { title: `Album selection submitted — ${g.project.name}`, message: `${p.fullName} selected ${g.selection.album} photographs.`, entityType: 'ClientPortalRequest', entityId: request.id });
  return { requestId: request.id, submittedAt: request.createdAt, album: g.selection.album };
}

// ── Comments ────────────────────────────────────────────────────────────────
export async function listComments(p: PortalAuthContext, q: { mediaId?: string; projectId?: string }) {
  const where: Prisma.ClientPortalCommentWhereInput = {
    organizationId: p.organizationId, deletedAt: null,
    gallery: { project: { clientId: p.clientId, deletedAt: null } },
    ...(q.mediaId ? { mediaId: q.mediaId } : {}),
    ...(q.projectId ? { gallery: { projectId: q.projectId, project: { clientId: p.clientId, deletedAt: null } } } : {}),
  };
  const rows = await prisma.clientPortalComment.findMany({
    where, orderBy: { createdAt: 'asc' }, take: 200,
    select: { id: true, mediaId: true, type: true, body: true, isResolved: true, createdAt: true, portalUserId: true, portalUser: { select: { fullName: true } }, authorUser: { select: { fullName: true } } },
  });
  return rows.map((c) => ({
    id: c.id, mediaId: c.mediaId, type: c.type, body: c.body, isResolved: c.isResolved, createdAt: c.createdAt,
    author: c.portalUserId ? (c.portalUserId === p.portalUserId ? 'You' : c.portalUser?.fullName ?? 'Family') : 'Studio', fromStudio: !c.portalUserId, mine: c.portalUserId === p.portalUserId,
  }));
}

export async function addComment(p: PortalAuthContext, input: { mediaId?: string; projectId?: string; body: string; type?: ClientPortalCommentType }) {
  let galleryId: string; let projectId: string; let label = 'the gallery';
  if (input.mediaId) {
    const m = await requireMedia(p, input.mediaId);
    galleryId = m.galleryId; label = m.title;
    projectId = (await prisma.gallery.findUniqueOrThrow({ where: { id: galleryId }, select: { projectId: true } })).projectId;
  } else if (input.projectId) {
    await requireProject(p, input.projectId);
    const g = await prisma.gallery.findFirst({ where: { projectId: input.projectId, organizationId: p.organizationId, deletedAt: null, status: 'PUBLISHED' }, select: { id: true } });
    if (!g) throw notFound('Gallery');
    galleryId = g.id; projectId = input.projectId;
  } else throw badRequest('A photograph or project is required');
  const comment = await prisma.clientPortalComment.create({
    data: { organizationId: p.organizationId, galleryId, mediaId: input.mediaId ?? null, portalUserId: p.portalUserId, type: input.type ?? 'GENERAL', body: input.body.trim() },
    select: { id: true, createdAt: true },
  });
  if ((input.type ?? 'GENERAL') !== 'GENERAL') {
    await notifyStudioStaff(p.organizationId, projectId, { title: `Client note on ${label}`, message: `${p.fullName}: ${input.body.trim().slice(0, 140)}`, entityType: 'ClientPortalComment', entityId: comment.id });
  }
  return { id: comment.id, createdAt: comment.createdAt };
}

// ── Requests ────────────────────────────────────────────────────────────────
const REQUEST_SELECT = { id: true, type: true, status: true, title: true, description: true, adminResponse: true, relatedMediaId: true, createdAt: true, updatedAt: true, resolvedAt: true } as const;

export async function listRequests(p: PortalAuthContext, projectId: string) {
  await requireProject(p, projectId);
  return prisma.clientPortalRequest.findMany({ where: { projectId, organizationId: p.organizationId, portalUser: { clientId: p.clientId }, deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 100, select: REQUEST_SELECT });
}

export async function createRequest(p: PortalAuthContext, projectId: string, input: { type: ClientPortalRequestType; title: string; description: string; relatedMediaId?: string }) {
  const project = await requireProject(p, projectId);
  const gallery = await prisma.gallery.findFirst({ where: { projectId, organizationId: p.organizationId, deletedAt: null }, select: { id: true } });
  if (!gallery) throw badRequest('Requests open once your gallery has been created.');
  if (input.relatedMediaId) await requireMedia(p, input.relatedMediaId);
  const created = await prisma.clientPortalRequest.create({
    data: { organizationId: p.organizationId, galleryId: gallery.id, projectId, portalUserId: p.portalUserId, type: input.type, title: input.title.trim(), description: input.description.trim(), relatedMediaId: input.relatedMediaId ?? null },
    select: REQUEST_SELECT,
  });
  await notifyStudioStaff(p.organizationId, projectId, { title: `New client request — ${project.name}`, message: `${p.fullName}: ${input.title.trim()}`, entityType: 'ClientPortalRequest', entityId: created.id });
  return created;
}

// ── Share links ─────────────────────────────────────────────────────────────
export type ClientShareAccess = 'VIEW_ONLY' | 'VIEW_DOWNLOAD' | 'SELECTED_ONLY' | 'SECTION_ONLY' | 'FULL_GALLERY';
const SHARE_SELECT = { id: true, token: true, title: true, accessType: true, status: true, watermarkEnabled: true, expiresAt: true, viewsCount: true, downloadsCount: true, passwordHash: true, sectionId: true, createdAt: true, media: { select: { mediaId: true } } } as const;
const presentLink = (l: Prisma.GalleryShareLinkGetPayload<{ select: typeof SHARE_SELECT }>) => ({
  id: l.id, token: l.token, title: l.title, accessType: l.accessType, status: l.status, watermarkEnabled: l.watermarkEnabled, expiresAt: l.expiresAt,
  viewsCount: l.viewsCount, downloadsCount: l.downloadsCount, passwordProtected: Boolean(l.passwordHash), sectionId: l.sectionId, selectedCount: l.media.length, createdAt: l.createdAt,
});

export async function listShareLinks(p: PortalAuthContext, projectId: string) {
  await requireProject(p, projectId);
  const links = await prisma.galleryShareLink.findMany({ where: { organizationId: p.organizationId, gallery: { projectId }, createdByPortalUserId: p.portalUserId, status: { not: 'REVOKED' } }, orderBy: { createdAt: 'desc' }, take: 100, select: SHARE_SELECT });
  return links.map(presentLink);
}

export async function createShareLink(p: PortalAuthContext, projectId: string, input: { title: string; accessType: ClientShareAccess; sectionId?: string; mediaIds?: string[]; password?: string; expiresInDays?: number }) {
  await requireProject(p, projectId);
  const gallery = await prisma.gallery.findFirst({ where: { projectId, organizationId: p.organizationId, deletedAt: null, status: 'PUBLISHED' }, select: { id: true, sections: { where: { deletedAt: null, isVisibleToClient: true }, select: { id: true, isShareAllowed: true, isDownloadAllowed: true } } } });
  if (!gallery) throw notFound('Gallery');
  const shareable = gallery.sections.filter((s) => s.isShareAllowed);
  if (shareable.length === 0) throw forbidden('Your studio has not enabled sharing for this gallery.');
  const wantsDownload = input.accessType === 'VIEW_DOWNLOAD' || input.accessType === 'FULL_GALLERY';
  if (wantsDownload && !shareable.some((s) => s.isDownloadAllowed)) throw forbidden('Downloads are not enabled for the shareable sections.');
  if (input.accessType === 'SECTION_ONLY') {
    if (!input.sectionId || !shareable.some((s) => s.id === input.sectionId)) throw forbidden('That section cannot be shared.');
  }
  if (input.accessType === 'SELECTED_ONLY') {
    if (!input.mediaIds?.length) throw badRequest('Choose at least one photograph to share.');
    const ok = await prisma.galleryMedia.count({ where: mediaScope(p, { id: { in: input.mediaIds }, galleryId: gallery.id, sectionId: { in: shareable.map((s) => s.id) } }) });
    if (ok !== new Set(input.mediaIds).size) throw forbidden('Some of the chosen photographs cannot be shared.');
  }
  const link = await prisma.galleryShareLink.create({
    data: {
      organizationId: p.organizationId, galleryId: gallery.id, sectionId: input.accessType === 'SECTION_ONLY' ? input.sectionId : null,
      token: crypto.randomBytes(16).toString('base64url'), title: input.title.trim(), accessType: input.accessType,
      passwordHash: input.password ? await hashPassword(input.password) : null, watermarkEnabled: true,
      expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null, createdByPortalUserId: p.portalUserId,
      ...(input.accessType === 'SELECTED_ONLY' && input.mediaIds?.length ? { media: { createMany: { data: [...new Set(input.mediaIds)].map((mediaId) => ({ mediaId })) } } } : {}),
    },
    select: SHARE_SELECT,
  });
  await recordAudit(prisma, { organizationId: p.organizationId, actorId: null }, { action: 'CREATE', entityType: 'GalleryShareLink', entityId: link.id, summary: `Client created share link "${input.title}"` });
  return presentLink(link);
}

export async function revokeShareLink(p: PortalAuthContext, projectId: string, linkId: string) {
  await requireProject(p, projectId);
  const link = await prisma.galleryShareLink.findFirst({ where: { id: linkId, organizationId: p.organizationId, gallery: { projectId }, createdByPortalUserId: p.portalUserId }, select: { id: true, status: true } });
  if (!link) throw notFound('Share link');
  if (link.status !== 'REVOKED') await prisma.galleryShareLink.update({ where: { id: link.id }, data: { status: 'REVOKED', revokedAt: new Date() } });
  return { revoked: true };
}

// ── Download ────────────────────────────────────────────────────────────────
export async function downloadMedia(p: PortalAuthContext, mediaId: string) {
  const m = await requireMedia(p, mediaId);
  if (!canDownload(m)) throw forbidden('Downloads are not enabled for this photograph.');
  await prisma.galleryMedia.update({ where: { id: mediaId }, data: { downloadCount: { increment: 1 } } });
  return { url: createSignedUrl(m.file.objectKey, m.file.bucket).url, fileName: m.file.originalName };
}

// ── Notifications ───────────────────────────────────────────────────────────
export async function listNotifications(p: PortalAuthContext, limit = 30) {
  const [items, unread] = await Promise.all([
    prisma.clientPortalNotification.findMany({ where: { portalUserId: p.portalUserId }, orderBy: { createdAt: 'desc' }, take: Math.min(limit, 100), select: { id: true, type: true, title: true, message: true, actionPath: true, actionLabel: true, isRead: true, createdAt: true, projectId: true } }),
    prisma.clientPortalNotification.count({ where: { portalUserId: p.portalUserId, isRead: false } }),
  ]);
  return { items, unread };
}
export async function markNotificationRead(p: PortalAuthContext, id: string) {
  await prisma.clientPortalNotification.updateMany({ where: { id, portalUserId: p.portalUserId, isRead: false }, data: { isRead: true, readAt: new Date() } });
  return { id };
}
export async function markAllNotificationsRead(p: PortalAuthContext) {
  const r = await prisma.clientPortalNotification.updateMany({ where: { portalUserId: p.portalUserId, isRead: false }, data: { isRead: true, readAt: new Date() } });
  return { updated: r.count };
}
