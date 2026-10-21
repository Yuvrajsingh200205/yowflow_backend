import { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { AppError, ErrorCode, ErrorDetail } from '../utils/errors';
import { logger } from '../config/logger';
import { env } from '../config/env';

interface Normalized {
  statusCode: number;
  code: ErrorCode;
  message: string;
  details: ErrorDetail[];
  /** Transient failure: the client may retry the same request. */
  retryable?: boolean;
}

/**
 * Translates every failure into the standard error envelope. Raw Prisma and
 * PostgreSQL text is deliberately never forwarded to the client (§33) — only
 * the mapped, human-safe message is.
 */
function normalize(error: unknown): Normalized {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.expose ? error.message : 'An unexpected error occurred',
      details: error.details,
    };
  }

  if (error instanceof ZodError) {
    return {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Invalid request',
      details: error.issues.map((i) => ({
        field: i.path.join('.') || undefined,
        message: i.message,
      })),
    };
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case 'P2002': {
        const target = (error.meta?.target as string[] | string | undefined) ?? [];
        const fields = Array.isArray(target) ? target : [target];
        return {
          statusCode: 409,
          code: 'CONFLICT',
          message: 'A record with these details already exists',
          details: fields.filter(Boolean).map((f) => ({ field: String(f), message: 'Must be unique' })),
        };
      }
      case 'P2003':
        return {
          statusCode: 409,
          code: 'CONFLICT',
          message: 'A referenced record does not exist or is still in use',
          details: [],
        };
      // Connection-pool exhaustion / database briefly unreachable / deadlock: all transient and safe to retry.
      case 'P2024':
      case 'P1001':
      case 'P1002':
      case 'P1008':
      case 'P1017':
      case 'P2028':
      case 'P2037':
        return {
          statusCode: 503,
          code: 'SERVICE_UNAVAILABLE',
          message: 'The service is busy right now. Please try again in a moment.',
          details: [],
          retryable: true,
        };
      case 'P2034':
        return {
          statusCode: 409,
          code: 'CONFLICT',
          message: 'The record was changed by someone else at the same time. Please retry.',
          details: [],
          retryable: true,
        };
      case 'P2025':
        return { statusCode: 404, code: 'NOT_FOUND', message: 'Resource not found', details: [] };
      case 'P2000':
        return {
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          message: 'A submitted value is too long for its field',
          details: [],
        };
      default:
        return {
          statusCode: 500,
          code: 'INTERNAL_ERROR',
          message: 'An unexpected database error occurred',
          details: [],
        };
    }
  }

  // A CHECK constraint rejection surfaces as an unknown request error carrying
  // SQLSTATE 23514. It means a database-level business rule was violated.
  if (
    error instanceof Prisma.PrismaClientUnknownRequestError ||
    error instanceof Prisma.PrismaClientValidationError
  ) {
    const text = String((error as Error).message ?? '');
    if (text.includes('23514')) {
      return {
        statusCode: 422,
        code: 'UNPROCESSABLE',
        message: 'The request violates a business rule enforced by the database',
        details: [],
      };
    }
    return {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'The request could not be processed',
      details: [],
    };
  }

  if (error instanceof Prisma.PrismaClientInitializationError) {
    return {
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'Database connection is unavailable. Please try again in a moment.',
      details: [],
      retryable: true,
    };
  }

  const asHttp = error as { status?: number; statusCode?: number; type?: string };
  if (asHttp?.type === 'entity.too.large') {
    return {
      statusCode: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Request body exceeds the maximum allowed size',
      details: [],
    };
  }
  if (asHttp?.type === 'entity.parse.failed') {
    return {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Request body is not valid JSON',
      details: [],
    };
  }

  return {
    statusCode: 500,
    code: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred',
    details: [],
  };
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const normalized = normalize(error);

  const log = {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl,
    statusCode: normalized.statusCode,
    userId: req.auth?.userId,
  };

  if (normalized.retryable) {
    // Transient infrastructure trouble: one concise line, not a stack trace per request.
    logger.warn({ ...log, code: normalized.code, cause: (error as Error)?.message?.split('\n').pop() }, 'transient database failure');
  } else if (normalized.statusCode >= 500) {
    logger.error({ ...log, err: error }, 'request failed');
  } else {
    // The underlying cause is logged server-side even for 4xx — the client
    // only ever sees the mapped message.
    logger.warn(
      { ...log, code: normalized.code, cause: (error as Error)?.message },
      'request rejected',
    );
  }

  if (res.headersSent) return;

  if (normalized.retryable) res.setHeader('Retry-After', '2');
  res.status(normalized.statusCode).json({
    success: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      details: normalized.details,
      requestId: req.requestId,
      ...(env.isProduction || normalized.statusCode < 500
        ? {}
        : { stack: (error as Error)?.stack }),
    },
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `Endpoint ${req.method} ${req.originalUrl} does not exist`,
      details: [],
      requestId: req.requestId,
    },
  });
}
