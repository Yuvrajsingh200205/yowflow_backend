import { NextFunction, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { verifyAccessToken } from '../utils/jwt';
import { forbidden, unauthenticated } from '../utils/errors';
import { TtlCache } from '../utils/cache';
import { AuthContext } from '../types';
import { brand } from '../config/brand';

export const ACCESS_COOKIE = brand.cookie.access;
export const REFRESH_COOKIE = brand.cookie.refresh;

/**
 * Authority is never cached: a revoked session, a disabled account or a
 * permission removed a second ago must take effect on the very next request.
 * Only `lastUsedAt` — a liveness marker nothing authorises on — is throttled.
 */
const sessionTouchCache = new TtlCache<true>(30_000, 500);

/**
 * Session, account, roles and permissions in a single round trip. Expressed as
 * SQL because Prisma resolves each nested relation with its own query, which
 * made authenticating one request cost five sequential round trips.
 */
interface SessionRow {
  session_id: string;
  session_status: string;
  expires_at: Date;
  user_id: string;
  organization_id: string;
  branch_id: string | null;
  email: string;
  full_name: string;
  employee_code: string | null;
  user_status: string;
  deleted_at: Date | null;
  org_id: string;
  org_name: string;
  org_slug: string;
  org_currency: string;
  org_timezone: string;
  freelancer_id: string | null;
  freelancer_status: string | null;
  roles: string[];
  permissions: string[];
  override_permissions: unknown;
}

function extractToken(req: Request): string | null {
  const header = req.header('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const cookie = (req.cookies as Record<string, string> | undefined)?.[ACCESS_COOKIE];
  return cookie ?? null;
}

/**
 * Verifies the access token, then re-reads the user, session, roles and
 * permissions from PostgreSQL on every request.
 *
 * The token is only proof of *identity*; authority always comes from the
 * database. That means a revoked session, a disabled account or a permission
 * removed a second ago takes effect immediately, rather than lingering until
 * the token expires.
 */
export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = extractToken(req);
    if (!token) throw unauthenticated('Authentication required');

    const payload = verifyAccessToken(token);

    const rows = await prisma.$queryRaw<SessionRow[]>`
      SELECT
        s.id            AS session_id,
        s.status::text  AS session_status,
        s.expires_at    AS expires_at,
        u.id            AS user_id,
        u.organization_id,
        u.branch_id,
        u.email,
        u.full_name,
        u.employee_code,
        u.status::text  AS user_status,
        u.deleted_at,
        o.id            AS org_id,
        o.name          AS org_name,
        o.slug          AS org_slug,
        o.currency      AS org_currency,
        o.timezone      AS org_timezone,
        f.id            AS freelancer_id,
        f.status::text  AS freelancer_status,
        coalesce(array_agg(DISTINCT r.name) FILTER (WHERE r.id IS NOT NULL), '{}') AS roles,
        coalesce(array_agg(DISTINCT p.key) FILTER (WHERE p.id IS NOT NULL), '{}') AS permissions,
        max(upo.permission_keys::text)::jsonb AS override_permissions
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      JOIN organizations o ON o.id = u.organization_id
      LEFT JOIN user_roles ur ON ur.user_id = u.id
      LEFT JOIN roles r ON r.id = ur.role_id AND r.deleted_at IS NULL AND r.status = 'ACTIVE'
      LEFT JOIN role_permissions rp ON rp.role_id = r.id
      LEFT JOIN permissions p ON p.id = rp.permission_id
      LEFT JOIN user_permission_overrides upo ON upo.user_id = u.id AND upo.organization_id = u.organization_id
      LEFT JOIN freelancers f ON f.user_id = u.id
        AND f.organization_id = u.organization_id
        AND f.deleted_at IS NULL
        AND f.status NOT IN ('SUSPENDED', 'INACTIVE')
      WHERE s.id = ${payload.sessionId}::uuid
      GROUP BY s.id, s.status, s.expires_at, u.id, o.id, f.id, f.status
    `;

    const row = rows[0];
    if (!row || row.session_status !== 'ACTIVE' || row.expires_at <= new Date()) {
      throw unauthenticated('Session is no longer valid');
    }
    if (row.user_id !== payload.sub) throw unauthenticated('Session mismatch');
    if (row.deleted_at !== null || row.organization_id !== payload.organizationId) {
      throw unauthenticated('Account no longer exists');
    }
    if (row.user_status !== 'ACTIVE') throw forbidden(`Account is ${row.user_status.toLowerCase()}`);

    const roles = row.roles;
    const override = Array.isArray(row.override_permissions) && row.override_permissions.every((key) => typeof key === 'string')
      ? row.override_permissions as string[]
      : null;
    // A present override is an explicit effective set, not an additive grant.
    const permissions = new Set(override ?? row.permissions);

    const auth: AuthContext = {
      userId: row.user_id,
      organizationId: row.organization_id,
      branchId: row.branch_id,
      sessionId: row.session_id,
      email: row.email,
      fullName: row.full_name,
      roles,
      permissions,
      // Lets `GET /auth/me` answer from what this middleware already loaded.
      sessionUser: {
        id: row.user_id,
        organizationId: row.organization_id,
        branchId: row.branch_id,
        email: row.email,
        fullName: row.full_name,
        employeeCode: row.employee_code,
        status: row.user_status,
        roles,
        permissions: [...permissions].sort(),
        organization: {
          id: row.org_id,
          name: row.org_name,
          slug: row.org_slug,
          currency: row.org_currency,
          timezone: row.org_timezone,
        },
        freelancerProfile: row.freelancer_id
          ? { id: row.freelancer_id, status: row.freelancer_status ?? 'ACTIVE' }
          : null,
      },
    };

    req.auth = auth;
    touchSession(row.session_id);

    next();
  } catch (error) {
    next(error);
  }
}

function touchSession(sessionId: string): void {
  if (sessionTouchCache.get(sessionId)) return;
  sessionTouchCache.set(sessionId, true);
  void prisma.session
    .update({ where: { id: sessionId }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);
}

/** Populates `req.auth` when a valid token is present, but never rejects. */
export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!extractToken(req)) {
    next();
    return;
  }
  await requireAuth(req, res, (err?: unknown) => next(err instanceof Error ? undefined : err));
}
