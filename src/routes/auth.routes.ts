import { Router } from 'express';
import * as controller from '../controllers/auth.controller';
import { validate } from '../middleware/validate';
import { requireAuth } from '../middleware/auth';
import { authLimiter } from '../middleware/rateLimiter';
import { changePasswordSchema, forgotPasswordSchema, loginSchema, refreshSchema, resetPasswordSchema, signupSchema, verifyEmailSchema } from '../validators/auth.validator';

const router = Router();

router.post('/login', authLimiter, validate({ body: loginSchema }), controller.login);
router.post('/refresh', authLimiter, validate({ body: refreshSchema }), controller.refresh);

// Account lifecycle (public, rate-limited).
router.post('/signup', authLimiter, validate({ body: signupSchema }), controller.signup);
router.post('/forgot-password', authLimiter, validate({ body: forgotPasswordSchema }), controller.forgotPassword);
router.post('/reset-password', authLimiter, validate({ body: resetPasswordSchema }), controller.resetPassword);
router.post('/verify-email', authLimiter, validate({ body: verifyEmailSchema }), controller.verifyEmail);

router.post('/logout', controller.logout);

router.use(requireAuth);
router.post('/resend-verification', authLimiter, controller.resendVerification);
router.get('/me', controller.me);
router.get('/sessions', controller.sessions);
router.post('/sessions/revoke-all', controller.revokeSessions);
router.post(
  '/change-password',
  authLimiter,
  validate({ body: changePasswordSchema }),
  controller.changePassword,
);

export default router;
