import express, { Request, Response } from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import pinoHttp from 'pino-http';
import swaggerUi from 'swagger-ui-express';

import { env } from './config/env';
import { logger } from './config/logger';
import { prisma } from './config/prisma';
import apiRoutes from './routes';
import { requestId } from './middleware/requestId';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { generalLimiter } from './middleware/rateLimiter';
import { jsonReplacer } from './utils/serialize';
import { openApiDocument } from './docs/openapi';
import { localObjectPath, verifyLocalSignedUrl } from './services/storage.service';

let cachedApp: ReturnType<typeof createApp> | undefined;

/**
 * Vercel's Express detection treats `src/app.ts` as a function entrypoint and
 * requires a default export that is a request handler.
 */
export default function handler(req: Request, res: Response) {
  cachedApp ??= createApp();
  return cachedApp(req, res);
}

export function createApp() {
  const app = express();

  // Behind a load balancer / reverse proxy, `req.ip` and Secure cookies depend
  // on X-Forwarded-* being honoured.
  app.set('trust proxy', 1);
  // BigInt (files.size_bytes) is not JSON-serialisable by default.
  app.set('json replacer', jsonReplacer);
  app.disable('x-powered-by');

  app.use(requestId);

  // JSON list payloads are highly repetitive and compress an order of
  // magnitude. Placed ahead of every route so API responses, the OpenAPI
  // document and the Swagger UI assets all benefit.
  app.use(compression());

  app.use(
    helmet({
      contentSecurityPolicy: env.isProduction ? undefined : false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  // Strict allowlist — an unknown Origin is rejected rather than reflected (§38).
  const corsOrigins = env.corsOrigins.map((origin) => origin.replace(/\/$/, ''));
  const vercelFrontend = /^https:\/\/wedding-photo-planet([a-z0-9-]+)?\.vercel\.app$/i;
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) return callback(null, true);
        const normalized = origin.replace(/\/$/, '');
        if (corsOrigins.includes(normalized) || vercelFrontend.test(normalized)) {
          return callback(null, true);
        }
        return callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Requested-With',
        'Accept',
        'Idempotency-Key',
        'X-Request-Id',
      ],
      exposedHeaders: ['X-Request-Id', 'Idempotency-Replayed'],
      maxAge: 86400,
    }),
  );

  app.use(
    express.json({
      limit: env.JSON_BODY_LIMIT,
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    }),
  );
  app.use(express.urlencoded({ extended: true, limit: env.JSON_BODY_LIMIT }));
  app.use(cookieParser());

  // LOCAL storage is for development only. Production uses the same signed URL
  // contract but persists binary content in PostgreSQL FileObject rows.
  const localObjectKey = (req: Request) => {
    const key = req.params[0];
    return typeof key === 'string' ? key : '';
  };
  const localStorageAuthorized = (req: Request, objectKey: string) => {
    return Boolean(objectKey) && verifyLocalSignedUrl(env.STORAGE_BUCKET, objectKey, req.query.expires, req.query.signature);
  };
  app.put('/files/*', express.raw({ type: '*/*', limit: '50mb' }), async (req, res, next) => {
    const objectKey = localObjectKey(req);
    if (!localStorageAuthorized(req, objectKey)) return res.status(403).end();
    if (!Buffer.isBuffer(req.body)) return res.status(400).end();
    if (env.STORAGE_PROVIDER === 'DATABASE') {
      try {
        const result = await prisma.fileObject.updateMany({
          where: {
            bucket: env.STORAGE_BUCKET,
            objectKey,
            storageProvider: 'DATABASE',
            isRegistered: false,
            deletedAt: null,
            content: null,
          },
          data: { content: Uint8Array.from(req.body) },
        });
        return result.count === 1 ? res.status(204).end() : res.status(404).end();
      } catch (error) {
        return next(error);
      }
    }
    if (env.STORAGE_PROVIDER !== 'LOCAL') return next();
    const target = localObjectPath(objectKey);
    if (!target) return res.status(403).end();
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, req.body);
      return res.status(204).end();
    } catch (error) {
      return next(error);
    }
  });
  app.get('/files/*', async (req, res, next) => {
    const objectKey = localObjectKey(req);
    if (!localStorageAuthorized(req, objectKey)) return res.status(403).end();
    if (env.STORAGE_PROVIDER === 'DATABASE') {
      try {
        const file = await prisma.fileObject.findFirst({
          where: {
            bucket: env.STORAGE_BUCKET,
            objectKey,
            storageProvider: 'DATABASE',
            isRegistered: true,
            deletedAt: null,
            content: { not: null },
          },
          select: { content: true, mimeType: true, sizeBytes: true },
        });
        if (!file?.content) return res.status(404).end();
        res.type(file.mimeType);
        res.setHeader('Content-Length', file.sizeBytes.toString());
        // Prisma hands back Bytes as a Uint8Array, and res.send() serialises
        // that to JSON rather than writing binary — every download came out as
        // {"0":97,"1":45,...}. Buffer.from gives Express real bytes to send.
        return res.send(Buffer.from(file.content));
      } catch (error) {
        return next(error);
      }
    }
    if (env.STORAGE_PROVIDER !== 'LOCAL') return next();
    const target = localObjectPath(objectKey);
    if (!target) return res.status(403).end();
    try {
      await fs.access(target);
      return res.sendFile(target);
    } catch {
      return res.status(404).end();
    }
  });

  if (!env.isTest) {
    app.use(
      pinoHttp({
        logger,
        genReqId: (req) => (req as Request).requestId,
        autoLogging: {
          ignore: (req) =>
            req.url === '/favicon.ico' || (req.url?.startsWith('/health') ?? false),
        },
        customLogLevel: (_req, res, err) => {
          if (err || res.statusCode >= 500) return 'error';
          if (res.statusCode >= 400) return 'warn';
          return 'info';
        },
      }),
    );
  }

  // --- Service index ------------------------------------------------------

  // Opening the root in a browser should explain what this service is and
  // where to go, rather than returning a bare 404.
  app.get('/', (_req: Request, res: Response) => {
    res.json({
      success: true,
      data: {
        service: 'Wedding Photo Planet CRM API',
        version: '1.0.0',
        database: 'postgresql',
        environment: env.NODE_ENV,
        links: {
          documentation: '/docs',
          openapi: '/openapi.json',
          health: '/health',
          readiness: '/health/ready',
          api: env.API_BASE_PATH,
        },
        hint: `Endpoints live under ${env.API_BASE_PATH} and require a bearer token from POST ${env.API_BASE_PATH}/auth/login`,
      },
    });
  });

  // Browsers request this unprompted; answer quietly instead of logging a 404.
  app.get('/favicon.ico', (_req: Request, res: Response) => res.status(204).end());

  // --- Health -------------------------------------------------------------

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      success: true,
      data: {
        status: 'ok',
        service: 'wedding-photo-planet-backend',
        environment: env.NODE_ENV,
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
      },
    });
  });

  // Readiness genuinely probes PostgreSQL (§39) — a process that cannot reach
  // its database must not receive traffic.
  app.get('/health/ready', async (_req: Request, res: Response) => {
    const startedAt = Date.now();
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({
        success: true,
        data: {
          status: 'ready',
          database: { engine: 'postgresql', reachable: true, latencyMs: Date.now() - startedAt },
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error({ err: error }, 'readiness probe failed');
      res.status(503).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'PostgreSQL is not reachable',
          details: [],
        },
      });
    }
  });

  // --- API docs -----------------------------------------------------------

  app.get('/openapi.json', (_req, res) => res.json(openApiDocument));
  app.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(openApiDocument, {
      customSiteTitle: 'Wedding Photo Planet CRM API',
      swaggerOptions: { persistAuthorization: true },
    }),
  );

  // --- API ----------------------------------------------------------------

  app.use(env.API_BASE_PATH, generalLimiter, apiRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
