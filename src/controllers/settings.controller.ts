import { Request } from 'express';
import { ModuleAccessRequestStatus } from '@prisma/client';
import { asyncHandler, auditContext, requireAuthContext } from '../utils/http';
import { sendCreated, sendSuccess } from '../utils/response';
import * as settingsService from '../services/settings.service';
import { brand } from '../config/brand';

/** Matches the who/where/when envelope `/auth` passes to the account service. */
const requestMeta = (req: Request) => ({
  ipAddress: req.ip ?? null,
  userAgent: req.header('user-agent') ?? null,
  requestId: req.requestId ?? null,
});

export const getWorkspace = asyncHandler(async (req, res) =>
  sendSuccess(res, await settingsService.getWorkspace(requireAuthContext(req))),
);

export const updateProfile = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  return sendSuccess(res, await settingsService.updateProfile(auth, req.body, auditContext(req)));
});

export const updateOrganization = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  return sendSuccess(
    res,
    await settingsService.updateOrganizationSettings(auth, req.body, auditContext(req)),
  );
});

export const updatePreferences = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  return sendSuccess(
    res,
    await settingsService.updatePreferences(auth, req.body, auditContext(req)),
  );
});

export const changePassword = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  await settingsService.changePassword(auth, req.body, requestMeta(req));
  // Every other session was revoked, so this client's cookies are stale too.
  res.clearCookie(brand.cookie.access, { path: '/' });
  res.clearCookie(brand.cookie.refresh, { path: '/' });
  return sendSuccess(res, { passwordChanged: true });
});

export const listModuleAccessRequests = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const status = req.query.status as ModuleAccessRequestStatus | undefined;
  return sendSuccess(res, await settingsService.listModuleAccessRequests(auth, { status }));
});

export const createModuleAccessRequest = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  return sendCreated(
    res,
    await settingsService.createModuleAccessRequest(auth, req.body, auditContext(req)),
  );
});

export const reviewModuleAccessRequest = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  return sendSuccess(
    res,
    await settingsService.reviewModuleAccessRequest(
      auth,
      req.params.id,
      req.body,
      auditContext(req),
    ),
  );
});

export const listWorkspaceMembers = asyncHandler(async (req, res) =>
  sendSuccess(res, await settingsService.listWorkspaceMembers(requireAuthContext(req))),
);
