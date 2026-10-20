import { NextFunction, Request, Response } from 'express';
import { SessionStatus } from '@prisma/client';
import { prisma } from '../config/prisma';
import { verifyFreelancerAccessToken } from '../utils/freelancerJwt';
import { forbidden, unauthenticated } from '../utils/errors';
import { brand } from '../config/brand';

export const FREELANCER_ACCESS_COOKIE = brand.cookie.freelancerAccess;
export const FREELANCER_REFRESH_COOKIE = brand.cookie.freelancerRefresh;

function extractToken(req: Request): string | null {
  return (req.cookies as Record<string, string> | undefined)?.[FREELANCER_ACCESS_COOKIE] ?? null;
}

export async function requireFreelancerAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = extractToken(req);
    if (!token) throw unauthenticated('Freelancer authentication required');
    const payload = verifyFreelancerAccessToken(token);
    const session = await prisma.freelancerSession.findFirst({
      where: { id: payload.freelancerSessionId, freelancerId: payload.sub },
      include: { freelancer: true },
    });
    if (!session || session.status !== SessionStatus.ACTIVE || session.expiresAt <= new Date()) {
      throw unauthenticated('Freelancer session is no longer valid');
    }
    const freelancer = session.freelancer;
    if (freelancer.organizationId !== payload.organizationId || freelancer.deletedAt) {
      throw unauthenticated('Freelancer account no longer exists');
    }
    if (freelancer.status === 'SUSPENDED' || freelancer.status === 'INACTIVE') {
      throw forbidden(`Freelancer account is ${freelancer.status.toLowerCase()}`);
    }
    req.freelancerAuth = {
      freelancerId: freelancer.id,
      organizationId: freelancer.organizationId,
      sessionId: session.id,
      email: freelancer.email,
      phone: freelancer.phone,
      fullName: freelancer.fullName,
    };
    void prisma.freelancerSession
      .update({ where: { id: session.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
    next();
  } catch (error) {
    next(error);
  }
}
