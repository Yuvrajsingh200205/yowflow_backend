import { Router } from 'express';
import * as controller from '../controllers/portal.controller';
import { authLimiter } from '../middleware/rateLimiter';
import { requirePortalAuth } from '../middleware/portalAuth';
import { validate } from '../middleware/validate';
import {
  portalCommentSchema, portalMediaParam, portalMediaQuery, portalNotificationParam, portalNotificationQuery, portalProjectParam, portalRequestSchema,
  portalSelectionParam, portalShareLinkParam, portalShareLinkSchema,
  portalAcceptInviteSchema, portalForgotSchema, portalLoginSchema, portalRefreshSchema, portalResetSchema, portalTokenParam,
} from '../validators/portal.validator';

/** Everything a couple can do: public sign-in endpoints first, then a session-protected API. */
export const portalRouter = Router();

portalRouter.post('/auth/login', authLimiter, validate({ body: portalLoginSchema }), controller.login);
portalRouter.post('/auth/refresh', authLimiter, validate({ body: portalRefreshSchema }), controller.refresh);
portalRouter.get('/auth/invite/:token', authLimiter, validate({ params: portalTokenParam }), controller.previewInvite);
portalRouter.post('/auth/invite/:token/accept', authLimiter, validate({ params: portalTokenParam, body: portalAcceptInviteSchema }), controller.acceptInvite);
portalRouter.post('/auth/forgot-password', authLimiter, validate({ body: portalForgotSchema }), controller.forgotPassword);
portalRouter.post('/auth/reset-password', authLimiter, validate({ body: portalResetSchema }), controller.resetPassword);

portalRouter.post('/auth/logout', controller.logout);

portalRouter.use(requirePortalAuth);
portalRouter.get('/me', controller.me);

// Projects and payments
portalRouter.get('/projects', controller.listProjects);
portalRouter.get('/projects/:projectId', validate({ params: portalProjectParam }), controller.getProject);

// Gallery
portalRouter.get('/projects/:projectId/gallery', validate({ params: portalProjectParam }), controller.getGallery);
portalRouter.get('/projects/:projectId/gallery/media', validate({ params: portalProjectParam, query: portalMediaQuery }), controller.listMedia);
portalRouter.post('/projects/:projectId/gallery/album-selection/submit', validate({ params: portalProjectParam }), controller.submitAlbum);
portalRouter.get('/media/:mediaId', validate({ params: portalMediaParam }), controller.getMedia);
portalRouter.put('/media/:mediaId/selections/:kind', validate({ params: portalSelectionParam }), controller.putSelection);
portalRouter.delete('/media/:mediaId/selections/:kind', validate({ params: portalSelectionParam }), controller.deleteSelection);
portalRouter.get('/media/:mediaId/download', validate({ params: portalMediaParam }), controller.downloadMedia);

// Conversation with the studio
portalRouter.get('/projects/:projectId/comments', validate({ params: portalProjectParam }), controller.listProjectComments);
portalRouter.post('/projects/:projectId/comments', validate({ params: portalProjectParam, body: portalCommentSchema }), controller.addProjectComment);
portalRouter.post('/media/:mediaId/comments', validate({ params: portalMediaParam, body: portalCommentSchema }), controller.addMediaComment);
portalRouter.get('/projects/:projectId/requests', validate({ params: portalProjectParam }), controller.listRequests);
portalRouter.post('/projects/:projectId/requests', validate({ params: portalProjectParam, body: portalRequestSchema }), controller.createRequest);

// Sharing with family
portalRouter.get('/projects/:projectId/share-links', validate({ params: portalProjectParam }), controller.listShareLinks);
portalRouter.post('/projects/:projectId/share-links', validate({ params: portalProjectParam, body: portalShareLinkSchema }), controller.createShareLink);
portalRouter.delete('/projects/:projectId/share-links/:linkId', validate({ params: portalShareLinkParam }), controller.revokeShareLink);

// Notifications
portalRouter.get('/notifications', validate({ query: portalNotificationQuery }), controller.listNotifications);
portalRouter.post('/notifications/read-all', controller.readAllNotifications);
portalRouter.post('/notifications/:id/read', validate({ params: portalNotificationParam }), controller.readNotification);
