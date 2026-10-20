import crypto from 'crypto';
import { EmailTokenType, LogoutReason, SessionStatus } from '@prisma/client';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { brand } from '../config/brand';
import { logger } from '../config/logger';
import { hashPassword } from '../utils/password';
import { badRequest, conflict, notFound } from '../utils/errors';
import { recordAudit } from './audit.service';
import { passwordResetEmail, sendMail, verificationEmail } from './mailer.service';
import { provisionOrganization } from './tenant.service';

export interface RequestMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

const VERIFY_TTL_MS = 48 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
export const TRIAL_DAYS = 14;

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

function slugify(input: string): string {
  const base = input.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56);
  return base || 'studio';
}

async function uniqueSlug(studioName: string): Promise<string> {
  const base = slugify(studioName);
  for (let i = 0; i < 6; i++) {
    const candidate = i === 0 ? base : `${base}-${crypto.randomBytes(2).toString('hex')}`;
    if (!(await prisma.organization.findUnique({ where: { slug: candidate }, select: { id: true } }))) return candidate;
  }
  return `${base}-${crypto.randomBytes(4).toString('hex')}`;
}

async function issueToken(userId: string, type: EmailTokenType, ttlMs: number): Promise<string> {
  // Only one live token per purpose: issuing a new one retires the old.
  await prisma.emailToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date() } });
  const token = newToken();
  await prisma.emailToken.create({ data: { userId, type, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMs) } });
  return token;
}

const link = (path: string, token: string) => `${env.APP_URL.replace(/\/$/, '')}${path}?token=${encodeURIComponent(token)}`;

async function trySend(task: () => Promise<void>, what: string) {
  try {
    await task();
  } catch (error) {
    // A mail outage must not fail the user's request (or reveal that an address exists).
    logger.error({ err: error, what }, 'transactional mail failed');
  }
}

export interface SignupInput {
  studioName: string;
  fullName: string;
  email: string;
  password: string;
  plan?: string;
}

/** Self-serve tenant creation: organisation + owner account + 14-day trial. */
export async function signup(input: SignupInput, meta: RequestMeta) {
  const email = input.email.toLowerCase();
  const existing = await prisma.user.findFirst({ where: { email, deletedAt: null }, select: { id: true } });
  if (existing) throw conflict('An account with this email already exists. Try logging in instead.');

  const slug = await uniqueSlug(input.studioName);
  const passwordHash = await hashPassword(input.password);
  const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

  const { organization, user } = await prisma.$transaction(
    async (tx) => {
      const provisioned = await provisionOrganization(tx, { name: input.studioName.trim(), slug });
      await tx.organization.update({
        where: { id: provisioned.organization.id },
        data: { email, settings: { plan: input.plan ?? 'studio', trialEndsAt: trialEndsAt.toISOString(), billing: { status: 'trialing' } } },
      });
      const adminRoleId = provisioned.roleIds.get('Admin');
      if (!adminRoleId) throw new Error('System role "Admin" was not provisioned');
      const created = await tx.user.create({
        data: {
          organizationId: provisioned.organization.id,
          branchId: provisioned.branch.id,
          email,
          fullName: input.fullName.trim(),
          employeeCode: 'EMP-S01',
          passwordHash,
          status: 'ACTIVE',
        },
      });
      await tx.userRole.create({ data: { userId: created.id, roleId: adminRoleId } });
      await recordAudit(
        tx,
        { organizationId: provisioned.organization.id, actorId: created.id, ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId },
        { action: 'CREATE', entityType: 'Organization', entityId: provisioned.organization.id, summary: 'Studio workspace created through self-serve signup' },
      );
      return { organization: provisioned.organization, user: created };
    },
    { timeout: 30_000, maxWait: 10_000 },
  );

  const token = await issueToken(user.id, EmailTokenType.VERIFY_EMAIL, VERIFY_TTL_MS);
  await trySend(() => sendMail(verificationEmail(email, user.fullName.split(' ')[0], link('/verify-email', token))), 'signup verification');

  return {
    organization: { id: organization.id, name: organization.name, slug: organization.slug },
    user: { id: user.id, email: user.email, fullName: user.fullName },
    trialEndsAt: trialEndsAt.toISOString(),
  };
}

/** Always resolves; never reveals whether the address has an account. */
export async function requestPasswordReset(emailInput: string): Promise<void> {
  const email = emailInput.toLowerCase();
  const users = await prisma.user.findMany({ where: { email, deletedAt: null, status: 'ACTIVE' }, select: { id: true, fullName: true } });
  for (const user of users) {
    const token = await issueToken(user.id, EmailTokenType.RESET_PASSWORD, RESET_TTL_MS);
    await trySend(() => sendMail(passwordResetEmail(email, user.fullName.split(' ')[0], link('/reset-password', token))), 'password reset');
  }
}

async function consumeToken(token: string, type: EmailTokenType) {
  const row = await prisma.emailToken.findUnique({ where: { tokenHash: sha256(token) }, include: { user: { select: { id: true, organizationId: true, emailVerifiedAt: true } } } });
  if (!row || row.type !== type || row.usedAt || row.expiresAt.getTime() < Date.now()) {
    throw badRequest('This link is invalid or has expired. Request a new one.');
  }
  return row;
}

export async function resetPassword(token: string, newPassword: string, meta: RequestMeta): Promise<void> {
  const row = await consumeToken(token, EmailTokenType.RESET_PASSWORD);
  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: row.userId },
      data: { passwordHash, passwordChangedAt: new Date(), failedLoginAttempts: 0, lockedUntil: null, emailVerifiedAt: row.user.emailVerifiedAt ?? new Date() },
    });
    await tx.emailToken.update({ where: { id: row.id }, data: { usedAt: new Date() } });
    // A reset implies the old credentials may be compromised: end every session.
    await tx.session.updateMany({
      where: { userId: row.userId, status: SessionStatus.ACTIVE },
      data: { status: SessionStatus.REVOKED, revokedAt: new Date(), revokeReason: LogoutReason.PASSWORD_CHANGED },
    });
    await recordAudit(
      tx,
      { organizationId: row.user.organizationId, actorId: row.userId, ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId },
      { action: 'UPDATE', entityType: 'User', entityId: row.userId, summary: 'Password reset through e-mail link; sessions revoked' },
    );
  });
}

export async function verifyEmail(token: string): Promise<void> {
  const row = await consumeToken(token, EmailTokenType.VERIFY_EMAIL);
  await prisma.$transaction([
    prisma.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: row.user.emailVerifiedAt ?? new Date() } }),
    prisma.emailToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
  ]);
}

export async function resendVerification(userId: string): Promise<{ alreadyVerified: boolean }> {
  const user = await prisma.user.findFirst({ where: { id: userId, deletedAt: null }, select: { id: true, email: true, fullName: true, emailVerifiedAt: true } });
  if (!user) throw notFound('User');
  if (user.emailVerifiedAt) return { alreadyVerified: true };
  const last = await prisma.emailToken.findFirst({ where: { userId, type: EmailTokenType.VERIFY_EMAIL }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  if (last && Date.now() - last.createdAt.getTime() < RESEND_COOLDOWN_MS) {
    throw badRequest('A verification email was sent a moment ago. Please wait a minute before requesting another.');
  }
  const token = await issueToken(userId, EmailTokenType.VERIFY_EMAIL, VERIFY_TTL_MS);
  await trySend(() => sendMail(verificationEmail(user.email, user.fullName.split(' ')[0], link('/verify-email', token))), 'resend verification');
  return { alreadyVerified: false };
}

export interface ContactInput {
  name: string;
  email: string;
  company?: string;
  phone?: string;
  message: string;
  source?: string;
  /** Honeypot: real visitors leave it empty. */
  website?: string;
}

export async function submitContact(input: ContactInput, meta: RequestMeta): Promise<void> {
  if (input.website) return; // bot: pretend success, store nothing
  const ipHash = meta.ipAddress ? sha256(`${meta.ipAddress}:${env.JWT_SECRET}`) : null;
  await prisma.contactMessage.create({
    data: { name: input.name.trim(), email: input.email.toLowerCase(), company: input.company?.trim() || null, phone: input.phone?.trim() || null, message: input.message.trim(), source: input.source ?? null, ipHash },
  });
  await trySend(
    () => sendMail({
      to: brand.supportEmail,
      subject: `New contact message from ${input.name}`,
      text: `${input.name} <${input.email}>${input.company ? ` · ${input.company}` : ''}\n\n${input.message}`,
      html: `<p><strong>${escapeHtml(input.name)}</strong> &lt;${escapeHtml(input.email)}&gt;${input.company ? ` · ${escapeHtml(input.company)}` : ''}</p><p style="white-space:pre-wrap">${escapeHtml(input.message)}</p>`,
    }),
    'contact notification',
  );
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
