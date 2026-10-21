import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { errorHandler } from '../../src/middleware/errorHandler';

function run(error: unknown) {
  const headers: Record<string, string> = {};
  let status = 0;
  let body: { success: boolean; error: { code: string; message: string } } | undefined;
  const res = {
    headersSent: false,
    locals: {},
    setHeader: (k: string, v: string) => { headers[k] = v; },
    status(code: number) { status = code; return this; },
    json(b: typeof body) { body = b; return this; },
  } as unknown as Response;
  errorHandler(error, { requestId: 'r1', method: 'GET', originalUrl: '/x' } as unknown as Request, res, vi.fn());
  return { status, headers, body };
}

const known = (code: string) => new Prisma.PrismaClientKnownRequestError('boom', { code, clientVersion: 'test' });

describe('database error mapping', () => {
  it.each(['P2024', 'P1001', 'P1002', 'P1008', 'P1017', 'P2028', 'P2037'])('%s is a retryable 503, never a generic 500', (code) => {
    const { status, headers, body } = run(known(code));
    expect(status).toBe(503);
    expect(headers['Retry-After']).toBe('2');
    expect(body?.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(body?.error.message).not.toMatch(/unexpected database error/i);
  });

  it('a write conflict (P2034) is a retryable 409', () => {
    const { status, headers } = run(known('P2034'));
    expect(status).toBe(409);
    expect(headers['Retry-After']).toBe('2');
  });

  it('unknown database errors stay generic and never leak internals', () => {
    const { status, body } = run(known('P9999'));
    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('boom');
  });

  it('unique violations still map to 409 without Retry-After', () => {
    const { status, headers } = run(known('P2002'));
    expect(status).toBe(409);
    expect(headers['Retry-After']).toBeUndefined();
  });
});
