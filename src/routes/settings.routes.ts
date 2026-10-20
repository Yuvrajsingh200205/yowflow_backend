import { Router } from 'express';
import * as controller from '../controllers/settings.controller';
import { validate } from '../middleware/validate';
import { requirePermission } from '../middleware/rbac';
import { authLimiter } from '../middleware/rateLimiter';
import { idParam } from '../validators/common.validator';
import {
  changePasswordSchema,
  createModuleAccessRequestSchema,
  moduleAccessRequestListQuery,
  reviewModuleAccessRequestSchema,
  updateOrganizationSettingsSchema,
  updatePreferencesSchema,
  updateProfileSchema,
} from '../validators/settings.validator';

/**
 * The Settings workspace, mounted under `/settings` alongside the existing
 * key/value `settingRouter`. The two never collide: that one owns `GET /` and
 * `PUT /`, everything here is a named sub-path.
 *
 * Authorization splits three ways:
 *   * self-service (profile, preferences, password, raising a request) needs
 *     only a valid session — the handler always acts on `auth.userId`, never on
 *     an id from the request, so an employee cannot reach anyone else's row;
 *   * studio settings need `ORG_UPDATE`, the key the Organization screen
 *     already requires;
 *   * reviewing a request needs `PERMISSION_ASSIGN`, because approving one
 *     grants permissions.
 * `requireAuth` is applied once, for every route, in `routes/index.ts`.
 */
export const settingsWorkspaceRouter = Router();

settingsWorkspaceRouter.get('/workspace', controller.getWorkspace);
settingsWorkspaceRouter.get('/members', requirePermission('SETTING_UPDATE'), controller.listWorkspaceMembers);

settingsWorkspaceRouter.patch(
  '/profile',
  validate({ body: updateProfileSchema }),
  controller.updateProfile,
);

settingsWorkspaceRouter.patch(
  '/organization',
  requirePermission('ORG_UPDATE'),
  validate({ body: updateOrganizationSettingsSchema }),
  controller.updateOrganization,
);

settingsWorkspaceRouter.patch(
  '/preferences',
  validate({ body: updatePreferencesSchema }),
  controller.updatePreferences,
);

// Rate-limited like `/auth/change-password`: this endpoint verifies a password.
settingsWorkspaceRouter.post(
  '/password',
  authLimiter,
  validate({ body: changePasswordSchema }),
  controller.changePassword,
);

settingsWorkspaceRouter.get(
  '/module-access-requests',
  validate({ query: moduleAccessRequestListQuery }),
  controller.listModuleAccessRequests,
);

settingsWorkspaceRouter.post(
  '/module-access-requests',
  validate({ body: createModuleAccessRequestSchema }),
  controller.createModuleAccessRequest,
);

settingsWorkspaceRouter.patch(
  '/module-access-requests/:id',
  requirePermission('PERMISSION_ASSIGN'),
  validate({ params: idParam, body: reviewModuleAccessRequestSchema }),
  controller.reviewModuleAccessRequest,
);
