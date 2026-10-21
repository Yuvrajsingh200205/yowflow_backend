import { NextFunction, Request, Response } from 'express';
import { prisma } from '../config/prisma';
import { brand } from '../config/brand';
import { verifyPortalAccessToken } from '../utils/portalJwt';
import { forbidden, unauthenticated } from '../utils/errors';
import { TtlCache } from '../utils/cache';

export const PORTAL_ACCESS_COOKIE = brand.cookie.portalAccess;
export const PORTAL_REFRESH_COOKIE = brand.cookie.portalRefresh;

interface Row {
  session_status: string;
  expires_at: Date;
  portal_user_id: string;
  organization_id: string;
  client_id: string;
  email: string;
  full_name: string;
  user_status: string;
  deleted_at: Date | null;
  client_deleted_at: Date | null;
  org_status: string;
}

const touchCache = new TtlCache<true>(60_000, 500);

/**
 * Authenticates a client-portal request. One SQL round trip resolves the
 * session, the portal user, the CRM client and the organisation, and the
 * result is always re-read from the database: suspending a portal user or
 * revoking a session takes effect on the very next request.
 */
export async function requirePortalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = (req.cookies as Record<string, string> | undefined)?.[PORTAL_ACCESS_COOKIE];
    if (!token) throw unauthenticated('Portal authentication required');
    const payload = verifyPortalAccessToken(token);

    const rows = await prisma.$queryRaw<Row[]>`
      SELECT s.status::text AS session_status, s.expires_at,
             u.id AS portal_user_id, u.organization_id, u.client_id, u.email, u.full_name,
             u.status::text AS user_status, u.deleted_at,
             c.deleted_at AS client_deleted_at, o.status::text AS org_status
      FROM client_portal_sessions s
      JOIN client_portal_users u ON u.id = s.portal_user_id
      JOIN clients c ON c.id = u.client_id
      JOIN organizations o ON o.id = u.organization_id
      WHERE s.id = ${payload.portalSessionId}::uuid AND s.portal_user_id = ${payload.sub}::uuid
    `;
    const row = rows[0];
    if (!row || row.session_status !== 'ACTIVE' || row.expires_at <= new Date()) throw unauthenticated('Portal session is no longer valid');
    if (row.organization_id !== payload.organizationId || row.deleted_at || row.client_deleted_at) throw unauthenticated('Portal account no longer exists');
    if (row.user_status !== 'ACTIVE' || row.org_status !== 'ACTIVE') throw forbidden('Portal access is not active');

    req.portalAuth = {
      portalUserId: row.portal_user_id,
      organizationId: row.organization_id,
      clientId: row.client_id,
      sessionId: payload.portalSessionId,
      email: row.email,
      fullName: row.full_name,
    };
    if (!touchCache.get(payload.portalSessionId)) {
      touchCache.set(payload.portalSessionId, true);
      void prisma.clientPortalSession.update({ where: { id: payload.portalSessionId }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    }
    next();
  } catch (error) {
    next(error);
  }
}

export function requirePortalContext(req: Request) {
  if (!req.portalAuth) throw unauthenticated('Portal authentication required');
  return req.portalAuth;
}
