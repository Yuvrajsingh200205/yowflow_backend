import { LogoutReason, PortalTokenType, SessionStatus } from '@prisma/client';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { AuthContext } from '../types';
import { hashPassword, verifyPassword } from '../utils/password';
import { generateRefreshToken, hashRefreshToken, parseDuration } from '../utils/jwt';
import { signPortalAccessToken } from '../utils/portalJwt';
import { newToken, sha256 } from '../utils/token';
import { badRequest, conflict, forbidden, notFound, unauthenticated } from '../utils/errors';
import { AuditRequestContext, recordAudit } from './audit.service';
import { portalInviteEmail, portalResetEmail, sendMail } from './mailer.service';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;
// A real bcrypt hash of a throw-away password, compared when the account does not exist so response time never reveals it.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword(newToken()));

export interface RequestMeta { ipAddress?: string | null; userAgent?: string | null; requestId?: string | null }
export interface PortalTokens { accessToken: string; refreshToken: string; accessTokenExpiresIn: number; refreshTokenExpiresIn: number }

const link = (path: string, token: string) => `${env.APP_URL.replace(/\/$/, '')}${path}?token=${encodeURIComponent(token)}`;

async function trySend(task: () => Promise<void>, what: string) {
  try { await task(); } catch (error) { logger.error({ err: error, what }, 'portal mail failed'); }
}

async function issueToken(portalUserId: string, type: PortalTokenType, ttl: number) {
  await prisma.portalToken.updateMany({ where: { portalUserId, type, usedAt: null }, data: { usedAt: new Date() } });
  const token = newToken();
  await prisma.portalToken.create({ data: { portalUserId, type, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttl) } });
  return token;
}

async function issueSession(portalUserId: string, organizationId: string, meta: RequestMeta): Promise<PortalTokens> {
  const refreshTtl = parseDuration(env.REFRESH_TOKEN_EXPIRES_IN);
  const { token, hash } = generateRefreshToken();
  const session = await prisma.clientPortalSession.create({
    data: { portalUserId, refreshTokenHash: hash, ipAddress: meta.ipAddress ?? null, userAgent: meta.userAgent?.slice(0, 512) ?? null, expiresAt: new Date(Date.now() + refreshTtl) },
    select: { id: true },
  });
  return {
    accessToken: signPortalAccessToken({ sub: portalUserId, organizationId, portalSessionId: session.id }),
    refreshToken: token,
    accessTokenExpiresIn: Math.floor(parseDuration(env.JWT_EXPIRES_IN) / 1000),
    refreshTokenExpiresIn: Math.floor(refreshTtl / 1000),
  };
}

export async function getPortalMe(organizationId: string, portalUserId: string) {
  const user = await prisma.clientPortalUser.findFirst({
    where: { id: portalUserId, organizationId, deletedAt: null },
    select: {
      id: true, email: true, fullName: true, phone: true, lastLoginAt: true,
      client: { select: { id: true, displayName: true, brideName: true, groomName: true } },
      organization: { select: { name: true, slug: true, phone: true, email: true, website: true } },
    },
  });
  if (!user) throw notFound('Portal user');
  return { user: { id: user.id, email: user.email, fullName: user.fullName, phone: user.phone, lastLoginAt: user.lastLoginAt }, client: user.client, studio: user.organization };
}

// ---------------------------------------------------------------------------
// Studio side: inviting and managing portal access for a CRM client
// ---------------------------------------------------------------------------

const presentUser = (u: { id: string; email: string; fullName: string; phone: string | null; status: string; invitedAt: Date | null; lastLoginAt: Date | null; createdAt: Date }) => ({
  id: u.id, email: u.email, fullName: u.fullName, phone: u.phone, status: u.status, invitedAt: u.invitedAt, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt,
});
const USER_VIEW = { id: true, email: true, fullName: true, phone: true, status: true, invitedAt: true, lastLoginAt: true, createdAt: true } as const;

async function requireClient(auth: AuthContext, clientId: string) {
  const client = await prisma.client.findFirst({ where: { id: clientId, organizationId: auth.organizationId, deletedAt: null }, select: { id: true, displayName: true } });
  if (!client) throw notFound('Client');
  return client;
}

export async function listPortalAccess(auth: AuthContext, clientId: string) {
  await requireClient(auth, clientId);
  const users = await prisma.clientPortalUser.findMany({ where: { clientId, organizationId: auth.organizationId, deletedAt: null }, orderBy: { createdAt: 'asc' }, select: USER_VIEW });
  return users.map(presentUser);
}

/** Creates (or re-invites) a portal login for a client and e-mails a set-password link. */
export async function invitePortalUser(auth: AuthContext, clientId: string, input: { email: string; fullName: string; phone?: string }, ctx: AuditRequestContext) {
  await requireClient(auth, clientId);
  const email = input.email.toLowerCase();
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: auth.organizationId }, select: { name: true } });

  const existing = await prisma.clientPortalUser.findUnique({ where: { organizationId_email: { organizationId: auth.organizationId, email } } });
  if (existing && existing.clientId !== clientId) throw conflict('This email already has portal access for a different client.');
  if (existing?.status === 'SUSPENDED') throw conflict('This portal user is suspended. Re-enable them before sending a new invite.');

  const user = existing && !existing.deletedAt
    ? await prisma.clientPortalUser.update({ where: { id: existing.id }, data: { invitedAt: new Date(), fullName: input.fullName.trim() || existing.fullName }, select: USER_VIEW })
    : existing
      ? await prisma.clientPortalUser.update({ where: { id: existing.id }, data: { deletedAt: null, deletedBy: null, status: 'INVITED', passwordHash: null, invitedAt: new Date(), fullName: input.fullName.trim() }, select: USER_VIEW })
      : await prisma.clientPortalUser.create({ data: { organizationId: auth.organizationId, clientId, email, fullName: input.fullName.trim(), phone: input.phone?.trim() || null, status: 'INVITED', invitedAt: new Date() }, select: USER_VIEW });

  const token = await issueToken(user.id, PortalTokenType.INVITE, INVITE_TTL_MS);
  await trySend(() => sendMail(portalInviteEmail(email, user.fullName.split(' ')[0], org.name, link('/client/accept-invite', token))), 'portal invite');
  await recordAudit(prisma, ctx, { action: 'CREATE', entityType: 'ClientPortalUser', entityId: user.id, summary: `Portal invite sent to ${email}` });
  return presentUser(user);
}

export async function setPortalUserStatus(auth: AuthContext, clientId: string, portalUserId: string, status: 'ACTIVE' | 'SUSPENDED', ctx: AuditRequestContext) {
  await requireClient(auth, clientId);
  const user = await prisma.clientPortalUser.findFirst({ where: { id: portalUserId, clientId, organizationId: auth.organizationId, deletedAt: null }, select: { id: true, email: true, passwordHash: true, status: true } });
  if (!user) throw notFound('Portal user');
  const next = status === 'ACTIVE' && !user.passwordHash ? 'INVITED' : status;
  await prisma.$transaction(async (tx) => {
    await tx.clientPortalUser.update({ where: { id: user.id }, data: { status: next } });
    if (status === 'SUSPENDED') {
      await tx.clientPortalSession.updateMany({ where: { portalUserId: user.id, status: SessionStatus.ACTIVE }, data: { status: SessionStatus.REVOKED, revokedAt: new Date(), revokeReason: LogoutReason.ADMIN_REVOKED } });
    }
    await recordAudit(tx, ctx, { action: 'UPDATE', entityType: 'ClientPortalUser', entityId: user.id, summary: `Portal access for ${user.email} ${status === 'SUSPENDED' ? 'suspended' : 're-enabled'}` });
  });
  return { id: user.id, status: next };
}

export async function removePortalUser(auth: AuthContext, clientId: string, portalUserId: string, ctx: AuditRequestContext) {
  await requireClient(auth, clientId);
  const user = await prisma.clientPortalUser.findFirst({ where: { id: portalUserId, clientId, organizationId: auth.organizationId, deletedAt: null }, select: { id: true, email: true } });
  if (!user) throw notFound('Portal user');
  await prisma.$transaction(async (tx) => {
    await tx.clientPortalUser.update({ where: { id: user.id }, data: { deletedAt: new Date(), deletedBy: auth.userId, status: 'SUSPENDED' } });
    await tx.clientPortalSession.updateMany({ where: { portalUserId: user.id, status: SessionStatus.ACTIVE }, data: { status: SessionStatus.REVOKED, revokedAt: new Date(), revokeReason: LogoutReason.ADMIN_REVOKED } });
    await recordAudit(tx, ctx, { action: 'DELETE', entityType: 'ClientPortalUser', entityId: user.id, summary: `Portal access for ${user.email} removed` });
  });
}

// ---------------------------------------------------------------------------
// Client side: invitation, sign-in, session lifecycle, password reset
// ---------------------------------------------------------------------------

async function consume(token: string, type: PortalTokenType) {
  const row = await prisma.portalToken.findUnique({
    where: { tokenHash: sha256(token) },
    include: { portalUser: { select: { id: true, organizationId: true, email: true, fullName: true, status: true, deletedAt: true, organization: { select: { name: true } } } } },
  });
  if (!row || row.type !== type || row.usedAt || row.expiresAt.getTime() < Date.now() || row.portalUser.deletedAt) {
    throw badRequest('This link is invalid or has expired. Ask your studio for a new one.');
  }
  if (row.portalUser.status === 'SUSPENDED') throw forbidden('Portal access is not active.');
  return row;
}

export async function previewInvite(token: string) {
  const row = await consume(token, PortalTokenType.INVITE);
  return { email: row.portalUser.email, fullName: row.portalUser.fullName, studioName: row.portalUser.organization.name };
}

export async function acceptInvite(token: string, password: string, meta: RequestMeta) {
  const row = await consume(token, PortalTokenType.INVITE);
  const passwordHash = await hashPassword(password);
  await prisma.$transaction([
    prisma.clientPortalUser.update({ where: { id: row.portalUserId }, data: { passwordHash, status: 'ACTIVE', failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() } }),
    prisma.portalToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
  ]);
  const tokens = await issueSession(row.portalUserId, row.portalUser.organizationId, meta);
  return { me: await getPortalMe(row.portalUser.organizationId, row.portalUserId), tokens };
}

export async function login(input: { email: string; password: string }, meta: RequestMeta) {
  const email = input.email.trim().toLowerCase();
  const candidates = await prisma.clientPortalUser.findMany({ where: { email, deletedAt: null, passwordHash: { not: null } }, orderBy: { lastLoginAt: { sort: 'desc', nulls: 'last' } } });
  if (candidates.length === 0) { await verifyPassword(input.password, await getDummyHash()); throw unauthenticated('Invalid email or password'); }

  for (const user of candidates) {
    if (user.lockedUntil && user.lockedUntil > new Date()) continue;
    if (!(await verifyPassword(input.password, user.passwordHash as string))) {
      const attempts = user.failedLoginAttempts + 1;
      await prisma.clientPortalUser.update({ where: { id: user.id }, data: { failedLoginAttempts: attempts, lockedUntil: attempts >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCK_MS) : null } });
      continue;
    }
    if (user.status !== 'ACTIVE') throw forbidden('Portal access is not active. Please contact your studio.');
    const [tokens] = await Promise.all([
      issueSession(user.id, user.organizationId, meta),
      prisma.clientPortalUser.update({ where: { id: user.id }, data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() } }),
      recordAudit(prisma, { organizationId: user.organizationId, actorId: null, ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId }, { action: 'LOGIN', entityType: 'ClientPortalUser', entityId: user.id, summary: 'Client signed in to the portal' }),
    ]);
    return { me: await getPortalMe(user.organizationId, user.id), tokens };
  }
  throw unauthenticated('Invalid email or password');
}

export async function refresh(refreshToken: string, meta: RequestMeta) {
  const session = await prisma.clientPortalSession.findUnique({ where: { refreshTokenHash: hashRefreshToken(refreshToken) }, include: { portalUser: { select: { organizationId: true, status: true, deletedAt: true } } } });
  if (!session || session.status !== 'ACTIVE') throw unauthenticated('Invalid portal refresh token');
  if (session.expiresAt <= new Date()) {
    await prisma.clientPortalSession.update({ where: { id: session.id }, data: { status: 'EXPIRED', revokedAt: new Date() } });
    throw unauthenticated('Portal session has expired');
  }
  if (session.portalUser.deletedAt || session.portalUser.status !== 'ACTIVE') throw forbidden('Portal access is not active');
  await prisma.clientPortalSession.update({ where: { id: session.id }, data: { status: SessionStatus.LOGGED_OUT, revokedAt: new Date(), revokeReason: LogoutReason.TOKEN_REFRESH_ROTATION } });
  const tokens = await issueSession(session.portalUserId, session.portalUser.organizationId, meta);
  return { me: await getPortalMe(session.portalUser.organizationId, session.portalUserId), tokens };
}

export async function logout(sessionId: string): Promise<void> {
  await prisma.clientPortalSession.updateMany({ where: { id: sessionId, status: 'ACTIVE' }, data: { status: 'LOGGED_OUT', revokedAt: new Date(), revokeReason: 'MANUAL_LOGOUT' } });
}

/** Always resolves; never reveals whether the address has portal access. */
export async function requestPasswordReset(emailInput: string): Promise<void> {
  const users = await prisma.clientPortalUser.findMany({ where: { email: emailInput.trim().toLowerCase(), deletedAt: null, status: 'ACTIVE', passwordHash: { not: null } }, select: { id: true, email: true, fullName: true } });
  for (const u of users) {
    const token = await issueToken(u.id, PortalTokenType.RESET_PASSWORD, RESET_TTL_MS);
    await trySend(() => sendMail(portalResetEmail(u.email, u.fullName.split(' ')[0], link('/client/reset-password', token))), 'portal reset');
  }
}

export async function resetPassword(token: string, password: string): Promise<void> {
  const row = await consume(token, PortalTokenType.RESET_PASSWORD);
  const passwordHash = await hashPassword(password);
  await prisma.$transaction([
    prisma.clientPortalUser.update({ where: { id: row.portalUserId }, data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null } }),
    prisma.portalToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
    prisma.clientPortalSession.updateMany({ where: { portalUserId: row.portalUserId, status: SessionStatus.ACTIVE }, data: { status: SessionStatus.REVOKED, revokedAt: new Date(), revokeReason: LogoutReason.PASSWORD_CHANGED } }),
  ]);
}
