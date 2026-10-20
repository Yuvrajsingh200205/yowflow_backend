import { brand } from './config/brand';
import http from 'http';
import { createApp } from './app';
import { env } from './config/env';
import { logger } from './config/logger';
import { prisma } from './config/prisma';
import { syncPermissionCatalogue } from './services/permissionCatalogue.service';

async function main(): Promise<void> {
  // Fail fast if PostgreSQL is unreachable rather than accepting traffic and
  // erroring on every request.
  await prisma.$connect();
  logger.info('connected to PostgreSQL');
  const added = await syncPermissionCatalogue();
  if (added) logger.info({ added }, 'permission catalogue synced');

  const server = http.createServer(createApp());

  server.listen(env.PORT, () => {
    logger.info(
      {
        port: env.PORT,
        environment: env.NODE_ENV,
        apiBasePath: env.API_BASE_PATH,
        docs: `/docs`,
      },
      `${brand.slug} backend listening`,
    );
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    server.close(async () => {
      await prisma.$disconnect();
      logger.info('shutdown complete');
      process.exit(0);
    });
    // Do not hang forever on in-flight connections.
    setTimeout(() => process.exit(1), 15_000).unref();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception — exiting');
    process.exit(1);
  });
}

void main().catch((error) => {
  logger.fatal({ err: error }, 'failed to start server');
  process.exit(1);
});
