import { GalleryMediaCategory, GalleryMediaType } from '@prisma/client';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { badRequest, forbidden, notFound, serviceUnavailable, unauthenticated } from '../utils/errors';
import { AuthContext } from '../types';
import { AuditRequestContext, recordAudit } from './audit.service';
import { createUploadIntent, registerFile } from './file.service';
import { abortMultipartUpload, completeMultipartUpload, createMultipartUpload, createSignedUrl, getStorageProvider, localObjectPath, presignPartUrl, supportsMultipart } from './storage.service';
import { buildObjectKey } from './storage.service';
import { scopedProjectWhere } from './project.service';
import { generateImageDerivatives } from './derivative.service';
import { hashPassword, verifyPassword } from '../utils/password';

/**
 * Photographs and films the studio uploads for one wedding. The bytes go
 * through the existing signed FileObject workflow — the API never proxies file
 * content — and this service records what each file is within the project's
 * gallery so the client portal can present it.
 */
const ENTITY_TYPE = 'GALLERY_MEDIA';

/** Section every upload lands in unless the studio names one. */
const DEFAULT_SECTION_NAME = 'Wedding Gallery';

export async function requireProject(auth: AuthContext, projectId: string) {
  // scopedProjectWhere applies the caller's project visibility, so this single
  // read is both the authorisation check and the lookup.
  const project = await prisma.project.findFirst({
    where: scopedProjectWhere(auth, { id: projectId }),
    select: { id: true, name: true },
  });
  if (!project) throw notFound('Project');
  return project;
}

const mediaTypeFor = (mimeType: string): GalleryMediaType =>
  mimeType.startsWith('image/') ? 'IMAGE' : mimeType.startsWith('video/') ? 'VIDEO' : 'DOCUMENT';

const categoryFor = (mediaType: GalleryMediaType): GalleryMediaCategory =>
  mediaType === 'VIDEO' ? 'VIDEOS' : mediaType === 'DOCUMENT' ? 'DOCUMENTS' : 'PHOTOS';

/** Signed URLs for the small renditions; falls back to the original when none were generated. */
export function presentVariants(media: {
  file: { objectKey: string; bucket: string };
  width?: number | null;
  height?: number | null;
  derivatives?: Array<{ kind: string; file: { objectKey: string; bucket: string } }>;
}) {
  const urlFor = (kind: string) => {
    const d = media.derivatives?.find((x) => x.kind === kind);
    return d ? createSignedUrl(d.file.objectKey, d.file.bucket).url : null;
  };
  const original = () => createSignedUrl(media.file.objectKey, media.file.bucket).url;
  const preview = urlFor('PREVIEW');
  return {
    thumbUrl: urlFor('THUMBNAIL') ?? preview ?? original(),
    previewUrl: preview ?? original(),
    width: media.width ?? null,
    height: media.height ?? null,
  };
}

/** Shapes a media row for the studio, including a short-lived URL for the original file. */
function present(media: {
  id: string;
  sectionId: string;
  title: string;
  mediaType: GalleryMediaType;
  category: GalleryMediaCategory;
  orderIndex: number;
  isClientVisible: boolean;
  isDownloadAllowed: boolean;
  createdAt: Date;
  width?: number | null;
  height?: number | null;
  derivatives?: Array<{ kind: string; file: { objectKey: string; bucket: string } }>;
  section: { id: string; name: string };
  file: { objectKey: string; bucket: string; mimeType: string; sizeBytes: bigint; originalName: string };
}) {
  return {
    ...presentVariants(media),
    id: media.id,
    sectionId: media.sectionId,
    sectionName: media.section.name,
    title: media.title,
    mediaType: media.mediaType,
    category: media.category,
    orderIndex: media.orderIndex,
    isClientVisible: media.isClientVisible,
    isDownloadAllowed: media.isDownloadAllowed,
    originalName: media.file.originalName,
    mimeType: media.file.mimeType,
    sizeBytes: Number(media.file.sizeBytes),
    url: createSignedUrl(media.file.objectKey, media.file.bucket).url,
    createdAt: media.createdAt,
  };
}

const MEDIA_INCLUDE = {
  derivatives: { select: { kind: true, file: { select: { objectKey: true, bucket: true } } } },
  section: { select: { id: true, name: true } },
  file: { select: { objectKey: true, bucket: true, mimeType: true, sizeBytes: true, originalName: true } },
} as const;

/** The whole gallery for one wedding: its sections and every uploaded file. */
export async function getProjectGallery(auth: AuthContext, projectId: string) {
  await requireProject(auth, projectId);

  // The portal's concierge panel shows real studio contact details rather than
  // hardcoded ones, so they travel with the gallery.
  const studio = await prisma.organization.findFirst({
    where: { id: auth.organizationId },
    select: { name: true, phone: true, email: true, website: true },
  });

  const gallery = await prisma.gallery.findFirst({
    where: { projectId, organizationId: auth.organizationId, deletedAt: null },
    select: {
      id: true,
      title: true,
      status: true,
      albumSelectionTarget: true,
      sections: {
        where: { deletedAt: null },
        orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          name: true,
          orderIndex: true,
          isVisibleToClient: true,
          isDownloadAllowed: true,
          hasWatermark: true,
        },
      },
      media: {
        where: { deletedAt: null },
        orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
        include: MEDIA_INCLUDE,
      },
    },
  });
  if (!gallery) return { gallery: null, sections: [], media: [], studio };

  const { sections, media, ...summary } = gallery;
  return { gallery: summary, sections, media: media.map(present), studio };
}

export async function createGalleryUploadIntent(
  auth: AuthContext,
  projectId: string,
  input: { originalName: string; mimeType: string },
) {
  await requireProject(auth, projectId);
  return createUploadIntent(auth, { ...input, entityType: ENTITY_TYPE, projectId });
}

/**
 * Records an uploaded file as gallery media, creating the project's gallery and
 * the target section on first use so the studio never has to set them up first.
 */
export async function addGalleryMedia(
  auth: AuthContext,
  projectId: string,
  input: {
    bucket: string;
    objectKey: string;
    originalName: string;
    mimeType: string;
    sizeBytes: number;
    title?: string;
    sectionName?: string;
  },
  ctx: AuditRequestContext,
) {
  const project = await requireProject(auth, projectId);
  const file = await registerFile(
    auth,
    {
      entityType: ENTITY_TYPE,
      projectId,
      bucket: input.bucket,
      objectKey: input.objectKey,
      originalName: input.originalName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
    },
    ctx,
  );

  const sectionName = input.sectionName?.trim() || DEFAULT_SECTION_NAME;
  const mediaType = mediaTypeFor(input.mimeType);

  // Every query against a managed database in another region costs real time,
  // so this path is written to make as few as possible. One lookup resolves
  // both the gallery and the target section; the gallery and section are only
  // created on the first upload into them. Chaining these inside a single
  // interactive transaction is what blew Prisma's 5s limit and surfaced as a
  // bare "database error".
  const lookup = (db: Pick<typeof prisma, 'gallerySection'>) => db.gallerySection.findFirst({
    where: { name: sectionName, deletedAt: null, gallery: { projectId, deletedAt: null } },
    select: { id: true, galleryId: true },
  });
  let section = await lookup(prisma);

  if (!section) {
    // First upload into this section. Parallel uploads (a studio dropping a folder, or two
    // people at once) would each try to create the gallery and the section, so creation is
    // serialised per project with an advisory lock and re-checked inside it.
    section = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${projectId}))`;
        const existing = await lookup(tx);
        if (existing) return existing;
        const gallery = await tx.gallery.upsert({
          where: { projectId },
          create: { organizationId: auth.organizationId, projectId, title: project.name ?? 'Wedding Gallery', status: 'DRAFT' },
          update: {},
          select: { id: true },
        });
        return tx.gallerySection.create({
          data: {
            organizationId: auth.organizationId,
            galleryId: gallery.id,
            name: sectionName,
            // A section the studio uploaded into is meant to be seen, so it opens
            // visible and unwatermarked rather than needing a second trip.
            isVisibleToClient: true,
            isDownloadAllowed: true,
            isShareAllowed: true,
            hasWatermark: false,
          },
          select: { id: true, galleryId: true },
        });
      },
      { timeout: 15_000, maxWait: 10_000 },
    );
  }

  // orderIndex stays at its default and the gallery reads back in upload order.
  // Counting rows first would buy an explicit sequence at the cost of another
  // round trip, and nothing reorders a gallery yet.
  return prisma.$transaction(
    async (tx) => {
      const media = await tx.galleryMedia.create({
        data: {
          organizationId: auth.organizationId,
          galleryId: section!.galleryId,
          sectionId: section!.id,
          fileId: file.id,
          title: input.title?.trim() || input.originalName,
          mediaType,
          category: categoryFor(mediaType),
        },
        include: MEDIA_INCLUDE,
      });

      await recordAudit(tx, ctx, {
        action: 'CREATE',
        entityType: 'GalleryMedia',
        entityId: media.id,
        summary: `Gallery media ${media.title} added to ${sectionName}`,
        newData: { projectId, sectionName, originalName: input.originalName },
      });

      return media;
    },
    // Headroom for a slow managed database rather than the 5s default.
    { timeout: 20_000, maxWait: 10_000 },
  ).then(async (media) => {
    // Thumbnails/previews are best-effort; the photograph is usable without them.
    if (mediaType === 'IMAGE' && (await generateImageDerivatives(media.id)).generated > 0) {
      const fresh = await prisma.galleryMedia.findUnique({ where: { id: media.id }, include: MEDIA_INCLUDE });
      if (fresh) return present(fresh);
    }
    return present(media);
  });
}

/** Generates thumbnails for photographs uploaded before derivatives existed (or whose generation failed). */
export async function backfillDerivatives(auth: AuthContext, projectId: string, limit = 25) {
  await requireProject(auth, projectId);
  const pending = await prisma.galleryMedia.findMany({
    where: { organizationId: auth.organizationId, gallery: { projectId }, deletedAt: null, mediaType: 'IMAGE', OR: [{ derivatives: { none: {} } }, { width: null }] },
    select: { id: true },
    take: Math.min(Math.max(limit, 1), 50),
    orderBy: { createdAt: 'asc' },
  });
  let generated = 0;
  for (const m of pending) generated += (await generateImageDerivatives(m.id)).generated;
  const remaining = await prisma.galleryMedia.count({
    where: { organizationId: auth.organizationId, gallery: { projectId }, deletedAt: null, mediaType: 'IMAGE', OR: [{ derivatives: { none: {} } }, { width: null }] },
  });
  return { processed: pending.length, generated, remaining };
}

export async function deleteGalleryMedia(
  auth: AuthContext,
  projectId: string,
  mediaId: string,
  ctx: AuditRequestContext,
) {
  await requireProject(auth, projectId);
  const media = await prisma.galleryMedia.findFirst({
    where: { id: mediaId, organizationId: auth.organizationId, gallery: { projectId }, deletedAt: null },
    include: { file: { select: { id: true, objectKey: true, originalName: true } } },
  });
  if (!media) throw notFound('Gallery media');

  // A wedding photograph is not reusable master data, so removing it deletes
  // the stored object too rather than leaving it orphaned in the bucket.
  if (getStorageProvider() === 'LOCAL') {
    const target = localObjectPath(media.file.objectKey);
    if (target) {
      try {
        await fs.unlink(target);
      } catch (error: unknown) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.galleryMedia.delete({ where: { id: media.id } });
    await tx.fileObject.delete({ where: { id: media.file.id } });
    await recordAudit(tx, ctx, {
      action: 'DELETE',
      entityType: 'GalleryMedia',
      entityId: media.id,
      summary: `Gallery media ${media.title} permanently deleted`,
      oldData: { projectId, originalName: media.file.originalName },
    });
  }, { timeout: 20_000, maxWait: 10_000 });
}

// ---------------------------------------------------------------------------
// Share links
//
// A couple hands these to family. The token is the only credential, so it is
// generated from a CSPRNG rather than derived from the title, any password is
// hashed, and revocation is explicit so a circulated link can be killed.
// ---------------------------------------------------------------------------

export type ShareAccess = 'VIEW_ONLY' | 'VIEW_DOWNLOAD' | 'SELECTED_ONLY' | 'SECTION_ONLY' | 'FULL_GALLERY';

function presentShareLink(link: {
  id: string;
  token: string;
  title: string;
  accessType: ShareAccess;
  status: string;
  watermarkEnabled: boolean;
  expiresAt: Date | null;
  viewsCount: number;
  downloadsCount: number;
  passwordHash: string | null;
  createdAt: Date;
  sectionId: string | null;
  media?: Array<{ mediaId: string }>;
}) {
  return {
    id: link.id,
    token: link.token,
    title: link.title,
    accessType: link.accessType,
    status: link.status,
    watermarkEnabled: link.watermarkEnabled,
    expiresAt: link.expiresAt,
    viewsCount: link.viewsCount,
    downloadsCount: link.downloadsCount,
    // Never leak the hash; the portal only needs to know a password is set.
    passwordProtected: Boolean(link.passwordHash),
    sectionId: link.sectionId,
    selectedMediaIds: link.media?.map((m) => m.mediaId) ?? [],
    createdAt: link.createdAt,
  };
}

const SHARE_SELECT = {
  id: true, token: true, title: true, accessType: true, status: true,
  watermarkEnabled: true, expiresAt: true, viewsCount: true, downloadsCount: true,
  passwordHash: true, createdAt: true, sectionId: true,
  media: { select: { mediaId: true } },
} as const;

export async function listShareLinks(auth: AuthContext, projectId: string) {
  await requireProject(auth, projectId);
  const links = await prisma.galleryShareLink.findMany({
    where: { gallery: { projectId }, organizationId: auth.organizationId },
    orderBy: { createdAt: 'desc' },
    select: SHARE_SELECT,
  });
  return links.map(presentShareLink);
}

export async function createShareLink(
  auth: AuthContext,
  projectId: string,
  input: {
    title: string;
    accessType: ShareAccess;
    sectionId?: string;
    mediaIds?: string[];
    password?: string;
    expiresAt?: string;
    watermarkEnabled?: boolean;
  },
  ctx: AuditRequestContext,
) {
  await requireProject(auth, projectId);
  const gallery = await prisma.gallery.findFirst({
    where: { projectId, organizationId: auth.organizationId, deletedAt: null },
    select: { id: true },
  });
  if (!gallery) throw notFound('Gallery');

  const link = await prisma.galleryShareLink.create({
    data: {
      organizationId: auth.organizationId,
      galleryId: gallery.id,
      sectionId: input.sectionId ?? null,
      token: crypto.randomBytes(16).toString('base64url'),
      title: input.title,
      accessType: input.accessType,
      passwordHash: input.password ? await hashPassword(input.password) : null,
      watermarkEnabled: input.watermarkEnabled ?? true,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      createdById: auth.userId,
      ...(input.accessType === 'SELECTED_ONLY' && input.mediaIds?.length
        ? { media: { createMany: { data: input.mediaIds.map((mediaId) => ({ mediaId })) } } }
        : {}),
    },
    select: SHARE_SELECT,
  });

  await recordAudit(prisma, ctx, {
    action: 'CREATE', entityType: 'GalleryShareLink', entityId: link.id,
    summary: `Share link "${input.title}" created`,
    newData: { projectId, accessType: input.accessType },
  });
  return presentShareLink(link);
}

export async function revokeShareLink(auth: AuthContext, projectId: string, linkId: string, ctx: AuditRequestContext) {
  await requireProject(auth, projectId);
  const link = await prisma.galleryShareLink.findFirst({
    where: { id: linkId, organizationId: auth.organizationId, gallery: { projectId } },
    select: { id: true, title: true, status: true },
  });
  if (!link) throw notFound('Share link');
  if (link.status === 'REVOKED') return { revoked: true };

  await prisma.galleryShareLink.update({
    where: { id: link.id },
    // The CHECK constraint ties REVOKED to revokedAt, so both move together.
    data: { status: 'REVOKED', revokedAt: new Date() },
  });
  await recordAudit(prisma, ctx, {
    action: 'DELETE', entityType: 'GalleryShareLink', entityId: link.id,
    summary: `Share link "${link.title}" revoked`, oldData: { projectId },
  });
  return { revoked: true };
}

/**
 * Resolves a share token for an anonymous visitor. Returns only what the link
 * grants: never the whole gallery unless that is what was shared, and never a
 * section the studio has hidden.
 */
export async function openSharedGallery(token: string, password?: string) {
  const link = await prisma.galleryShareLink.findFirst({
    where: { token },
    select: {
      ...SHARE_SELECT,
      gallery: {
        select: {
          title: true,
          project: { select: { name: true } },
          organization: { select: { name: true } },
        },
      },
    },
  });
  if (!link) throw notFound('Shared gallery');
  if (link.status !== 'ACTIVE') throw forbidden('This link has been revoked');
  if (link.expiresAt && link.expiresAt.getTime() < Date.now()) throw forbidden('This link has expired');
  if (link.passwordHash) {
    if (!password) throw unauthenticated('This gallery is password protected');
    if (!(await verifyPassword(password, link.passwordHash))) throw unauthenticated('Incorrect password');
  }

  const selectedIds = link.media.map((m) => m.mediaId);
  const media = await prisma.galleryMedia.findMany({
    where: {
      deletedAt: null,
      isClientVisible: true,
      // A hidden section stays hidden however the link was configured.
      section: { isVisibleToClient: true, isShareAllowed: true, deletedAt: null },
      gallery: { shareLinks: { some: { id: link.id } } },
      ...(link.accessType === 'SELECTED_ONLY' ? { id: { in: selectedIds } } : {}),
      ...(link.accessType === 'SECTION_ONLY' && link.sectionId ? { sectionId: link.sectionId } : {}),
    },
    orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
    include: MEDIA_INCLUDE,
  });

  await prisma.galleryShareLink.update({ where: { id: link.id }, data: { viewsCount: { increment: 1 } } });

  return {
    title: link.title,
    galleryTitle: link.gallery.title,
    projectName: link.gallery.project.name,
    studioName: link.gallery.organization.name,
    accessType: link.accessType,
    watermarkEnabled: link.watermarkEnabled,
    downloadAllowed: link.accessType === 'VIEW_DOWNLOAD' || link.accessType === 'FULL_GALLERY',
    media: media.map((m) => {
      const full = present(m);
      const canDownload = (link.accessType === 'VIEW_DOWNLOAD' || link.accessType === 'FULL_GALLERY') && m.isDownloadAllowed;
      // Viewers only get the original file when the link (and the media) allow downloading.
      return { ...full, url: canDownload ? full.url : full.previewUrl };
    }),
  };
}

// ── Large films: multipart upload ───────────────────────────────────────────
const MIB = 1024 * 1024;
const MULTIPART_ENTITY = 'GALLERY_MEDIA';
const MULTIPART_MAX_PARTS = 9000;

/** Begins a multipart upload and hands the browser one signed URL per part. */
export async function startMultipartUpload(auth: AuthContext, projectId: string, input: { originalName: string; mimeType: string; sizeBytes: number }) {
  await requireProject(auth, projectId);
  if (!supportsMultipart()) throw serviceUnavailable('Files over 50 MB need cloud storage (R2 or S3), which is not set up on this deployment.');
  const objectKey = buildObjectKey(auth.organizationId, MULTIPART_ENTITY, input.originalName);
  const bucket = env.STORAGE_BUCKET;
  const uploadId = await createMultipartUpload(objectKey, bucket, input.mimeType);
  const partSize = Math.max(16 * MIB, Math.ceil(input.sizeBytes / MULTIPART_MAX_PARTS / MIB) * MIB);
  const count = Math.ceil(input.sizeBytes / partSize);
  return {
    bucket, objectKey, uploadId, partSize,
    parts: Array.from({ length: count }, (_, i) => ({ partNumber: i + 1, url: presignPartUrl(objectKey, bucket, uploadId, i + 1) })),
  };
}

const ownKey = (auth: AuthContext, objectKey: string) => {
  // A caller may only finish or cancel uploads this studio started.
  if (!objectKey.startsWith(`${auth.organizationId}/${MULTIPART_ENTITY.toLowerCase()}/`)) throw badRequest('That upload does not belong to this studio.');
};

export async function finishMultipartUpload(auth: AuthContext, projectId: string, input: { objectKey: string; uploadId: string; parts: Array<{ partNumber: number; etag: string }> }) {
  await requireProject(auth, projectId);
  ownKey(auth, input.objectKey);
  if (!supportsMultipart()) throw serviceUnavailable('Cloud storage is not set up on this deployment.');
  try {
    await completeMultipartUpload(input.objectKey, env.STORAGE_BUCKET, input.uploadId, input.parts);
  } catch {
    throw badRequest('The upload could not be completed. Please try the file again.');
  }
  return { bucket: env.STORAGE_BUCKET, objectKey: input.objectKey };
}

export async function cancelMultipartUpload(auth: AuthContext, projectId: string, input: { objectKey: string; uploadId: string }) {
  await requireProject(auth, projectId);
  ownKey(auth, input.objectKey);
  if (supportsMultipart()) await abortMultipartUpload(input.objectKey, env.STORAGE_BUCKET, input.uploadId);
  return { aborted: true };
}
