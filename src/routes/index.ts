import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { sharedGalleryRouter } from './sharedGallery.routes';
import authRoutes from './auth.routes';
import publicRoutes from './public.routes';
import { portalRouter } from './portal.routes';
import { apiKeyRouter, billingRouter } from './billing.routes';
import freelancerPortalRoutes from './freelancerPortal.routes';
import { metaIntegrationRouter } from './integration.routes';
import { clientRouter, leadRouter } from './crm.routes';
import { dashboardRouter } from './dashboard.routes';
import { settingsWorkspaceRouter } from './settings.routes';
import { eventRouter, projectRouter, shootRouter } from './project.routes';
import { expenseRouter, financeRouter, incomeRouter, invoiceRouter, paymentRouter, quotationRouter } from './finance.routes';
import { attendanceRouter, deliveryRouter, freelancerRouter, personalNoteRouter, personalSheetRouter, personalTodoRouter, taskRouter } from './ops.routes';
import {
  auditRouter,
  branchRouter,
  dataManagementRouter,
  fileRouter,
  notificationRouter,
  organizationRouter,
  permissionRouter,
  reportRouter,
  roleRouter,
  settingRouter,
  teamRouter,
  userRouter,
} from './admin.routes';

const router = Router();

// Public (rate-limited) authentication surface.
router.use('/auth', authRoutes);
router.use('/public', publicRoutes);
router.use('/portal', portalRouter);
router.use('/freelancer-portal', freelancerPortalRoutes);
router.use('/integrations/meta', metaIntegrationRouter);
// Public: the share token is the credential, so this sits before requireAuth.
router.use('/shared-galleries', sharedGalleryRouter);

// Everything below requires a valid session; each route additionally names the
// permission it needs (§6 — authorization is never left to the frontend).
router.use(requireAuth);

router.use('/dashboard', dashboardRouter);
router.use('/billing', billingRouter);
router.use('/settings/api-keys', apiKeyRouter);

router.use('/organizations', organizationRouter);
router.use('/branches', branchRouter);
router.use('/users', userRouter);
router.use('/team', teamRouter);
router.use('/roles', roleRouter);
router.use('/permissions', permissionRouter);

router.use('/leads', leadRouter);
router.use('/clients', clientRouter);
router.use('/projects', projectRouter);
router.use('/events', eventRouter);
router.use('/shoots', shootRouter);
router.use('/freelancers', freelancerRouter);
router.use('/tasks', taskRouter);
router.use('/me/todos', personalTodoRouter);
router.use('/me/notes', personalNoteRouter);
router.use('/me/sheet', personalSheetRouter);
router.use('/attendance', attendanceRouter);
router.use('/deliveries', deliveryRouter);

router.use('/quotations', quotationRouter);
router.use('/invoices', invoiceRouter);
router.use('/payments', paymentRouter);
router.use('/expenses', expenseRouter);
router.use('/incomes', incomeRouter);
router.use('/finance', financeRouter);

router.use('/files', fileRouter);
router.use('/notifications', notificationRouter);
router.use('/reports', reportRouter);
router.use('/audit', auditRouter);
// The Settings workspace owns named sub-paths under `/settings`; the existing
// key/value setting router below still owns `GET /` and `PUT /`.
router.use('/settings', settingsWorkspaceRouter);
router.use('/settings', settingRouter);
router.use('/data-management', dataManagementRouter);

export default router;
