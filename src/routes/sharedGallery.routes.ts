import { Router } from 'express';
import { asyncHandler } from '../utils/http';
import { sendSuccess } from '../utils/response';
import { validate } from '../middleware/validate';
import { sharedGalleryQuery } from '../validators/project.validator';
import { z } from 'zod';
import * as galleryMediaService from '../services/galleryMedia.service';
import * as shared from '../services/sharedGallery.service';

/**
 * Anonymous access to a gallery the couple shared. Mounted before requireAuth:
 * the token in the URL is the credential, and the service checks revocation,
 * expiry and any password before returning a single photograph.
 */
export const sharedGalleryRouter = Router();

sharedGalleryRouter.get(
  '/:token',
  validate({ query: sharedGalleryQuery }),
  asyncHandler(async (req, res) =>
    sendSuccess(res, await galleryMediaService.openSharedGallery(req.params.token, req.query.password as string | undefined)),
  ),
);

// Paginated viewer API. The password travels in a header so it never lands in URLs or access logs.
const pw = (req: { header: (n: string) => string | undefined; query: Record<string, unknown> }) => req.header('x-share-password') ?? (typeof req.query.password === 'string' ? req.query.password : undefined);
const tokenParam = z.object({ token: z.string().min(8).max(120), mediaId: z.string().uuid().optional() });
const mediaQuery = z.object({ sectionId: z.string().uuid().optional(), cursor: z.string().max(400).optional(), limit: z.coerce.number().int().min(1).max(120).optional(), password: z.string().max(128).optional() });

sharedGalleryRouter.get('/:token/overview', validate({ params: tokenParam }), asyncHandler(async (req, res) => sendSuccess(res, await shared.openShared(req.params.token, pw(req)))));
sharedGalleryRouter.get('/:token/media', validate({ params: tokenParam, query: mediaQuery }), asyncHandler(async (req, res) => sendSuccess(res, await shared.listSharedMedia(req.params.token, pw(req), req.query as { sectionId?: string; cursor?: string; limit?: number }))));
sharedGalleryRouter.get('/:token/media/:mediaId/download', validate({ params: tokenParam }), asyncHandler(async (req, res) => sendSuccess(res, await shared.downloadShared(req.params.token, pw(req), req.params.mediaId))));
