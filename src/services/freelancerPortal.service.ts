import { FreelancerConnectionStatus, LogoutReason, Prisma, SessionStatus, TaskStatus } from '@prisma/client';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { badRequest, conflict, notFound, unauthenticated } from '../utils/errors';
import { generateRefreshToken, hashRefreshToken, parseDuration } from '../utils/jwt';
import { signFreelancerAccessToken } from '../utils/freelancerJwt';
import { hashPassword, verifyPassword } from '../utils/password';
import { AuditRequestContext, recordAudit } from './audit.service';
import { money } from '../utils/money';
import { isFreelancerSearchable } from './freelancer.service';
import { dateRangeFilter, toDateOnly } from '../utils/date';
import { resolvePagination } from '../utils/pagination';
import { nextDocumentNumber } from '../utils/documentNumber';
import { newToken } from '../utils/token';
import { buildObjectKey, createSignedUrl, createUploadUrl, getStorageProvider } from './storage.service';
import { ensureDefaultPlans } from './freelancerBilling.service';

let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword(newToken()));

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

const portalUserEmail = (email: string | undefined, phone: string) =>
  (email?.trim().toLowerCase() || `${phone.replace(/\D/g, '')}@freelancer.local`);
const PORTAL_PORTFOLIO_FILE_TYPES = new Set(['FREELANCER', 'FREELANCER_DOCUMENT', 'FREELANCER_PORTFOLIO']);
const OPEN_TASK_STATUSES: TaskStatus[] = ['TODO', 'ASSIGNED', 'IN_PROGRESS', 'PAUSED', 'IN_REVIEW'];
const ACTIVE_CONNECTION_STATUSES: FreelancerConnectionStatus[] = ['INTERESTED', 'CONTACTED', 'ACCEPTED', 'ASSIGNED'];

export interface RequestMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export interface FreelancerTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  refreshTokenExpiresIn: number;
}

async function issueSession(freelancerId: string, organizationId: string, meta: RequestMeta): Promise<FreelancerTokens> {
  const refreshTtl = parseDuration(env.REFRESH_TOKEN_EXPIRES_IN);
  const { token, hash } = generateRefreshToken();
  const session = await prisma.freelancerSession.create({
    data: {
      freelancerId,
      refreshTokenHash: hash,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent?.slice(0, 512) ?? null,
      expiresAt: new Date(Date.now() + refreshTtl),
    },
    select: { id: true },
  });
  return {
    accessToken: signFreelancerAccessToken({ sub: freelancerId, organizationId, freelancerSessionId: session.id }),
    refreshToken: token,
    accessTokenExpiresIn: Math.floor(parseDuration(env.JWT_EXPIRES_IN) / 1000),
    refreshTokenExpiresIn: Math.floor(refreshTtl / 1000),
  };
}

const profileInclude = {
  subscriptions: { include: { plan: true }, orderBy: { createdAt: 'desc' as const }, take: 5 },
  availability: { orderBy: { date: 'asc' as const }, take: 30 },
  portfolioItems: { include: { fileObject: true }, orderBy: [{ sortOrder: 'asc' as const }, { createdAt: 'desc' as const }] },
  applications: { orderBy: { createdAt: 'desc' as const }, take: 5 },
  connections: {
    orderBy: { createdAt: 'desc' as const },
    take: 20,
    include: {
      project: { select: { id: true, projectNumber: true, name: true } },
      shoot: { select: { id: true, title: true, shootDate: true } },
      createdBy: { select: { id: true, fullName: true } },
    },
  },
  assignments: {
    orderBy: { createdAt: 'desc' as const },
    take: 20,
    include: { shoot: { select: { id: true, title: true, shootDate: true, status: true, project: { select: { id: true, projectNumber: true, name: true } } } } },
  },
  payouts: { orderBy: { paymentDate: 'desc' as const }, take: 20 },
} satisfies Prisma.FreelancerInclude;

type PortalFreelancerRecord = Prisma.FreelancerGetPayload<{ include: typeof profileInclude }>;

const safeFileObject = (file: PortalFreelancerRecord['portfolioItems'][number]['fileObject']) => file && ({
  id: file.id,
  originalName: file.originalName,
  mimeType: file.mimeType,
  sizeBytes: file.sizeBytes,
  createdAt: file.createdAt,
  /** Short-lived signed link so the page can show the picture. */
  url: file.mimeType.startsWith('image/') || file.mimeType.startsWith('video/') ? createSignedUrl(file.objectKey, file.bucket).url : null,
});

function toPortalFreelancer(freelancer: PortalFreelancerRecord) {
  return {
    id: freelancer.id,
    code: freelancer.code,
    fullName: freelancer.fullName,
    phone: freelancer.phone,
    whatsapp: freelancer.whatsapp,
    email: freelancer.email,
    city: freelancer.city,
    addressLine: freelancer.addressLine,
    primarySkill: freelancer.primarySkill,
    skills: freelancer.skills,
    experienceYears: freelancer.experienceYears,
    rate: freelancer.rate,
    rateType: freelancer.rateType,
    travelAvailable: freelancer.travelAvailable,
    maxShootsPerDay: freelancer.maxShootsPerDay,
    rating: freelancer.rating,
    status: freelancer.status,
    equipmentNotes: freelancer.equipmentNotes,
    notes: freelancer.notes,
    createdAt: freelancer.createdAt,
    updatedAt: freelancer.updatedAt,
    subscriptions: freelancer.subscriptions,
    availability: freelancer.availability,
    portfolioItems: freelancer.portfolioItems.map((item) => ({
      id: item.id,
      fileObjectId: item.fileObjectId,
      title: item.title,
      description: item.description,
      category: item.category,
      sortOrder: item.sortOrder,
      isPublished: item.isPublished,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      fileObject: safeFileObject(item.fileObject),
    })),
    applications: freelancer.applications.map((application) => ({
      id: application.id,
      status: application.status,
      rejectionReason: application.rejectionReason,
      submittedAt: application.submittedAt,
      reviewedAt: application.reviewedAt,
      createdAt: application.createdAt,
      updatedAt: application.updatedAt,
    })),
    connections: freelancer.connections,
    assignments: freelancer.assignments,
    payouts: freelancer.payouts,
  };
}

export async function getPortalMe(organizationId: string, freelancerId: string) {
  const freelancer = await prisma.freelancer.findFirst({
    where: { id: freelancerId, organizationId, deletedAt: null },
    include: profileInclude,
  });
  if (!freelancer) throw notFound('Freelancer');
  const searchable = await isFreelancerSearchable(organizationId, freelancerId);
  return { freelancer: toPortalFreelancer(freelancer), searchable };
}

export async function login(
  input: { identifier: string; password: string; studio?: string },
  meta: RequestMeta,
): Promise<{ me: Awaited<ReturnType<typeof getPortalMe>>; tokens: FreelancerTokens }> {
  const identifier = input.identifier.trim().toLowerCase();
  // The same phone or e-mail can belong to freelancers of different studios; the password decides which account is meant.
  const candidates = await prisma.freelancer.findMany({
    where: {
      deletedAt: null,
      status: { not: 'SUSPENDED' },
      ...(input.studio ? { organization: { slug: input.studio.toLowerCase() } } : {}),
      OR: [{ email: identifier }, { phone: identifier }, { whatsapp: identifier }],
    },
    orderBy: [{ lastLoginAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'asc' }],
    take: 10,
  });
  const withPassword = candidates.filter((c) => c.passwordHash);
  if (withPassword.length === 0) {
    await verifyPassword(input.password, await getDummyHash()); // keep timing similar for unknown accounts
    throw unauthenticated('Invalid freelancer credentials');
  }
  let freelancer = withPassword[0];
  let matched = false;
  for (const c of withPassword) {
    if (c.lockedUntil && c.lockedUntil > new Date()) continue;
    if (await verifyPassword(input.password, c.passwordHash as string)) { freelancer = c; matched = true; break; }
  }
  if (!matched) {
    if (withPassword.every((c) => c.lockedUntil && c.lockedUntil > new Date())) throw unauthenticated('Freelancer account is temporarily locked');
    const attempts = freelancer.failedLoginAttempts + 1;
    await prisma.freelancer.update({
      where: { id: freelancer.id },
      data: {
        failedLoginAttempts: attempts,
        lockedUntil: attempts >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCK_DURATION_MS) : null,
      },
    });
    throw unauthenticated('Invalid freelancer credentials');
  }
  const [tokens] = await Promise.all([
    issueSession(freelancer.id, freelancer.organizationId, meta),
    prisma.freelancer.update({ where: { id: freelancer.id }, data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() } }),
    recordAudit(prisma, {
      organizationId: freelancer.organizationId,
      actorId: null,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    }, { action: 'LOGIN', entityType: 'Freelancer', entityId: freelancer.id, summary: 'Freelancer signed in' }),
  ]);
  return { me: await getPortalMe(freelancer.organizationId, freelancer.id), tokens };
}

export async function issuePortalSessionForUser(
  userId: string,
  organizationId: string,
  meta: RequestMeta,
): Promise<{ me: Awaited<ReturnType<typeof getPortalMe>>; tokens: FreelancerTokens } | null> {
  const freelancer = await prisma.freelancer.findFirst({
    where: { userId, organizationId, deletedAt: null, status: { not: 'SUSPENDED' } },
    select: { id: true, organizationId: true },
  });
  if (!freelancer) return null;
  const tokens = await issueSession(freelancer.id, freelancer.organizationId, meta);
  await prisma.freelancer.update({ where: { id: freelancer.id }, data: { lastLoginAt: new Date() } });
  return { me: await getPortalMe(freelancer.organizationId, freelancer.id), tokens };
}

export async function refresh(refreshToken: string, meta: RequestMeta) {
  const session = await prisma.freelancerSession.findUnique({
    where: { refreshTokenHash: hashRefreshToken(refreshToken) },
    include: { freelancer: true },
  });
  if (!session || session.status !== 'ACTIVE') throw unauthenticated('Invalid freelancer refresh token');
  if (session.expiresAt <= new Date()) {
    await prisma.freelancerSession.update({ where: { id: session.id }, data: { status: 'EXPIRED', revokedAt: new Date() } });
    throw unauthenticated('Freelancer session has expired');
  }
  await prisma.freelancerSession.update({
    where: { id: session.id },
    data: { status: SessionStatus.LOGGED_OUT, revokedAt: new Date(), revokeReason: LogoutReason.TOKEN_REFRESH_ROTATION },
  });
  const tokens = await issueSession(session.freelancerId, session.freelancer.organizationId, meta);
  return { me: await getPortalMe(session.freelancer.organizationId, session.freelancerId), tokens };
}

export async function logout(sessionId: string): Promise<void> {
  await prisma.freelancerSession.updateMany({
    where: { id: sessionId, status: 'ACTIVE' },
    data: { status: 'LOGGED_OUT', revokedAt: new Date(), revokeReason: 'MANUAL_LOGOUT' },
  });
}

/** Resolves which studio a public freelancer application is for. */
export async function resolveJoinStudio(slug?: string) {
  if (slug) {
    const org = await prisma.organization.findFirst({ where: { slug: slug.toLowerCase(), deletedAt: null }, select: { id: true, name: true, slug: true } });
    if (!org) throw notFound('Studio');
    return org;
  }
  // A single-studio installation needs no link. With several studios an application must say which one it is for;
  // silently picking one would file a stranger's application under the wrong business.
  const orgs = await prisma.organization.findMany({ where: { deletedAt: null }, select: { id: true, name: true, slug: true }, take: 2 });
  if (orgs.length === 1) return orgs[0];
  throw badRequest('Open the freelancer join link your studio shared with you.');
}

export async function submitApplication(input: {
  studio?: string;
  fullName: string;
  phone: string;
  password: string;
  email?: string;
  city?: string;
  primarySkill?: Prisma.FreelancerApplicationCreateInput['primarySkill'];
  skills?: string[];
  experienceYears?: number;
  portfolioUrl?: string;
  expectedRate?: Prisma.Decimal.Value;
  notes?: string;
}) {
  const organization = await resolveJoinStudio(input.studio);
  const normalizedEmail = input.email?.toLowerCase();
  const existingFreelancer = await prisma.freelancer.findFirst({
    where: {
      organizationId: organization.id,
      deletedAt: null,
      OR: [{ phone: input.phone }, ...(normalizedEmail ? [{ email: normalizedEmail }] : [])],
    },
    select: { fullName: true, phone: true, email: true },
  });
  if (existingFreelancer) {
    const freelancerName = existingFreelancer.fullName ? ` for ${existingFreelancer.fullName}` : '';
    if (normalizedEmail && existingFreelancer.email?.toLowerCase() === normalizedEmail) {
      throw conflict(`This email is already used by an existing freelancer${freelancerName}.`);
    }
    if (existingFreelancer.phone === input.phone) {
      throw conflict(`This phone number is already used by an existing freelancer${freelancerName}.`);
    }
  }
  const duplicate = await prisma.freelancerApplication.findFirst({
    where: {
      organizationId: organization.id,
      status: { in: ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW'] },
      OR: [{ phone: input.phone }, ...(normalizedEmail ? [{ email: normalizedEmail }] : [])],
    },
    select: { id: true, freelancerId: true, fullName: true, phone: true, email: true },
  });
  if (duplicate) {
    if (!duplicate.freelancerId) {
      return prisma.$transaction(async (tx) => {
        const code = await nextDocumentNumber(tx, organization.id, 'FREELANCER');
        const primarySkill = input.primarySkill ?? 'LEAD_PHOTOGRAPHER';
        const skills = input.skills ?? [];
        const expectedRate = input.expectedRate === undefined ? undefined : money(input.expectedRate);
        const passwordHash = await hashPassword(input.password);
        const user = await tx.user.create({
          data: {
            organizationId: organization.id,
            fullName: input.fullName,
            email: portalUserEmail(normalizedEmail, input.phone),
            phone: input.phone,
            passwordHash,
            status: 'ACTIVE',
          },
        });
        const freelancer = await tx.freelancer.create({
          data: {
            organizationId: organization.id,
            userId: user.id,
            code,
            fullName: input.fullName,
            phone: input.phone,
            email: normalizedEmail,
            city: input.city,
            primarySkill,
            skills,
            experienceYears: input.experienceYears,
            rate: expectedRate,
            rateType: 'PER_DAY',
            notes: input.notes,
            passwordHash,
            status: 'ACTIVE',
          },
        });
        return tx.freelancerApplication.update({
          where: { id: duplicate.id },
          data: {
            freelancerId: freelancer.id,
            fullName: input.fullName,
            phone: input.phone,
            email: normalizedEmail,
            city: input.city,
            primarySkill,
            skills,
            experienceYears: input.experienceYears,
            portfolioUrl: input.portfolioUrl,
            expectedRate,
            notes: input.notes,
          },
        });
      });
    }
    const applicantName = duplicate.fullName ? ` for ${duplicate.fullName}` : '';
    if (normalizedEmail && duplicate.email?.toLowerCase() === normalizedEmail) {
      throw conflict(`This email is already used in an active freelancer application${applicantName}.`);
    }
    if (duplicate.phone === input.phone) {
      throw conflict(`This phone number is already used in an active freelancer application${applicantName}.`);
    }
    throw conflict(`An active freelancer application already exists${applicantName}.`);
  }
  return prisma.$transaction(async (tx) => {
    const code = await nextDocumentNumber(tx, organization.id, 'FREELANCER');
    const primarySkill = input.primarySkill ?? 'LEAD_PHOTOGRAPHER';
    const skills = input.skills ?? [];
    const expectedRate = input.expectedRate === undefined ? undefined : money(input.expectedRate);
    const passwordHash = await hashPassword(input.password);
    const user = await tx.user.create({
      data: {
        organizationId: organization.id,
        fullName: input.fullName,
        email: portalUserEmail(normalizedEmail, input.phone),
        phone: input.phone,
        passwordHash,
        status: 'ACTIVE',
      },
    });
    const freelancer = await tx.freelancer.create({
      data: {
        organizationId: organization.id,
        userId: user.id,
        code,
        fullName: input.fullName,
        phone: input.phone,
        email: normalizedEmail,
        city: input.city,
        primarySkill,
        skills,
        experienceYears: input.experienceYears,
        rate: expectedRate,
        rateType: 'PER_DAY',
        notes: input.notes,
        passwordHash,
        status: 'ACTIVE',
      },
    });
    return tx.freelancerApplication.create({
      data: {
        organizationId: organization.id,
        freelancerId: freelancer.id,
        fullName: input.fullName,
        phone: input.phone,
        email: normalizedEmail,
        city: input.city,
        primarySkill,
        skills,
        experienceYears: input.experienceYears,
        portfolioUrl: input.portfolioUrl,
        expectedRate,
        notes: input.notes,
        status: 'SUBMITTED',
      },
    });
  });
}

export async function updateProfile(organizationId: string, freelancerId: string, input: Prisma.FreelancerUpdateInput) {
  await prisma.freelancer.update({
    where: { id: freelancerId, organizationId, deletedAt: null },
    data: input,
  });
  return (await getPortalMe(organizationId, freelancerId)).freelancer;
}

export async function setPassword(organizationId: string, freelancerId: string, password: string, ctx: AuditRequestContext) {
  const freelancer = await prisma.freelancer.findFirst({ where: { id: freelancerId, organizationId, deletedAt: null } });
  if (!freelancer) throw notFound('Freelancer');
  await prisma.freelancer.update({ where: { id: freelancerId }, data: { passwordHash: await hashPassword(password) } });
  await recordAudit(prisma, ctx, { action: 'UPDATE', entityType: 'Freelancer', entityId: freelancerId, summary: 'Freelancer portal password set' });
}

export async function listAvailability(organizationId: string, freelancerId: string, query: {
  page?: number;
  limit?: number;
  from?: string;
  to?: string;
  status?: 'AVAILABLE' | 'PARTIALLY_AVAILABLE' | 'UNAVAILABLE';
}) {
  const pagination = resolvePagination(query);
  const date = dateRangeFilter(query.from, query.to);
  const where: Prisma.FreelancerAvailabilityWhereInput = {
    freelancerId,
    freelancer: { organizationId, deletedAt: null },
    ...(query.status ? { status: query.status } : {}),
    ...(date ? { date } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.freelancerAvailability.findMany({
      where,
      orderBy: { date: 'asc' },
      skip: pagination.skip,
      take: pagination.take,
    }),
    prisma.freelancerAvailability.count({ where }),
  ]);
  return {
    items,
    meta: {
      page: pagination.page,
      limit: pagination.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
    },
  };
}

export async function upsertAvailability(organizationId: string, freelancerId: string, input: {
  date: string;
  status: 'AVAILABLE' | 'PARTIALLY_AVAILABLE' | 'UNAVAILABLE';
  startTime?: Date | null;
  endTime?: Date | null;
  notes?: string | null;
}) {
  if (input.startTime && input.endTime && input.endTime < input.startTime) {
    throw badRequest('endTime cannot be before startTime');
  }
  const freelancer = await prisma.freelancer.findFirst({
    where: { id: freelancerId, organizationId, deletedAt: null },
    select: { id: true },
  });
  if (!freelancer) throw notFound('Freelancer');
  const date = toDateOnly(input.date);
  return prisma.freelancerAvailability.upsert({
    where: { freelancerId_date: { freelancerId, date } },
    create: { freelancerId, date, status: input.status, startTime: input.startTime, endTime: input.endTime, notes: input.notes },
    update: { status: input.status, startTime: input.startTime, endTime: input.endTime, notes: input.notes },
  });
}

export async function updateAvailability(organizationId: string, freelancerId: string, dateInput: string, input: {
  status?: 'AVAILABLE' | 'PARTIALLY_AVAILABLE' | 'UNAVAILABLE';
  startTime?: Date | null;
  endTime?: Date | null;
  notes?: string | null;
}) {
  if (input.startTime && input.endTime && input.endTime < input.startTime) {
    throw badRequest('endTime cannot be before startTime');
  }
  const date = toDateOnly(dateInput);
  const existing = await prisma.freelancerAvailability.findFirst({
    where: { freelancerId, date, freelancer: { organizationId, deletedAt: null } },
    select: { id: true },
  });
  if (!existing) throw notFound('Freelancer availability');
  return prisma.freelancerAvailability.update({
    where: { id: existing.id },
    data: input,
  });
}

export async function deleteAvailability(organizationId: string, freelancerId: string, dateInput: string) {
  const date = toDateOnly(dateInput);
  const existing = await prisma.freelancerAvailability.findFirst({
    where: { freelancerId, date, freelancer: { organizationId, deletedAt: null } },
    select: { id: true },
  });
  if (!existing) throw notFound('Freelancer availability');
  await prisma.freelancerAvailability.delete({ where: { id: existing.id } });
}

export async function respondToConnection(
  organizationId: string,
  freelancerId: string,
  connectionId: string,
  input: { status: 'ACCEPTED' | 'DECLINED'; notes?: string | null },
  ctx: AuditRequestContext,
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.freelancerConnection.findFirst({
      where: { id: connectionId, organizationId, freelancerId },
      include: {
        project: { select: { id: true, projectNumber: true, name: true } },
        shoot: { select: { id: true, title: true, shootDate: true } },
      },
    });
    if (!existing) throw notFound('Freelancer connection');
    if (!['INTERESTED', 'CONTACTED', 'ACCEPTED'].includes(existing.status)) {
      throw conflict(`Cannot respond to a ${existing.status} connection`);
    }
    const updated = await tx.freelancerConnection.update({
      where: { id: connectionId },
      data: {
        status: input.status,
        notes: input.notes === undefined ? existing.notes : input.notes,
      },
      include: {
        project: { select: { id: true, projectNumber: true, name: true } },
        shoot: { select: { id: true, title: true, shootDate: true } },
        createdBy: { select: { id: true, fullName: true } },
      },
    });
    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'FreelancerConnection',
      entityId: connectionId,
      summary: `Freelancer ${input.status.toLowerCase()} connection`,
      oldData: existing,
      newData: updated,
    });
    return updated;
  });
}

export async function createPortfolioItem(organizationId: string, freelancerId: string, input: {
  fileObjectId: string;
  title: string;
  description?: string;
  category?: string;
  sortOrder?: number;
  isPublished?: boolean;
}) {
  const file = await prisma.fileObject.findFirst({
    where: {
      id: input.fileObjectId,
      organizationId,
      deletedAt: null,
      entityType: { in: [...PORTAL_PORTFOLIO_FILE_TYPES] },
      OR: [{ entityId: null }, { entityId: freelancerId }],
    },
    select: { id: true },
  });
  if (!file) throw notFound('File');
  return prisma.freelancerPortfolioItem.create({ data: { freelancerId, ...input } });
}

const PORTFOLIO_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4']);
const PORTFOLIO_MAX_BYTES = 25 * 1024 * 1024;
const PORTFOLIO_ENTITY = 'FREELANCER_PORTFOLIO';
const PORTFOLIO_MAX_ITEMS = 60;

/** Step 1 of uploading a work sample: a signed upload URL. The freelancer never needs to know about file ids. */
export async function createPortfolioUploadIntent(organizationId: string, freelancerId: string, input: { originalName: string; mimeType: string }) {
  if (!PORTFOLIO_MIME.has(input.mimeType)) throw badRequest('Upload a JPG, PNG, WEBP image or an MP4 film.');
  const objectKey = buildObjectKey(organizationId, PORTFOLIO_ENTITY, input.originalName);
  const bucket = env.STORAGE_BUCKET;
  const signed = createUploadUrl(objectKey, bucket);
  if (getStorageProvider() === 'DATABASE') {
    await prisma.fileObject.create({
      data: { organizationId, entityType: PORTFOLIO_ENTITY, entityId: freelancerId, storageProvider: 'DATABASE', bucket, objectKey, originalName: input.originalName, mimeType: input.mimeType, sizeBytes: BigInt(0), isRegistered: false },
    });
  }
  return { bucket, objectKey, provider: getStorageProvider(), uploadUrl: signed.url, expiresAt: signed.expiresAt, requiredHeaders: { 'content-type': input.mimeType } };
}

/** Step 2: record the uploaded file and add it to the portfolio in one go. */
export async function addPortfolioUpload(organizationId: string, freelancerId: string, input: {
  bucket: string; objectKey: string; originalName: string; mimeType: string; sizeBytes: number;
  title: string; description?: string; category?: string; isPublished?: boolean;
}) {
  if (!PORTFOLIO_MIME.has(input.mimeType)) throw badRequest('Upload a JPG, PNG, WEBP image or an MP4 film.');
  if (input.sizeBytes <= 0 || input.sizeBytes > PORTFOLIO_MAX_BYTES) throw badRequest('Each portfolio file must be under 25 MB.');
  // The key must be one this studio handed out for portfolios, so nobody can attach an arbitrary stored file.
  if (!input.objectKey.startsWith(`${organizationId}/${PORTFOLIO_ENTITY.toLowerCase()}/`)) throw badRequest('That upload does not belong to your portfolio.');
  if ((await prisma.freelancerPortfolioItem.count({ where: { freelancerId } })) >= PORTFOLIO_MAX_ITEMS) throw conflict(`Your portfolio is full (${PORTFOLIO_MAX_ITEMS} items). Remove one to add another.`);

  let file;
  if (getStorageProvider() === 'DATABASE') {
    const pending = await prisma.fileObject.findFirst({ where: { organizationId, bucket: input.bucket, objectKey: input.objectKey, storageProvider: 'DATABASE', isRegistered: false, entityType: PORTFOLIO_ENTITY, entityId: freelancerId, deletedAt: null }, select: { id: true, content: true } });
    if (!pending?.content) throw badRequest('The file upload has not completed.');
    if (pending.content.byteLength !== input.sizeBytes) throw badRequest('The registered file size does not match the uploaded content.');
    file = await prisma.fileObject.update({ where: { id: pending.id }, data: { originalName: input.originalName, mimeType: input.mimeType, sizeBytes: BigInt(input.sizeBytes), isRegistered: true } });
  } else {
    file = await prisma.fileObject.create({
      data: { organizationId, entityType: PORTFOLIO_ENTITY, entityId: freelancerId, storageProvider: getStorageProvider(), bucket: input.bucket, objectKey: input.objectKey, originalName: input.originalName, mimeType: input.mimeType, sizeBytes: BigInt(input.sizeBytes) },
    });
  }
  const item = await prisma.freelancerPortfolioItem.create({
    data: { freelancerId, fileObjectId: file.id, title: input.title, description: input.description, category: input.category, isPublished: input.isPublished ?? true },
    include: { fileObject: true },
  });
  return { ...item, fileObject: safeFileObject(item.fileObject) };
}

export async function updatePortfolioItem(organizationId: string, freelancerId: string, itemId: string, input: Prisma.FreelancerPortfolioItemUpdateInput) {
  const existing = await prisma.freelancerPortfolioItem.findFirst({ where: { id: itemId, freelancerId, freelancer: { organizationId } } });
  if (!existing) throw notFound('Freelancer portfolio item');
  return prisma.freelancerPortfolioItem.update({ where: { id: itemId }, data: input });
}

export async function deletePortfolioItem(organizationId: string, freelancerId: string, itemId: string) {
  const existing = await prisma.freelancerPortfolioItem.findFirst({ where: { id: itemId, freelancerId, freelancer: { organizationId } } });
  if (!existing) throw notFound('Freelancer portfolio item');
  await prisma.freelancerPortfolioItem.delete({ where: { id: itemId } });
}

export async function listPlans(organizationId: string) {
  await ensureDefaultPlans(organizationId);
  return prisma.freelancerPlan.findMany({ where: { organizationId, isActive: true }, orderBy: { price: 'asc' } });
}

const projectSummarySelect = {
  id: true,
  projectNumber: true,
  name: true,
  type: true,
  status: true,
  weddingDate: true,
  venueName: true,
  venueCity: true,
  createdAt: true,
} satisfies Prisma.ProjectSelect;

const shootSummarySelect = {
  id: true,
  title: true,
  shootType: true,
  shootDate: true,
  startTime: true,
  endTime: true,
  location: true,
  city: true,
  status: true,
  project: { select: projectSummarySelect },
  assignments: {
    select: {
      id: true,
      freelancerId: true,
      userId: true,
      role: true,
      status: true,
      callTime: true,
      assignedAt: true,
      user: { select: { id: true, fullName: true, employeeCode: true } },
      freelancer: { select: { id: true, fullName: true, code: true, primarySkill: true } },
    },
  },
} satisfies Prisma.ShootSelect;

const taskSummarySelect = {
  id: true,
  title: true,
  description: true,
  category: true,
  status: true,
  priority: true,
  dueDate: true,
  startedAt: true,
  completedAt: true,
  project: { select: projectSummarySelect },
  shoot: { select: { id: true, title: true, shootDate: true, startTime: true, endTime: true, location: true, city: true, status: true } },
} satisfies Prisma.TaskSelect;

const payoutSummarySelect = {
  id: true,
  amount: true,
  paymentDate: true,
  paymentMethod: true,
  transactionRef: true,
  createdAt: true,
  assignment: {
    select: {
      id: true,
      role: true,
      status: true,
      shoot: { select: { id: true, title: true, shootDate: true, project: { select: projectSummarySelect } } },
    },
  },
} satisfies Prisma.FreelancerPayoutSelect;

function assignmentWhere(organizationId: string, freelancerId: string): Prisma.ShootAssignmentWhereInput {
  return {
    freelancerId,
    shoot: { organizationId, deletedAt: null, project: { organizationId, deletedAt: null } },
  };
}

function projectAccessWhere(organizationId: string, freelancerId: string): Prisma.ProjectWhereInput {
  return {
    organizationId,
    deletedAt: null,
    OR: [
      { shoots: { some: { deletedAt: null, assignments: { some: { freelancerId } } } } },
      { freelancerConnections: { some: { freelancerId, status: { in: ACTIVE_CONNECTION_STATUSES } } } },
    ],
  };
}

function taskAccessWhere(organizationId: string, freelancerId: string): Prisma.TaskWhereInput {
  return {
    organizationId,
    deletedAt: null,
    OR: [
      { shoot: { deletedAt: null, assignments: { some: { freelancerId } } } },
      { project: projectAccessWhere(organizationId, freelancerId) },
    ],
  };
}

function todayBounds() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function cleanCrew(assignments: Prisma.ShootGetPayload<{ select: typeof shootSummarySelect }>['assignments'], freelancerId: string) {
  return assignments.map((assignment) => ({
    id: assignment.id,
    role: assignment.role,
    status: assignment.status,
    isSelf: assignment.freelancerId === freelancerId,
    displayName: assignment.freelancerId === freelancerId
      ? assignment.freelancer?.fullName
      : assignment.user?.fullName ?? assignment.freelancer?.fullName ?? 'Crew member',
  }));
}

function toShootSummary(shoot: Prisma.ShootGetPayload<{ select: typeof shootSummarySelect }>, freelancerId: string) {
  const ownAssignment = shoot.assignments.find((assignment) => assignment.freelancerId === freelancerId);
  return {
    id: shoot.id,
    title: shoot.title,
    shootType: shoot.shootType,
    shootDate: shoot.shootDate,
    startTime: shoot.startTime,
    endTime: shoot.endTime,
    location: shoot.location,
    city: shoot.city,
    status: shoot.status,
    project: shoot.project,
    assignment: ownAssignment && {
      id: ownAssignment.id,
      role: ownAssignment.role,
      status: ownAssignment.status,
      callTime: ownAssignment.callTime,
      assignedAt: ownAssignment.assignedAt,
    },
    crew: cleanCrew(shoot.assignments, freelancerId),
  };
}

function toTaskSummary(task: Prisma.TaskGetPayload<{ select: typeof taskSummarySelect }>) {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    category: task.category,
    status: task.status,
    priority: task.priority,
    dueDate: task.dueDate,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    project: task.project,
    shoot: task.shoot,
  };
}

function toPayoutSummary(payout: Prisma.FreelancerPayoutGetPayload<{ select: typeof payoutSummarySelect }>) {
  return {
    id: payout.id,
    amount: payout.amount,
    paymentDate: payout.paymentDate,
    paymentMethod: payout.paymentMethod,
    transactionRef: payout.transactionRef,
    createdAt: payout.createdAt,
    assignment: payout.assignment,
  };
}

function paginationMeta(total: number, page: number, limit: number) {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}

export async function getDashboard(organizationId: string, freelancerId: string) {
  const now = new Date();
  const { start, end } = todayBounds();
  const [me, upcomingShoots, todayShoots, tasks, payouts, notifications] = await Promise.all([
    getPortalMe(organizationId, freelancerId),
    prisma.shoot.findMany({
      where: { assignments: { some: assignmentWhere(organizationId, freelancerId) }, shootDate: { gte: now }, deletedAt: null },
      select: shootSummarySelect,
      orderBy: [{ shootDate: 'asc' }, { startTime: 'asc' }],
      take: 5,
    }),
    prisma.shoot.findMany({
      where: { assignments: { some: assignmentWhere(organizationId, freelancerId) }, shootDate: { gte: start, lt: end }, deletedAt: null },
      select: shootSummarySelect,
      orderBy: [{ startTime: 'asc' }],
      take: 5,
    }),
    prisma.task.findMany({
      where: { ...taskAccessWhere(organizationId, freelancerId), status: { in: OPEN_TASK_STATUSES } },
      select: taskSummarySelect,
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
      take: 5,
    }),
    prisma.freelancerPayout.findMany({
      where: { organizationId, freelancerId },
      select: payoutSummarySelect,
      orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }],
      take: 5,
    }),
    prisma.notification.findMany({
      where: { organizationId, userId: freelancerId },
      select: { id: true, type: true, title: true, message: true, entityType: true, entityId: true, isRead: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
  ]);
  const paidAmount = payouts.reduce((sum, payout) => sum + Number(payout.amount), 0);
  return {
    profile: { freelancer: me.freelancer, searchable: me.searchable },
    subscription: me.freelancer.subscriptions[0] ?? null,
    upcomingShoots: upcomingShoots.map((shoot) => toShootSummary(shoot, freelancerId)),
    todaysWork: {
      shoots: todayShoots.map((shoot) => toShootSummary(shoot, freelancerId)),
      tasks: tasks.filter((task) => task.dueDate && task.dueDate >= start && task.dueDate < end).map(toTaskSummary),
    },
    tasks: tasks.map(toTaskSummary),
    payments: { recent: payouts.map(toPayoutSummary), summary: { paidAmount, currency: me.freelancer.subscriptions[0]?.plan.currency ?? 'INR' } },
    notifications,
  };
}

export async function listProjects(organizationId: string, freelancerId: string, query: { page?: number; limit?: number; search?: string; status?: string }) {
  const { page, limit, skip, take } = resolvePagination(query);
  const where: Prisma.ProjectWhereInput = {
    ...projectAccessWhere(organizationId, freelancerId),
    ...(query.status ? { status: query.status as never } : {}),
    ...(query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.project.count({ where }),
    prisma.project.findMany({
      where,
      select: {
        ...projectSummarySelect,
        shoots: {
          where: { deletedAt: null, assignments: { some: { freelancerId } } },
          select: { id: true, title: true, shootDate: true, status: true },
          orderBy: { shootDate: 'asc' },
          take: 3,
        },
      },
      orderBy: [{ weddingDate: 'desc' }, { createdAt: 'desc' }],
      skip,
      take,
    }),
  ]);
  return { items: rows, meta: paginationMeta(total, page, limit) };
}

export async function getProject(organizationId: string, freelancerId: string, projectId: string) {
  const project = await prisma.project.findFirst({
    where: { ...projectAccessWhere(organizationId, freelancerId), id: projectId },
    select: {
      ...projectSummarySelect,
      venueAddress: true,
      shoots: {
        where: { deletedAt: null, assignments: { some: { freelancerId } } },
        select: shootSummarySelect,
        orderBy: { shootDate: 'asc' },
      },
      tasks: {
        where: taskAccessWhere(organizationId, freelancerId),
        select: taskSummarySelect,
        orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
        take: 20,
      },
    },
  });
  if (!project) throw notFound('Project');
  return { ...project, shoots: project.shoots.map((shoot) => toShootSummary(shoot, freelancerId)), tasks: project.tasks.map(toTaskSummary) };
}

export async function listShoots(organizationId: string, freelancerId: string, query: { page?: number; limit?: number; view?: string; search?: string; from?: string; to?: string }) {
  const { page, limit, skip, take } = resolvePagination(query);
  const { start, end } = todayBounds();
  const now = new Date();
  const date = dateRangeFilter(query.from, query.to);
  const where: Prisma.ShootWhereInput = {
    assignments: { some: assignmentWhere(organizationId, freelancerId) },
    deletedAt: null,
    ...(query.search ? { title: { contains: query.search, mode: 'insensitive' } } : {}),
    ...(date ? { shootDate: date } : {}),
    ...(!date && query.view === 'today' ? { shootDate: { gte: start, lt: end } } : {}),
    ...(!date && query.view === 'completed' ? { OR: [{ status: 'COMPLETED' }, { shootDate: { lt: start } }] } : {}),
    ...(!date && (!query.view || query.view === 'upcoming') ? { shootDate: { gte: now } } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.shoot.count({ where }),
    prisma.shoot.findMany({ where, select: shootSummarySelect, orderBy: [{ shootDate: 'asc' }, { startTime: 'asc' }], skip, take }),
  ]);
  return { items: rows.map((shoot) => toShootSummary(shoot, freelancerId)), meta: paginationMeta(total, page, limit) };
}

export async function getShoot(organizationId: string, freelancerId: string, shootId: string) {
  const shoot = await prisma.shoot.findFirst({
    where: { id: shootId, assignments: { some: assignmentWhere(organizationId, freelancerId) }, deletedAt: null },
    select: {
      ...shootSummarySelect,
      notes: true,
      event: { select: { id: true, name: true, eventDate: true, venueName: true, city: true, status: true } },
      tasks: {
        where: taskAccessWhere(organizationId, freelancerId),
        select: taskSummarySelect,
        orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
        take: 20,
      },
    },
  });
  if (!shoot) throw notFound('Shoot');
  return { ...toShootSummary(shoot, freelancerId), notes: shoot.notes, event: shoot.event, tasks: shoot.tasks.map(toTaskSummary) };
}

export async function listTasks(organizationId: string, freelancerId: string, query: { page?: number; limit?: number; status?: TaskStatus; search?: string }) {
  const { page, limit, skip, take } = resolvePagination(query);
  const where: Prisma.TaskWhereInput = {
    ...taskAccessWhere(organizationId, freelancerId),
    ...(query.status ? { status: query.status } : {}),
    ...(query.search ? { title: { contains: query.search, mode: 'insensitive' } } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.task.count({ where }),
    prisma.task.findMany({ where, select: taskSummarySelect, orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }], skip, take }),
  ]);
  return { items: rows.map(toTaskSummary), meta: paginationMeta(total, page, limit) };
}

export async function updateTaskStatus(organizationId: string, freelancerId: string, taskId: string, status: TaskStatus, ctx: AuditRequestContext) {
  const existing = await prisma.task.findFirst({ where: { ...taskAccessWhere(organizationId, freelancerId), id: taskId }, select: { id: true, status: true } });
  if (!existing) throw notFound('Task');
  const updated = await prisma.$transaction(async (tx) => {
    const task = await tx.task.update({
      where: { id: taskId },
      data: {
        status,
        startedAt: status === 'IN_PROGRESS' ? new Date() : undefined,
        completedAt: status === 'COMPLETED' ? new Date() : undefined,
        statusHistory: { create: { oldStatus: existing.status, newStatus: status, reason: 'Updated from freelancer portal' } },
      },
      select: taskSummarySelect,
    });
    await recordAudit(tx, ctx, { action: 'UPDATE', entityType: 'Task', entityId: taskId, summary: 'Freelancer updated task status' });
    return task;
  });
  return toTaskSummary(updated);
}

export async function listPayments(organizationId: string, freelancerId: string, query: { page?: number; limit?: number }) {
  const { page, limit, skip, take } = resolvePagination(query);
  const where: Prisma.FreelancerPayoutWhereInput = { organizationId, freelancerId };
  const [total, rows] = await Promise.all([
    prisma.freelancerPayout.count({ where }),
    prisma.freelancerPayout.findMany({ where, select: payoutSummarySelect, orderBy: [{ paymentDate: 'desc' }, { createdAt: 'desc' }], skip, take }),
  ]);
  return { items: rows.map(toPayoutSummary), meta: paginationMeta(total, page, limit) };
}

export async function listNotifications(organizationId: string, freelancerId: string, query: { page?: number; limit?: number; unreadOnly?: boolean }) {
  const { page, limit, skip, take } = resolvePagination(query);
  const where: Prisma.NotificationWhereInput = { organizationId, userId: freelancerId, ...(query.unreadOnly ? { isRead: false } : {}) };
  const [total, rows] = await Promise.all([
    prisma.notification.count({ where }),
    prisma.notification.findMany({
      where,
      select: { id: true, type: true, channel: true, title: true, message: true, entityType: true, entityId: true, isRead: true, readAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    }),
  ]);
  return { items: rows, meta: paginationMeta(total, page, limit) };
}
