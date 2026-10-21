import { Router } from 'express';
import * as controller from '../controllers/portal.controller';
import { authLimiter } from '../middleware/rateLimiter';
import { requirePortalAuth } from '../middleware/portalAuth';
import { validate } from '../middleware/validate';
import {
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

portalRouter.use(requirePortalAuth);
portalRouter.post('/auth/logout', controller.logout);
portalRouter.get('/me', controller.me);
