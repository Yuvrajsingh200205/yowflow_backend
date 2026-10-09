import { Router } from 'express';
import { asyncHandler } from '../utils/http';
import { sendSuccess } from '../utils/response';
import { validate } from '../middleware/validate';
import { sharedGalleryQuery } from '../validators/project.validator';
import * as galleryMediaService from '../services/galleryMedia.service';

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
