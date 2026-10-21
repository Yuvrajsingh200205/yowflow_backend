import { PrismaClient, Prisma } from '@prisma/client';
import { env } from './env';
import { logger } from './logger';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/** Number of SQL statements executed since the counter was last reset (only when PRISMA_COUNT_QUERIES=1). */
export const queryStats = { count: 0 };

function createPrisma(): PrismaClient {
  const client = new PrismaClient({
    log: [
      ...(env.isDevelopment ? [{ emit: 'event' as const, level: 'warn' as const }] : []),
      { emit: 'event' as const, level: 'error' as const },
      // Opt-in query counting for the query-budget tests and profiling (PRISMA_COUNT_QUERIES=1).
      ...(process.env.PRISMA_COUNT_QUERIES === '1' ? [{ emit: 'event' as const, level: 'query' as const }] : []),
    ],
  });
  if (process.env.PRISMA_COUNT_QUERIES === '1') {
    client.$on('query' as never, () => { queryStats.count += 1; });
  }
  client.$on('error' as never, (e: unknown) => logger.error({ prisma: e }, 'prisma error'));
  client.$on('warn' as never, (e: unknown) => logger.warn({ prisma: e }, 'prisma warning'));
  return client;
}

const cached = globalForPrisma.prisma;
const stale = Boolean(cached && !(cached as { personalSheet?: unknown }).personalSheet);
if (stale) {
  void cached?.$disconnect();
  globalForPrisma.prisma = undefined;
}
export const prisma = stale || !cached ? createPrisma() : cached;

if (!env.isProduction) {
  globalForPrisma.prisma = prisma;
}

/** Transaction client type — what every service method receives inside `$transaction`. */
export type Tx = Prisma.TransactionClient;

/** Either the root client or an open transaction, so repositories compose. */
export type Db = PrismaClient | Tx;

export { Prisma };
