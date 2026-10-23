/**
 * Application error taxonomy. Every error that reaches the client passes
 * through one of these, so raw Prisma/PostgreSQL text never leaks (§33).
 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNPROCESSABLE'
  | 'RATE_LIMITED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'IDEMPOTENCY_IN_PROGRESS'
  | 'PAYLOAD_TOO_LARGE'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export interface ErrorDetail {
  field?: string;
  message: string;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details: ErrorDetail[];
  readonly expose: boolean;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details: ErrorDetail[] = [],
    expose = true,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.expose = expose;
    Error.captureStackTrace?.(this, AppError);
  }
}

export const badRequest = (message: string, details: ErrorDetail[] = []) =>
  new AppError(400, 'VALIDATION_ERROR', message, details);

export const unauthenticated = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHENTICATED', message);

export const forbidden = (message = 'You do not have permission to perform this action') =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (resource = 'Resource') =>
  new AppError(404, 'NOT_FOUND', `${resource} not found`);

export const conflict = (message: string, details: ErrorDetail[] = []) =>
  new AppError(409, 'CONFLICT', message, details);

export const unprocessable = (message: string, details: ErrorDetail[] = []) =>
  new AppError(422, 'UNPROCESSABLE', message, details);

export const internal = (message = 'An unexpected error occurred') =>
  new AppError(500, 'INTERNAL_ERROR', message, [], false);

/** A feature that is switched off or temporarily unavailable; the message is safe to show to users. */
export const serviceUnavailable = (message: string) => new AppError(503, 'SERVICE_UNAVAILABLE', message);
