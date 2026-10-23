import { Request, Response } from 'express';
import { env } from '../config/env';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../middleware/auth';
import { FREELANCER_ACCESS_COOKIE, FREELANCER_REFRESH_COOKIE } from '../middleware/freelancerAuth';
import { asyncHandler, auditContext, requireAuthContext } from '../utils/http';
import { sendCreated, sendSuccess } from '../utils/response';
import { unauthenticated } from '../utils/errors';
import * as authService from '../services/auth.service';
import * as accountService from '../services/account.service';
import * as freelancerPortalService from '../services/freelancerPortal.service';

/**
 * Shared cookie attributes. A deletion cookie is only honoured by browsers when
 * every attribute except `Max-Age`/`Expires` matches the cookie that was set —
 * in particular `Secure` and `SameSite=None`, which are mandatory together.
 * Clearing with bare `{ path: '/' }` silently left the cookie in place in
 * production, so the base attributes live in one place and both paths use it.
 */
const cookieBase = () => ({
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: env.COOKIE_SECURE ? ('none' as const) : ('lax' as const),
  path: '/',
  ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
});

const cookieOptions = (maxAgeSeconds: number) => ({
  ...cookieBase(),
  maxAge: maxAgeSeconds * 1000,
});

function setAuthCookies(res: Response, tokens: authService.AuthTokens): void {
  res.cookie(ACCESS_COOKIE, tokens.accessToken, cookieOptions(tokens.accessTokenExpiresIn));
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, cookieOptions(tokens.refreshTokenExpiresIn));
}

function setFreelancerCookies(res: Response, tokens: freelancerPortalService.FreelancerTokens): void {
  res.cookie(FREELANCER_ACCESS_COOKIE, tokens.accessToken, cookieOptions(tokens.accessTokenExpiresIn));
  res.cookie(FREELANCER_REFRESH_COOKIE, tokens.refreshToken, cookieOptions(tokens.refreshTokenExpiresIn));
}

/**
 * Drops both auth cookies. Called on logout, on password change and — crucially
 * — whenever a refresh is rejected: the refresh token is the last credential the
 * browser holds, so once it is dead the cookies must go, otherwise the edge
 * middleware keeps seeing an "authenticated" browser, keeps admitting it to a
 * protected route, and the app keeps retrying /me and /refresh.
 */
function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, cookieBase());
  res.clearCookie(REFRESH_COOKIE, cookieBase());
  res.clearCookie(FREELANCER_ACCESS_COOKIE, cookieBase());
  res.clearCookie(FREELANCER_REFRESH_COOKIE, cookieBase());
}

const requestMeta = (req: Request) => ({
  ipAddress: req.ip ?? null,
  userAgent: req.header('user-agent') ?? null,
  requestId: req.requestId ?? null,
});

export const login = asyncHandler(async (req, res) => {
  const { user, tokens } = await authService.login(req.body, requestMeta(req));
  setAuthCookies(res, tokens);
  const freelancerSession = await freelancerPortalService.issuePortalSessionForUser(user.id, user.organizationId, requestMeta(req));
  if (freelancerSession) setFreelancerCookies(res, freelancerSession.tokens);
  // The token pair is returned too, so non-browser clients need no cookie jar.
  return sendSuccess(res, { user, tokens });
});

export const refresh = asyncHandler(async (req, res) => {
  const token =
    (req.body?.refreshToken as string | undefined) ??
    (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
  if (!token) {
    clearAuthCookies(res);
    throw unauthenticated('No refresh token supplied');
  }

  let result: Awaited<ReturnType<typeof authService.refresh>>;
  try {
    result = await authService.refresh(token, requestMeta(req));
  } catch (error) {
    // The presented token is unusable and rotation retired nothing the browser
    // can still use. Clearing here is what makes a dead session terminal
    // instead of an endless /me -> /refresh retry cycle.
    clearAuthCookies(res);
    throw error;
  }
  setAuthCookies(res, result.tokens);
  if (result.user.freelancerProfile) {
    const freelancerSession = await freelancerPortalService.issuePortalSessionForUser(result.user.id, result.user.organizationId, requestMeta(req));
    if (freelancerSession) setFreelancerCookies(res, freelancerSession.tokens);
  }
  return sendSuccess(res, { user: result.user, tokens: result.tokens });
});

export const logout = asyncHandler(async (req, res) => {
  // Public on purpose: the refresh cookie alone is enough to sign out, so an expired access token can never trap a user in a session.
  const cookies = (req.cookies ?? {}) as Record<string, string | undefined>;
  const bearer = req.header('authorization');
  await authService.logoutByCredentials(
    { refreshToken: cookies[REFRESH_COOKIE], accessToken: cookies[ACCESS_COOKIE] ?? (bearer?.startsWith('Bearer ') ? bearer.slice(7).trim() : undefined) },
    requestMeta(req),
  );
  clearAuthCookies(res);
  return sendSuccess(res, { loggedOut: true });
});

export const me = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  // `requireAuth` already read this user, its roles and its permissions.
  const user = auth.sessionUser ?? await authService.getCurrentUser(auth.userId);
  const cookies = req.cookies as Record<string, string> | undefined;
  if (user.freelancerProfile && !cookies?.[FREELANCER_ACCESS_COOKIE] && !cookies?.[FREELANCER_REFRESH_COOKIE]) {
    const freelancerSession = await freelancerPortalService.issuePortalSessionForUser(user.id, user.organizationId, requestMeta(req));
    if (freelancerSession) setFreelancerCookies(res, freelancerSession.tokens);
  }
  return sendSuccess(res, user);
});

export const sessions = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  return sendSuccess(res, await authService.listSessions(auth.userId));
});

export const revokeSessions = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const revoked = await authService.revokeAllSessions(auth.userId, 'ADMIN_REVOKED');
  clearAuthCookies(res);
  return sendSuccess(res, { revoked });
});

export const changePassword = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  await authService.changePassword(
    auth.userId,
    req.body.currentPassword,
    req.body.newPassword,
    requestMeta(req),
  );
  clearAuthCookies(res);
  void auditContext(req);
  return sendSuccess(res, { passwordChanged: true });
});

export const signup = asyncHandler(async (req, res) =>
  sendCreated(res, await accountService.signup(req.body, requestMeta(req))),
);

export const forgotPassword = asyncHandler(async (req, res) => {
  await accountService.requestPasswordReset(req.body.email);
  // Identical response whether or not the address exists.
  return sendSuccess(res, { sent: true });
});

export const resetPassword = asyncHandler(async (req, res) => {
  await accountService.resetPassword(req.body.token, req.body.password, requestMeta(req));
  clearAuthCookies(res);
  return sendSuccess(res, { passwordReset: true });
});

export const verifyEmail = asyncHandler(async (req, res) => {
  await accountService.verifyEmail(req.body.token);
  return sendSuccess(res, { verified: true });
});

export const resendVerification = asyncHandler(async (req, res) =>
  sendSuccess(res, await accountService.resendVerification(requireAuthContext(req).userId)),
);

export const contact = asyncHandler(async (req, res) => {
  await accountService.submitContact(req.body, requestMeta(req));
  return sendCreated(res, { received: true });
});
