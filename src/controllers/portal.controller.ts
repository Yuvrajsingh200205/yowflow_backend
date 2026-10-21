import { Request, Response } from 'express';
import { env } from '../config/env';
import { PORTAL_ACCESS_COOKIE, PORTAL_REFRESH_COOKIE, requirePortalContext } from '../middleware/portalAuth';
import { asyncHandler, auditContext, requireAuthContext } from '../utils/http';
import { sendCreated, sendSuccess } from '../utils/response';
import { unauthenticated } from '../utils/errors';
import * as authService from '../services/portalAuth.service';
import * as portal from '../services/portal.service';

const cookieBase = () => ({
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: env.COOKIE_SECURE ? ('none' as const) : ('lax' as const),
  path: '/',
  ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
});

function setCookies(res: Response, t: authService.PortalTokens) {
  res.cookie(PORTAL_ACCESS_COOKIE, t.accessToken, { ...cookieBase(), maxAge: t.accessTokenExpiresIn * 1000 });
  res.cookie(PORTAL_REFRESH_COOKIE, t.refreshToken, { ...cookieBase(), maxAge: t.refreshTokenExpiresIn * 1000 });
}
function clearCookies(res: Response) {
  res.clearCookie(PORTAL_ACCESS_COOKIE, cookieBase());
  res.clearCookie(PORTAL_REFRESH_COOKIE, cookieBase());
}
const meta = (req: Request) => ({ ipAddress: req.ip ?? null, userAgent: req.header('user-agent') ?? null, requestId: req.requestId ?? null });

// ── Client-side auth ───────────────────────────────────────────────────────
export const login = asyncHandler(async (req, res) => {
  const { me, tokens } = await authService.login(req.body, meta(req));
  setCookies(res, tokens);
  return sendSuccess(res, me);
});

export const refresh = asyncHandler(async (req, res) => {
  const token = (req.cookies as Record<string, string> | undefined)?.[PORTAL_REFRESH_COOKIE] ?? req.body?.refreshToken;
  if (!token) { clearCookies(res); throw unauthenticated('No portal refresh token supplied'); }
  try {
    const { me, tokens } = await authService.refresh(token, meta(req));
    setCookies(res, tokens);
    return sendSuccess(res, me);
  } catch (error) {
    clearCookies(res);
    throw error;
  }
});

export const logout = asyncHandler(async (req, res) => {
  await authService.logout(requirePortalContext(req).sessionId);
  clearCookies(res);
  return sendSuccess(res, { loggedOut: true });
});

export const me = asyncHandler(async (req, res) => {
  const a = requirePortalContext(req);
  return sendSuccess(res, await authService.getPortalMe(a.organizationId, a.portalUserId));
});

export const previewInvite = asyncHandler(async (req, res) => sendSuccess(res, await authService.previewInvite(req.params.token)));
export const acceptInvite = asyncHandler(async (req, res) => {
  const { me: profile, tokens } = await authService.acceptInvite(req.params.token, req.body.password, meta(req));
  setCookies(res, tokens);
  return sendSuccess(res, profile);
});
export const forgotPassword = asyncHandler(async (req, res) => {
  await authService.requestPasswordReset(req.body.email);
  return sendSuccess(res, { sent: true });
});
export const resetPassword = asyncHandler(async (req, res) => {
  await authService.resetPassword(req.body.token, req.body.password);
  clearCookies(res);
  return sendSuccess(res, { passwordReset: true });
});

// ── Studio-side access management (mounted under /clients/:id/portal-access) ─
export const listAccess = asyncHandler(async (req, res) => sendSuccess(res, await authService.listPortalAccess(requireAuthContext(req), req.params.id)));
export const invite = asyncHandler(async (req, res) => sendCreated(res, await authService.invitePortalUser(requireAuthContext(req), req.params.id, req.body, auditContext(req))));
export const setStatus = asyncHandler(async (req, res) =>
  sendSuccess(res, await authService.setPortalUserStatus(requireAuthContext(req), req.params.id, req.params.portalUserId, req.body.status, auditContext(req))),
);
export const removeAccess = asyncHandler(async (req, res) => {
  await authService.removePortalUser(requireAuthContext(req), req.params.id, req.params.portalUserId, auditContext(req));
  return sendSuccess(res, { removed: true });
});

// ── Portal data ────────────────────────────────────────────────────────────
const ctx = (req: Request) => requirePortalContext(req);

export const listProjects = asyncHandler(async (req, res) => sendSuccess(res, await portal.listProjects(ctx(req))));
export const getProject = asyncHandler(async (req, res) => sendSuccess(res, await portal.getProject(ctx(req), req.params.projectId)));
export const getGallery = asyncHandler(async (req, res) => sendSuccess(res, await portal.getGallery(ctx(req), req.params.projectId)));
export const listMedia = asyncHandler(async (req, res) => sendSuccess(res, await portal.listMedia(ctx(req), req.params.projectId, req.query as portal.MediaQuery)));
export const getMedia = asyncHandler(async (req, res) => sendSuccess(res, await portal.getMedia(ctx(req), req.params.mediaId)));
export const putSelection = asyncHandler(async (req, res) => sendSuccess(res, await portal.setSelection(ctx(req), req.params.mediaId, req.params.kind as 'FAVORITE' | 'ALBUM', true)));
export const deleteSelection = asyncHandler(async (req, res) => sendSuccess(res, await portal.setSelection(ctx(req), req.params.mediaId, req.params.kind as 'FAVORITE' | 'ALBUM', false)));
export const submitAlbum = asyncHandler(async (req, res) => sendCreated(res, await portal.submitAlbumSelection(ctx(req), req.params.projectId)));
export const listProjectComments = asyncHandler(async (req, res) => sendSuccess(res, await portal.listComments(ctx(req), { projectId: req.params.projectId })));
export const addMediaComment = asyncHandler(async (req, res) => sendCreated(res, await portal.addComment(ctx(req), { mediaId: req.params.mediaId, ...req.body })));
export const addProjectComment = asyncHandler(async (req, res) => sendCreated(res, await portal.addComment(ctx(req), { projectId: req.params.projectId, ...req.body })));
export const listRequests = asyncHandler(async (req, res) => sendSuccess(res, await portal.listRequests(ctx(req), req.params.projectId)));
export const createRequest = asyncHandler(async (req, res) => sendCreated(res, await portal.createRequest(ctx(req), req.params.projectId, req.body)));
export const listShareLinks = asyncHandler(async (req, res) => sendSuccess(res, await portal.listShareLinks(ctx(req), req.params.projectId)));
export const createShareLink = asyncHandler(async (req, res) => sendCreated(res, await portal.createShareLink(ctx(req), req.params.projectId, req.body)));
export const revokeShareLink = asyncHandler(async (req, res) => sendSuccess(res, await portal.revokeShareLink(ctx(req), req.params.projectId, req.params.linkId)));
export const downloadMedia = asyncHandler(async (req, res) => sendSuccess(res, await portal.downloadMedia(ctx(req), req.params.mediaId)));
export const listNotifications = asyncHandler(async (req, res) => sendSuccess(res, await portal.listNotifications(ctx(req), Number(req.query.limit ?? 30))));
export const readNotification = asyncHandler(async (req, res) => sendSuccess(res, await portal.markNotificationRead(ctx(req), req.params.id)));
export const readAllNotifications = asyncHandler(async (req, res) => sendSuccess(res, await portal.markAllNotificationsRead(ctx(req))));
