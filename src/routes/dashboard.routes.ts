import { Router } from 'express';
import * as controller from '../controllers/dashboard.controller';
import { requirePermission } from '../middleware/rbac';

export const dashboardRouter = Router();

dashboardRouter.get('/summary', requirePermission('DASHBOARD_VIEW'), controller.summary);

dashboardRouter.get('/trends', requirePermission('DASHBOARD_VIEW'), controller.trends);

export default dashboardRouter;
