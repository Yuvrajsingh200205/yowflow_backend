import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app';
import { env } from '../../src/config/env';
import { TestUser } from './factory';

export const app: Express = createApp();
export const base = env.API_BASE_PATH;

export const api = () => request(app);

/** Signs in and returns the bearer token for that user. */
export async function login(user: TestUser): Promise<string> {
  const response = await request(app)
    .post(`${base}/auth/login`)
    .send({ email: user.email, password: user.password });

  if (response.status !== 200) {
    throw new Error(`login failed (${response.status}): ${JSON.stringify(response.body)}`);
  }
  return response.body.data.tokens.accessToken as string;
}

export const authed = (token: string) => ({
  get: (path: string) => request(app).get(path).set('Authorization', `Bearer ${token}`),
  post: (path: string) => request(app).post(path).set('Authorization', `Bearer ${token}`),
  patch: (path: string) => request(app).patch(path).set('Authorization', `Bearer ${token}`),
  put: (path: string) => request(app).put(path).set('Authorization', `Bearer ${token}`),
  delete: (path: string) => request(app).delete(path).set('Authorization', `Bearer ${token}`),
});

/**
 * Retries an assertion until it holds. Login writes its history and audit rows
 * after the response is sent — on purpose, so signing in is not slowed by
 * bookkeeping — which means reading them straight away is a race.
 */
export async function eventually<T>(check: () => Promise<T>, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) throw lastError;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

let counter = 0;
export const idempotencyKey = (prefix = 'test') => `${prefix}-${Date.now()}-${counter++}`;
