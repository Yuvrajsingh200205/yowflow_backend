import crypto from 'crypto';
import { prisma } from '../config/prisma';
import { API_KEY_PREFIX } from '../middleware/auth';
import { AuthContext } from '../types';
import { notFound } from '../utils/errors';
import { AuditRequestContext, recordAudit } from './audit.service';

const hash = (key: string) => crypto.createHash('sha256').update(key).digest('hex');

export interface CreateApiKeyInput {
  name: string;
  scope: 'READ_ONLY' | 'FULL';
  expiresInDays?: number;
}

const view = (k: { id: string; name: string; prefix: string; scope: string; lastUsedAt: Date | null; expiresAt: Date | null; revokedAt: Date | null; createdAt: Date; user?: { fullName: string } }) => ({
  id: k.id, name: k.name, prefix: k.prefix, scope: k.scope, lastUsedAt: k.lastUsedAt, expiresAt: k.expiresAt, revokedAt: k.revokedAt, createdAt: k.createdAt, createdBy: k.user?.fullName ?? null,
});

export async function listApiKeys(auth: AuthContext) {
  const rows = await prisma.apiKey.findMany({ where: { organizationId: auth.organizationId }, orderBy: { createdAt: 'desc' }, include: { user: { select: { fullName: true } } } });
  return rows.map(view);
}

/** Returns the plaintext key exactly once; only its hash is stored. */
export async function createApiKey(auth: AuthContext, input: CreateApiKeyInput, ctx: AuditRequestContext) {
  const secret = crypto.randomBytes(24).toString('base64url');
  const plaintext = `${API_KEY_PREFIX}${secret}`;
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.apiKey.create({
      data: {
        organizationId: auth.organizationId,
        userId: auth.userId,
        name: input.name.trim(),
        prefix: plaintext.slice(0, 12),
        keyHash: hash(plaintext),
        scope: input.scope,
        expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
      },
      include: { user: { select: { fullName: true } } },
    });
    await recordAudit(tx, ctx, { action: 'CREATE', entityType: 'ApiKey', entityId: created.id, summary: `API key "${created.name}" created (${created.scope})` });
    return created;
  });
  return { ...view(row), key: plaintext };
}

export async function revokeApiKey(auth: AuthContext, id: string, ctx: AuditRequestContext) {
  const key = await prisma.apiKey.findFirst({ where: { id, organizationId: auth.organizationId } });
  if (!key) throw notFound('API key');
  if (key.revokedAt) return;
  await prisma.$transaction(async (tx) => {
    await tx.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    await recordAudit(tx, ctx, { action: 'DELETE', entityType: 'ApiKey', entityId: id, summary: `API key "${key.name}" revoked` });
  });
}
