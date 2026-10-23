import { LoginOutcome, LogoutReason, SessionStatus } from '@prisma/client';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { hashPassword, verifyPassword } from '../utils/password';
import {
  generateRefreshToken,
  hashRefreshToken,
  verifyAccessToken,
  parseDuration,
  signAccessToken,
} from '../utils/jwt';
import { badRequest, forbidden, notFound, unauthenticated } from '../utils/errors';
import { recordAudit } from './audit.service';

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

export interface RequestMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  refreshTokenExpiresIn: number;
}

export interface SessionUser {
  id: string;
  organizationId: string;
  branchId: string | null;
  email: string;
  fullName: string;
  employeeCode: string | null;
  status: string;
  roles: string[];
  permissions: string[];
  organization: { id: string; name: string; slug: string; currency: string; timezone: string };
  emailVerified: boolean;
  freelancerProfile: { id: string; status: string } | null;
}

const USER_SELECT = {
  id: true,
  organizationId: true,
  branchId: true,
  email: true,
  fullName: true,
  employeeCode: true,
  status: true,
  emailVerifiedAt: true,
  passwordHash: true,
  failedLoginAttempts: true,
  lockedUntil: true,
  organization: { select: { id: true, name: true, slug: true, currency: true, timezone: true } },
  freelancerProfile: { select: { id: true, status: true, deletedAt: true } },
  userRoles: {
    select: {
      role: {
        select: {
          name: true,
          deletedAt: true,
          status: true,
          rolePermissions: { select: { permission: { select: { key: true } } } },
        },
      },
    },
  },
  permissionOverride: { select: { permissionKeys: true } },
} as const;

type RawUser = Awaited<ReturnType<typeof findUserForLogin>>;

async function findUserForLogin(identifier: string, organizationSlug?: string, password?: string) {
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { email: identifier.toLowerCase() },
        { phone: identifier },
        { employeeCode: identifier },
      ],
      deletedAt: null,
      ...(organizationSlug ? { organization: { slug: organizationSlug } } : {}),
    },
    select: USER_SELECT,
    orderBy: { lastLoginAt: { sort: 'desc', nulls: 'last' } },
    take: 10,
  });

  if (users.length === 0) return null;
  if (users.length === 1 || password === undefined) return users[0];
  // The same e-mail or phone exists in several studios (typical for freelancers who work with more than one).
  // The password says which account is meant; nobody can be signed in to an account whose password they lack.
  for (const candidate of users) {
    if (await verifyPassword(password, candidate.passwordHash)) return candidate;
  }
  return users[0];
}

function toSessionUser(user: NonNullable<RawUser>): SessionUser {
  // Mirrors the authorization join in `requireAuth`: a deleted or suspended
  // role grants nothing.
  const activeRoles = user.userRoles.filter(
    (ur) => ur.role.deletedAt === null && ur.role.status === 'ACTIVE',
  );
  const rolePermissions = new Set<string>();
  for (const { role } of activeRoles) {
    for (const rp of role.rolePermissions) rolePermissions.add(rp.permission.key);
  }
  const override = user.permissionOverride?.permissionKeys;
  const permissions = Array.isArray(override) && override.every((key): key is string => typeof key === 'string')
    ? new Set(override)
    : rolePermissions;
  return {
    id: user.id,
    organizationId: user.organizationId,
    branchId: user.branchId,
    email: user.email,
    fullName: user.fullName,
    employeeCode: user.employeeCode,
    status: user.status,
    roles: activeRoles.map((ur) => ur.role.name),
    permissions: [...permissions].sort(),
    emailVerified: user.emailVerifiedAt !== null,
    organization: user.organization,
    freelancerProfile: user.freelancerProfile &&
      user.freelancerProfile.deletedAt === null &&
      user.freelancerProfile.status !== 'SUSPENDED' &&
      user.freelancerProfile.status !== 'INACTIVE'
      ? { id: user.freelancerProfile.id, status: user.freelancerProfile.status }
      : null,
  };
}

async function issueSession(
  userId: string,
  organizationId: string,
  meta: RequestMeta,
): Promise<AuthTokens> {
  const refreshTtl = parseDuration(env.REFRESH_TOKEN_EXPIRES_IN);
  const { token, hash } = generateRefreshToken();

  const session = await prisma.session.create({
    data: {
      userId,
      refreshTokenHash: hash,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent?.slice(0, 512) ?? null,
      expiresAt: new Date(Date.now() + refreshTtl),
    },
    select: { id: true },
  });

  return {
    accessToken: signAccessToken({ sub: userId, organizationId, sessionId: session.id }),
    refreshToken: token,
    accessTokenExpiresIn: Math.floor(parseDuration(env.JWT_EXPIRES_IN) / 1000),
    refreshTokenExpiresIn: Math.floor(refreshTtl / 1000),
  };
}

export async function login(
  input: { email: string; password: string; organizationSlug?: string },
  meta: RequestMeta,
): Promise<{ user: SessionUser; tokens: AuthTokens }> {
  const identifier = input.email.trim().toLowerCase();
  const user = await findUserForLogin(identifier, input.organizationSlug, input.password);

  const recordAttempt = async (outcome: LoginOutcome, userId?: string) => {
    await prisma.loginHistory.create({
      data: {
        userId: userId ?? null,
        email: identifier,
        outcome,
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent?.slice(0, 512) ?? null,
      },
    });
  };

  if (!user) {
    await recordAttempt('INVALID_CREDENTIALS');
    // Identical message and shape whether the account exists or not.
    throw unauthenticated('Invalid email or password');
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await recordAttempt('ACCOUNT_LOCKED', user.id);
    throw forbidden('Account is temporarily locked after repeated failed logins');
  }

  const passwordValid = await verifyPassword(input.password, user.passwordHash);

  if (!passwordValid) {
    const attempts = user.failedLoginAttempts + 1;
    await Promise.all([
      prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: attempts,
          lockedUntil:
            attempts >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCK_DURATION_MS) : null,
        },
      }),
      recordAttempt('INVALID_CREDENTIALS', user.id),
    ]);
    throw unauthenticated('Invalid email or password');
  }

  if (user.status !== 'ACTIVE') {
    await recordAttempt('ACCOUNT_INACTIVE', user.id);
    throw forbidden(`Account is ${user.status.toLowerCase()}`);
  }

  // Only session creation gates the response; these writes are bookkeeping and
  // can finish just after the browser receives its authenticated session.
  const tokens = await issueSession(user.id, user.organizationId, meta);

  void Promise.all([
    prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    }),
    recordAttempt('SUCCESS', user.id),
    recordAudit(
      prisma,
      {
        organizationId: user.organizationId,
        actorId: user.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      },
      { action: 'LOGIN', entityType: 'User', entityId: user.id, summary: 'User signed in' },
    ),
  ]).catch((err) => logger.warn({ err, userId: user.id }, 'post-login bookkeeping failed'));

  return { user: toSessionUser(user), tokens };
}

/**
 * Rotates the refresh token: the presented token is retired the moment a new
 * one is issued, so a stolen token is single-use and its reuse is detectable.
 */
export async function refresh(
  refreshToken: string,
  meta: RequestMeta,
): Promise<{ user: SessionUser; tokens: AuthTokens }> {
  const hash = hashRefreshToken(refreshToken);
  const session = await prisma.session.findUnique({
    where: { refreshTokenHash: hash },
    select: { id: true, userId: true, status: true, expiresAt: true },
  });

  if (!session) throw unauthenticated('Invalid refresh token');
  if (session.status !== 'ACTIVE') throw unauthenticated('Session is no longer active');
  if (session.expiresAt <= new Date()) {
    await prisma.session.update({
      where: { id: session.id },
      data: { status: SessionStatus.EXPIRED, revokedAt: new Date() },
    });
    throw unauthenticated('Session has expired');
  }

  const user = await prisma.user.findFirst({
    where: { id: session.userId, deletedAt: null },
    select: USER_SELECT,
  });
  if (!user) throw unauthenticated('Account no longer exists');
  if (user.status !== 'ACTIVE') throw forbidden(`Account is ${user.status.toLowerCase()}`);

  await prisma.session.update({
    where: { id: session.id },
    data: {
      status: SessionStatus.LOGGED_OUT,
      revokedAt: new Date(),
      revokeReason: LogoutReason.TOKEN_REFRESH_ROTATION,
    },
  });

  const tokens = await issueSession(user.id, user.organizationId, meta);
  return { user: toSessionUser(user), tokens };
}

/**
 * Signs out whoever holds these credentials. Logging out must work even when the short-lived access token has
 * already expired (the refresh token alone identifies the session); otherwise the browser keeps its cookies and is
 * silently signed straight back in.
 */
export async function logoutByCredentials(input: { refreshToken?: string; accessToken?: string }, meta: RequestMeta): Promise<void> {
  let sessionId: string | null = null;
  if (input.refreshToken) {
    sessionId = (await prisma.session.findUnique({ where: { refreshTokenHash: hashRefreshToken(input.refreshToken) }, select: { id: true } }))?.id ?? null;
  }
  if (!sessionId && input.accessToken) {
    try { sessionId = verifyAccessToken(input.accessToken).sessionId; } catch { /* an expired or foreign token identifies nobody */ }
  }
  if (sessionId) await logout(sessionId, meta);
}

export async function logout(sessionId: string, meta: RequestMeta): Promise<void> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { id: true, userId: true, user: { select: { organizationId: true } } },
  });
  if (!session) return;

  await prisma.session.update({
    where: { id: sessionId },
    data: {
      status: SessionStatus.LOGGED_OUT,
      revokedAt: new Date(),
      revokeReason: LogoutReason.MANUAL_LOGOUT,
    },
  });

  await recordAudit(
    prisma,
    {
      organizationId: session.user.organizationId,
      actorId: session.userId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    },
    { action: 'LOGOUT', entityType: 'User', entityId: session.userId, summary: 'User signed out' },
  );
}

/** Revokes every active session for a user (§37 session revocation). */
export async function revokeAllSessions(
  userId: string,
  reason: LogoutReason = LogoutReason.ADMIN_REVOKED,
): Promise<number> {
  const result = await prisma.session.updateMany({
    where: { userId, status: SessionStatus.ACTIVE },
    data: { status: SessionStatus.REVOKED, revokedAt: new Date(), revokeReason: reason },
  });
  return result.count;
}

export async function listSessions(userId: string) {
  return prisma.session.findMany({
    where: { userId, status: SessionStatus.ACTIVE },
    select: {
      id: true,
      ipAddress: true,
      userAgent: true,
      issuedAt: true,
      lastUsedAt: true,
      expiresAt: true,
    },
    orderBy: { lastUsedAt: 'desc' },
  });
}

export async function getCurrentUser(userId: string): Promise<SessionUser> {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: USER_SELECT,
  });
  if (!user) throw notFound('User');
  return toSessionUser(user);
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  meta: RequestMeta,
): Promise<void> {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { id: true, organizationId: true, passwordHash: true },
  });
  if (!user) throw notFound('User');

  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw unauthenticated('Current password is incorrect');
  }
  if (await verifyPassword(newPassword, user.passwordHash)) {
    throw badRequest('New password must differ from the current password');
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(newPassword), passwordChangedAt: new Date() },
    });
    // Every other session is invalidated so a leaked password cannot persist.
    await tx.session.updateMany({
      where: { userId, status: SessionStatus.ACTIVE },
      data: {
        status: SessionStatus.REVOKED,
        revokedAt: new Date(),
        revokeReason: LogoutReason.PASSWORD_CHANGED,
      },
    });
    await recordAudit(
      tx,
      {
        organizationId: user.organizationId,
        actorId: userId,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      },
      {
        action: 'UPDATE',
        entityType: 'User',
        entityId: userId,
        summary: 'Password changed; other sessions revoked',
      },
    );
  });
}
