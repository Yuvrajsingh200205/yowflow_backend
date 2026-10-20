import { brand } from '../config/brand';
import jwt, { SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';
import { unauthenticated } from './errors';

export interface FreelancerAccessTokenPayload {
  sub: string;
  organizationId: string;
  freelancerSessionId: string;
  audience: 'freelancer';
}

export function signFreelancerAccessToken(payload: Omit<FreelancerAccessTokenPayload, 'audience'>): string {
  return jwt.sign({ ...payload, audience: 'freelancer' }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
    issuer: brand.slug,
  } as SignOptions);
}

export function verifyFreelancerAccessToken(token: string): FreelancerAccessTokenPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, { issuer: brand.slug });
    if (typeof decoded === 'string') throw new Error('Malformed token');
    const { sub, organizationId, freelancerSessionId, audience } = decoded as jwt.JwtPayload &
      Partial<FreelancerAccessTokenPayload>;
    if (!sub || !organizationId || !freelancerSessionId || audience !== 'freelancer') {
      throw new Error('Incomplete token');
    }
    return { sub, organizationId, freelancerSessionId, audience };
  } catch {
    throw unauthenticated('Invalid or expired freelancer access token');
  }
}
