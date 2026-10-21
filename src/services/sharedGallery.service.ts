import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { badRequest, forbidden, notFound, unauthenticated } from '../utils/errors';
import { verifyPassword } from '../utils/password';
import { createSignedUrl } from './storage.service';
import { presentVariants } from './galleryMedia.service';

/**
 * Anonymous viewing of a shared link, built to stay fast on very large galleries:
 * one small call for the header and sections, then keyset-paginated pages of
 * thumbnails. Originals are only ever handed out through `download`, and only when
 * both the link and the section allow it.
 */

const PAGE_DEFAULT = 60;
const PAGE_MAX = 120;

async function resolve(token: string, password?: string) {
  const link = await prisma.galleryShareLink.findFirst({
    where: { token },
    select: {
      id: true, title: true, status: true, accessType: true, expiresAt: true, passwordHash: true, sectionId: true, watermarkEnabled: true, galleryId: true,
      media: { select: { mediaId: true } },
      gallery: { select: { title: true, status: true, deletedAt: true, project: { select: { name: true } }, organization: { select: { name: true, phone: true, email: true } } } },
    },
  });
  if (!link || link.gallery.deletedAt) throw notFound('Shared gallery');
  if (link.status !== 'ACTIVE') throw forbidden('This link has been turned off');
  if (link.expiresAt && link.expiresAt.getTime() < Date.now()) throw forbidden('This link has expired');
  if (link.passwordHash) {
    if (!password) throw unauthenticated('This gallery is password protected');
    if (!(await verifyPassword(password, link.passwordHash))) throw unauthenticated('Incorrect password');
  }
  return link;
}

type Link = Awaited<ReturnType<typeof resolve>>;
const linkDownloads = (l: Link) => l.accessType === 'VIEW_DOWNLOAD' || l.accessType === 'FULL_GALLERY';

const scope = (l: Link, extra: Prisma.GalleryMediaWhereInput = {}): Prisma.GalleryMediaWhereInput => ({
  galleryId: l.galleryId, deletedAt: null, isClientVisible: true,
  // A hidden or non-shareable section stays hidden however the link was configured.
  section: { isVisibleToClient: true, isShareAllowed: true, deletedAt: null },
  ...(l.accessType === 'SELECTED_ONLY' ? { id: { in: l.media.map((m) => m.mediaId) } } : {}),
  ...(l.accessType === 'SECTION_ONLY' && l.sectionId ? { sectionId: l.sectionId } : {}),
  ...extra,
});

export async function openShared(token: string, password?: string) {
  const l = await resolve(token, password);
  const [bySection, sections] = await Promise.all([
    prisma.galleryMedia.groupBy({ by: ['sectionId'], where: scope(l), _count: { _all: true } }),
    prisma.gallerySection.findMany({ where: { galleryId: l.galleryId, deletedAt: null, isVisibleToClient: true, isShareAllowed: true, ...(l.accessType === 'SECTION_ONLY' && l.sectionId ? { id: l.sectionId } : {}) }, orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }], select: { id: true, name: true } }),
  ]);
  const count = new Map(bySection.map((r) => [r.sectionId, r._count._all]));
  const visible = sections.map((s) => ({ id: s.id, name: s.name, mediaCount: count.get(s.id) ?? 0 })).filter((s) => s.mediaCount > 0);
  await prisma.galleryShareLink.update({ where: { id: l.id }, data: { viewsCount: { increment: 1 } } });
  return {
    title: l.title,
    galleryTitle: l.gallery.title,
    projectName: l.gallery.project.name,
    studio: l.gallery.organization,
    accessType: l.accessType,
    watermarkEnabled: l.watermarkEnabled,
    downloadAllowed: linkDownloads(l),
    sections: visible,
    total: visible.reduce((a, s) => a + s.mediaCount, 0),
  };
}

type Cursor = { o: number; c: string; i: string };
function decode(raw?: string): Cursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString()) as Cursor;
    if (typeof c.o !== 'number' || typeof c.c !== 'string' || typeof c.i !== 'string' || Number.isNaN(Date.parse(c.c))) throw new Error('bad');
    return c;
  } catch { throw badRequest('Invalid cursor'); }
}

export async function listSharedMedia(token: string, password: string | undefined, q: { sectionId?: string; cursor?: string; limit?: number }) {
  const l = await resolve(token, password);
  const limit = Math.min(Math.max(q.limit ?? PAGE_DEFAULT, 1), PAGE_MAX);
  const cur = decode(q.cursor);
  const rows = await prisma.galleryMedia.findMany({
    where: scope(l, {
      ...(q.sectionId ? { sectionId: q.sectionId } : {}),
      ...(cur ? { OR: [{ orderIndex: { gt: cur.o } }, { orderIndex: cur.o, createdAt: { gt: new Date(cur.c) } }, { orderIndex: cur.o, createdAt: new Date(cur.c), id: { gt: cur.i } }] } : {}),
    }),
    take: limit + 1,
    orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true, title: true, mediaType: true, width: true, height: true, orderIndex: true, createdAt: true, isDownloadAllowed: true, sectionId: true,
      section: { select: { isDownloadAllowed: true, hasWatermark: true } },
      file: { select: { objectKey: true, bucket: true } },
      derivatives: { select: { kind: true, file: { select: { objectKey: true, bucket: true } } } },
    },
  });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((m) => ({
      id: m.id, sectionId: m.sectionId, title: m.title, mediaType: m.mediaType, ...presentVariants(m),
      downloadAllowed: linkDownloads(l) && m.isDownloadAllowed && m.section.isDownloadAllowed,
      watermarked: m.section.hasWatermark || l.watermarkEnabled,
    })),
    nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ o: last.orderIndex, c: last.createdAt.toISOString(), i: last.id } satisfies Cursor)).toString('base64url') : null,
  };
}

export async function downloadShared(token: string, password: string | undefined, mediaId: string) {
  const l = await resolve(token, password);
  if (!linkDownloads(l)) throw forbidden('Downloads are not enabled for this link.');
  const m = await prisma.galleryMedia.findFirst({ where: scope(l, { id: mediaId }), select: { isDownloadAllowed: true, section: { select: { isDownloadAllowed: true } }, file: { select: { objectKey: true, bucket: true, originalName: true } } } });
  if (!m) throw notFound('Photograph');
  if (!m.isDownloadAllowed || !m.section.isDownloadAllowed) throw forbidden('Downloads are not enabled for this photograph.');
  await prisma.galleryShareLink.update({ where: { id: l.id }, data: { downloadsCount: { increment: 1 } } });
  return { url: createSignedUrl(m.file.objectKey, m.file.bucket).url, fileName: m.file.originalName };
}
