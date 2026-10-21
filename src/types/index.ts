import { Request } from 'express';

/** Everything the request handler chain knows about the caller. */
export interface AuthContext {
  userId: string;
  organizationId: string;
  branchId: string | null;
  sessionId: string;
  email: string;
  fullName: string;
  roles: string[];
  permissions: Set<string>;
  /** The `/auth/me` payload, already loaded while authenticating the request. */
  sessionUser?: {
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
    emailVerified?: boolean;
    freelancerProfile: { id: string; status: string } | null;
  };
}

/** A client (couple/family) signed in to the client portal. Never shares a code path with studio staff. */
export interface PortalAuthContext {
  portalUserId: string;
  organizationId: string;
  clientId: string;
  sessionId: string;
  email: string;
  fullName: string;
}

export interface FreelancerAuthContext {
  freelancerId: string;
  organizationId: string;
  sessionId: string;
  email: string | null;
  phone: string;
  fullName: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      freelancerAuth?: FreelancerAuthContext;
      portalAuth?: PortalAuthContext;
      requestId: string;
    }
    interface Locals {
      requestId?: string;
    }
  }
}

/** A request that has passed `requireAuth`, so `auth` is guaranteed present. */
export interface AuthedRequest extends Request {
  auth: AuthContext;
}

export interface FreelancerAuthedRequest extends Request {
  freelancerAuth: FreelancerAuthContext;
}

export interface ListQuery {
  page?: number;
  limit?: number;
  search?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  from?: string;
  to?: string;
}
