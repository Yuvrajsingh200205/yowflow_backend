import { brand } from '../config/brand';
import crypto from 'crypto';
import jwt, { SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';
import { unauthenticated } from './errors';

export interface AccessTokenPayload {
  sub: string;
  organizationId: string;
  sessionId: string;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
    issuer: brand.slug,
  } as SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, {
      issuer: brand.slug,
    });
    if (typeof decoded === 'string') throw new Error('Malformed token');
    const { sub, organizationId, sessionId } = decoded as jwt.JwtPayload &
      Partial<AccessTokenPayload>;
    if (!sub || !organizationId || !sessionId) throw new Error('Incomplete token');
    return { sub, organizationId, sessionId };
  } catch {
    // The underlying jwt reason is deliberately not surfaced to the client.
    throw unauthenticated('Invalid or expired access token');
  }
}

/**
 * Refresh tokens are opaque random strings, never JWTs. Only their SHA-256
 * hash is stored, so a database read cannot mint a session.
 */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(48).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

export const hashRefreshToken = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex');

/** Milliseconds represented by strings like `7d`, `15m`, `30s`, `12h`. */
export function parseDuration(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (!match) throw new Error(`Unsupported duration format: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2] as 's' | 'm' | 'h' | 'd';
  const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return amount * multipliers[unit];
}
