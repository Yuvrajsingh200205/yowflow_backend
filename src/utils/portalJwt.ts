import jwt, { SignOptions } from 'jsonwebtoken';
import { brand } from '../config/brand';
import { env } from '../config/env';
import { unauthenticated } from './errors';

export interface PortalAccessTokenPayload {
  sub: string;
  organizationId: string;
  portalSessionId: string;
  audience: 'portal';
}

/** Portal tokens carry their own audience, so a studio or freelancer token can never be replayed here (or vice versa). */
export function signPortalAccessToken(payload: Omit<PortalAccessTokenPayload, 'audience'>): string {
  return jwt.sign({ ...payload, audience: 'portal' }, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN, issuer: brand.slug } as SignOptions);
}

export function verifyPortalAccessToken(token: string): PortalAccessTokenPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, { issuer: brand.slug });
    if (typeof decoded === 'string') throw new Error('Malformed token');
    const { sub, organizationId, portalSessionId, audience } = decoded as jwt.JwtPayload & Partial<PortalAccessTokenPayload>;
    if (!sub || !organizationId || !portalSessionId || audience !== 'portal') throw new Error('Incomplete token');
    return { sub, organizationId, portalSessionId, audience };
  } catch {
    throw unauthenticated('Invalid or expired portal access token');
  }
}
