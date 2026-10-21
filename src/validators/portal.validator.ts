import { z } from 'zod';
import { email, password, uuid } from './common.validator';

export const portalLoginSchema = z.object({ email, password: z.string().min(1).max(128) });
export const portalRefreshSchema = z.object({ refreshToken: z.string().min(1).optional() });
export const portalTokenParam = z.object({ token: z.string().min(20).max(200) });
export const portalAcceptInviteSchema = z.object({ password });
export const portalForgotSchema = z.object({ email });
export const portalResetSchema = z.object({ token: z.string().min(20).max(200), password });

export const invitePortalUserSchema = z.object({
  email,
  fullName: z.string().trim().min(2, 'Enter their name').max(160),
  phone: z.string().trim().max(32).optional().or(z.literal('')),
});
export const portalUserParams = z.object({ id: uuid, portalUserId: uuid });
export const portalUserStatusSchema = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']) });

// ── Portal data ─────────────────────────────────────────────────────────────
export const portalProjectParam = z.object({ projectId: uuid });
export const portalMediaParam = z.object({ mediaId: uuid });
export const portalSelectionParam = z.object({ mediaId: uuid, kind: z.enum(['FAVORITE', 'ALBUM']) });
export const portalShareLinkParam = z.object({ projectId: uuid, linkId: uuid });
export const portalNotificationParam = z.object({ id: uuid });

export const portalMediaQuery = z.object({
  sectionId: uuid.optional(),
  subFolderId: uuid.optional(),
  filter: z.enum(['favorites', 'album', 'photos', 'videos']).optional(),
  limit: z.coerce.number().int().min(1).max(120).optional(),
  cursor: z.string().max(400).optional(),
});

export const portalCommentSchema = z.object({
  body: z.string().trim().min(1, 'Write a comment').max(2000),
  type: z.enum(['GENERAL', 'RETOUCH_REQUEST', 'ALBUM_COVER', 'REMOVE_REQUEST']).optional(),
});

export const portalRequestSchema = z.object({
  type: z.enum(['PHOTO_RETOUCH', 'VIDEO_CHANGE', 'ALBUM_CHANGE', 'SONG_CHANGE', 'NAME_CORRECTION', 'DELIVERY_REQUEST', 'OTHER']),
  title: z.string().trim().min(3, 'Give your request a short title').max(200),
  description: z.string().trim().min(5, 'Tell us a little more').max(4000),
  relatedMediaId: uuid.optional(),
});

export const portalShareLinkSchema = z.object({
  title: z.string().trim().min(2).max(200),
  accessType: z.enum(['VIEW_ONLY', 'VIEW_DOWNLOAD', 'SELECTED_ONLY', 'SECTION_ONLY', 'FULL_GALLERY']),
  sectionId: uuid.optional(),
  mediaIds: z.array(uuid).max(500).optional(),
  password: z.string().min(6).max(64).optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

export const portalNotificationQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).optional() });

// ── Staff-side gallery management ───────────────────────────────────────────
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const galleryUpdateSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  welcomeMessage: z.string().trim().max(1000).nullable().optional(),
  albumSelectionTarget: z.number().int().min(0).max(5000).optional(),
  expectedDeliveryDate: dateOnly.nullable().optional(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional(),
}).strict();
const sectionFields = {
  description: z.string().trim().max(500).nullable().optional(),
  sectionDate: dateOnly.nullable().optional(),
  venueName: z.string().trim().max(160).nullable().optional(),
  status: z.enum(['UPCOMING','SHOOT_COMPLETED','EDITING','PREVIEW_READY','GALLERY_READY','DELIVERED']).optional(),
  orderIndex: z.number().int().min(0).max(10000).optional(),
  isVisibleToClient: z.boolean().optional(),
  isDownloadAllowed: z.boolean().optional(),
  isShareAllowed: z.boolean().optional(),
  hasWatermark: z.boolean().optional(),
  eventId: z.string().uuid().nullable().optional(),
};
export const gallerySectionCreateSchema = z.object({ name: z.string().trim().min(1).max(120), ...sectionFields }).strict();
export const gallerySectionUpdateSchema = z.object({ name: z.string().trim().min(1).max(120).optional(), ...sectionFields }).strict();
export const gallerySectionParams = z.object({ id: z.string().uuid(), sectionId: z.string().uuid() });
export const galleryFolderCreateSchema = z.object({ name: z.string().trim().min(1).max(120) }).strict();
export const galleryFolderUpdateSchema = z.object({ name: z.string().trim().min(1).max(120).optional(), isClientVisible: z.boolean().optional() }).strict();
export const galleryFolderParams = z.object({ id: z.string().uuid(), folderId: z.string().uuid() });
export const galleryMediaPatchSchema = z.object({
  mediaIds: z.array(z.string().uuid()).min(1).max(500),
  title: z.string().trim().max(200).optional(),
  isClientVisible: z.boolean().optional(),
  isDownloadAllowed: z.boolean().optional(),
  sectionId: z.string().uuid().optional(),
  subFolderId: z.string().uuid().nullable().optional(),
  orderIndex: z.number().int().min(0).optional(),
}).strict();
export const staffRequestParams = z.object({ id: z.string().uuid(), requestId: z.string().uuid() });
export const staffRequestRespondSchema = z.object({
  status: z.enum(['OPEN', 'IN_PROGRESS', 'WAITING_FOR_CLIENT', 'COMPLETED', 'CLOSED']).optional(),
  adminResponse: z.string().trim().min(1).max(2000).optional(),
}).strict().refine((v) => v.status || v.adminResponse, 'Provide a status or a response.');
export const staffCommentParams = z.object({ id: z.string().uuid(), commentId: z.string().uuid() });
export const staffCommentReplySchema = z.object({ body: z.string().trim().min(1).max(2000) }).strict();
