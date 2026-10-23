import { Router } from 'express';
import * as controller from '../controllers/freelancerPortal.controller';
import { authLimiter } from '../middleware/rateLimiter';
import { requireFreelancerAuth } from '../middleware/freelancerAuth';
import { validate } from '../middleware/validate';
import {
  freelancerPortalLoginSchema,
  freelancerPortalRefreshSchema,
  freelancerProfileUpdateSchema,
  itemIdParam,
  joinStudioParam,
  portalCheckoutSchema,
  portalCheckoutVerifySchema,
  onboardingPasswordSchema,
  onboardingTokenParam,
  portalAvailabilityDateParam,
  portalAvailabilityQuery,
  portalAvailabilitySchema,
  portalAvailabilityUpdateSchema,
  portalConnectionResponseSchema,
  portalNotificationListQuery,
  portalPaymentListQuery,
  portalPortfolioCreateSchema,
  portalPortfolioIntentSchema,
  portalPortfolioUploadSchema,
  portalPortfolioUpdateSchema,
  portalProjectListQuery,
  portalResourceIdParam,
  portalShootListQuery,
  portalTaskListQuery,
  portalTaskStatusUpdateSchema,
  publicFreelancerApplicationSchema,
  setFreelancerPasswordSchema,
} from '../validators/freelancerPortal.validator';

const router = Router();

router.get('/join-studio', controller.studioForJoin);
router.get('/studios/:slug', validate({ params: joinStudioParam }), controller.studioForJoin);
router.post('/applications', validate({ body: publicFreelancerApplicationSchema }), controller.submitApplication);
router.post('/auth/login', authLimiter, validate({ body: freelancerPortalLoginSchema }), controller.login);
router.post('/auth/refresh', authLimiter, validate({ body: freelancerPortalRefreshSchema }), controller.refresh);
router.get('/onboarding/:token', authLimiter, validate({ params: onboardingTokenParam }), controller.validateOnboarding);
router.post('/onboarding/:token/password', authLimiter, validate({ params: onboardingTokenParam, body: onboardingPasswordSchema }), controller.setOnboardingPassword);

router.use(requireFreelancerAuth);
router.post('/auth/logout', controller.logout);
router.get('/me', controller.me);
router.patch('/profile', validate({ body: freelancerProfileUpdateSchema }), controller.updateProfile);
router.post('/password', authLimiter, validate({ body: setFreelancerPasswordSchema }), controller.setPassword);
router.get('/availability', validate({ query: portalAvailabilityQuery }), controller.listAvailability);
router.put('/availability', validate({ body: portalAvailabilitySchema }), controller.upsertAvailability);
router.patch('/availability/:date', validate({ params: portalAvailabilityDateParam, body: portalAvailabilityUpdateSchema }), controller.updateAvailability);
router.delete('/availability/:date', validate({ params: portalAvailabilityDateParam }), controller.deleteAvailability);
router.patch('/connections/:id', validate({ params: portalResourceIdParam, body: portalConnectionResponseSchema }), controller.respondToConnection);
router.post('/portfolio/upload-intent', validate({ body: portalPortfolioIntentSchema }), controller.portfolioUploadIntent);
router.post('/portfolio/upload', validate({ body: portalPortfolioUploadSchema }), controller.portfolioUpload);
router.post('/portfolio', validate({ body: portalPortfolioCreateSchema }), controller.createPortfolioItem);
router.patch('/portfolio/:itemId', validate({ params: itemIdParam, body: portalPortfolioUpdateSchema }), controller.updatePortfolioItem);
router.delete('/portfolio/:itemId', validate({ params: itemIdParam }), controller.deletePortfolioItem);
router.get('/plans', controller.listPlans);
router.post('/subscription/checkout', validate({ body: portalCheckoutSchema }), controller.startCheckout);
router.post('/subscription/verify', validate({ body: portalCheckoutVerifySchema }), controller.verifyCheckout);
router.post('/subscription/cancel', controller.cancelSubscription);
router.get('/dashboard', controller.dashboard);
router.get('/projects', validate({ query: portalProjectListQuery }), controller.projects);
router.get('/projects/:id', validate({ params: portalResourceIdParam }), controller.project);
router.get('/shoots', validate({ query: portalShootListQuery }), controller.shoots);
router.get('/shoots/:id', validate({ params: portalResourceIdParam }), controller.shoot);
router.get('/tasks', validate({ query: portalTaskListQuery }), controller.tasks);
router.patch('/tasks/:id', validate({ params: portalResourceIdParam, body: portalTaskStatusUpdateSchema }), controller.updateTaskStatus);
router.get('/payments', validate({ query: portalPaymentListQuery }), controller.payments);
router.get('/notifications', validate({ query: portalNotificationListQuery }), controller.notifications);

export default router;
