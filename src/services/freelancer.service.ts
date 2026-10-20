import {
  BillingInterval,
  CrewRole,
  FreelancerApplicationStatus,
  FreelancerAvailabilityStatus,
  FreelancerConnectionStatus,
  FreelancerStatus,
  FreelancerSubscriptionStatus,
  PaymentMethod,
  Prisma,
  RateType,
} from '@prisma/client';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { andWhere, findScoped, paginate, searchFilter } from '../repositories/base.repository';
import { resolveSort } from '../utils/pagination';
import { nextDocumentNumber } from '../utils/documentNumber';
import { badRequest, conflict, notFound } from '../utils/errors';
import { toDateOnly } from '../utils/date';
import { money, round2, ZERO } from '../utils/money';
import { AuthContext } from '../types';
import { AuditRequestContext, recordAudit } from './audit.service';
import { createOnboardingInvitation } from './freelancerOnboarding.service';

const SORTABLE = ['createdAt', 'fullName', 'rate', 'rating'] as const;
const PLAN_SORTABLE = ['createdAt', 'name', 'price'] as const;
const APPLICATION_SORTABLE = ['submittedAt', 'createdAt', 'fullName'] as const;
const CONNECTION_SORTABLE = ['createdAt', 'updatedAt'] as const;
const ACTIVE_APPLICATION_STATUSES: FreelancerApplicationStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
];
const ACTIVE_CONNECTION_STATUSES: FreelancerConnectionStatus[] = ['INTERESTED', 'CONTACTED', 'ACCEPTED', 'ASSIGNED'];
const CONNECTION_TRANSITIONS: Record<FreelancerConnectionStatus, FreelancerConnectionStatus[]> = {
  INTERESTED: ['CONTACTED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'ASSIGNED'],
  CONTACTED: ['ACCEPTED', 'DECLINED', 'EXPIRED', 'ASSIGNED'],
  ACCEPTED: ['ASSIGNED', 'DECLINED', 'EXPIRED'],
  DECLINED: [],
  EXPIRED: [],
  ASSIGNED: [],
};
const SUBSCRIPTION_TRANSITIONS: Record<
  FreelancerSubscriptionStatus,
  FreelancerSubscriptionStatus[]
> = {
  PENDING: ['ACTIVE', 'CANCELED', 'EXPIRED'],
  ACTIVE: ['PAST_DUE', 'CANCELED', 'EXPIRED'],
  PAST_DUE: ['ACTIVE', 'CANCELED', 'EXPIRED'],
  CANCELED: [],
  EXPIRED: [],
};

export function listFreelancers(
  organizationId: string,
  query: {
    page?: number;
    limit?: number;
    search?: string;
    status?: FreelancerStatus;
    primarySkill?: CrewRole;
    city?: string;
    sortBy?: string;
    sortOrder?: string;
  },
) {
  const sort = resolveSort(query.sortBy, query.sortOrder, SORTABLE, 'createdAt');
  return paginate(prisma.freelancer, {
    where: andWhere(
      { organizationId, deletedAt: null },
      query.status ? { status: query.status } : undefined,
      query.primarySkill ? { primarySkill: query.primarySkill } : undefined,
      query.city ? { city: { equals: query.city, mode: 'insensitive' } } : undefined,
      searchFilter(query.search, ['fullName', 'phone', 'email', 'code', 'city']),
    ),
    orderBy: { [sort.field]: sort.direction },
    page: query.page,
    limit: query.limit,
    include: { _count: { select: { assignments: true } } },
  });
}

export function getFreelancer(organizationId: string, id: string) {
  return findScoped(prisma.freelancer, organizationId, id, 'Freelancer', {
    include: {
      assignments: {
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: {
          shoot: {
            select: {
              id: true,
              title: true,
              shootDate: true,
              status: true,
              project: { select: { id: true, projectNumber: true, name: true } },
            },
          },
        },
      },
      payouts: { orderBy: { paymentDate: 'desc' }, take: 50 },
    },
  });
}

export interface CreateFreelancerInput {
  fullName: string;
  phone: string;
  whatsapp?: string;
  email?: string;
  city?: string;
  addressLine?: string;
  primarySkill?: CrewRole;
  skills?: string[];
  experienceYears?: number;
  rate?: Prisma.Decimal.Value;
  rateType?: RateType;
  travelAvailable?: boolean;
  maxShootsPerDay?: number;
  equipmentNotes?: string;
  paymentMethod?: PaymentMethod;
  upiId?: string;
  bankName?: string;
  accountHolder?: string;
  accountNumber?: string;
  ifsc?: string;
  panNumber?: string;
  gstNumber?: string;
  notes?: string;
}

export async function createFreelancer(
  auth: AuthContext,
  input: CreateFreelancerInput,
  ctx: AuditRequestContext,
) {
  return prisma.$transaction(async (tx) => {
    const code = await nextDocumentNumber(tx, auth.organizationId, 'FREELANCER');
    const freelancer = await tx.freelancer.create({
      data: {
        organizationId: auth.organizationId,
        code,
        ...input,
        email: input.email?.toLowerCase(),
        skills: input.skills ?? [],
      },
    });
    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'Freelancer',
      entityId: freelancer.id,
      summary: `Freelancer ${code} added`,
      newData: freelancer,
    });
    return freelancer;
  });
}

export async function updateFreelancer(
  auth: AuthContext,
  id: string,
  input: Partial<CreateFreelancerInput> & { status?: FreelancerStatus },
  ctx: AuditRequestContext,
) {
  return prisma.$transaction(async (tx) => {
    const existing = await findScoped<Record<string, unknown>>(
      tx.freelancer,
      auth.organizationId,
      id,
      'Freelancer',
    );
    const updated = await tx.freelancer.update({
      where: { id },
      data: { ...input, email: input.email?.toLowerCase() },
    });
    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'Freelancer',
      entityId: id,
      summary: 'Freelancer updated',
      oldData: existing,
      newData: updated,
    });
    return updated;
  });
}

export async function deleteFreelancer(auth: AuthContext, id: string, ctx: AuditRequestContext) {
  return prisma.$transaction(async (tx) => {
    const freelancer = await findScoped<{ id: string; code: string }>(
      tx.freelancer,
      auth.organizationId,
      id,
      'Freelancer',
    );
    const upcoming = await tx.shootAssignment.count({
      where: {
        freelancerId: id,
        status: { notIn: ['COMPLETED', 'CANCELLED', 'DECLINED'] },
        shoot: { deletedAt: null, shootDate: { gte: new Date() } },
      },
    });
    if (upcoming > 0) {
      throw conflict(`This freelancer has ${upcoming} upcoming assignment(s). Reassign them first.`);
    }
    await tx.freelancer.update({
      where: { id },
      data: { deletedAt: new Date(), deletedBy: auth.userId, status: 'INACTIVE' },
    });
    await recordAudit(tx, ctx, {
      action: 'SOFT_DELETE',
      entityType: 'Freelancer',
      entityId: id,
      summary: `Freelancer ${freelancer.code} archived`,
      oldData: freelancer,
    });
  });
}

/**
 * Records a freelancer settlement.
 *
 * The payout and its backing Expense are written in one transaction and linked
 * 1:1, so `expenses` remains the single cost ledger and project profitability
 * counts crew cost exactly once (§14, §20). The expense is created already
 * APPROVED — the payout itself is the approval event.
 */
export async function recordPayout(
  auth: AuthContext,
  freelancerId: string,
  input: {
    amount: Prisma.Decimal.Value;
    paymentDate: string;
    assignmentId?: string;
    paymentMethod?: PaymentMethod;
    transactionRef?: string;
    notes?: string;
    categoryId: string;
  },
  ctx: AuditRequestContext,
) {
  const amount = round2(money(input.amount));
  if (amount.lessThanOrEqualTo(ZERO())) throw badRequest('Payout amount must be greater than zero');

  return prisma.$transaction(async (tx) => {
    const freelancer = await findScoped<{ id: string; code: string; fullName: string }>(
      tx.freelancer,
      auth.organizationId,
      freelancerId,
      'Freelancer',
    );

    const category = await tx.expenseCategory.findFirst({
      where: { id: input.categoryId, organizationId: auth.organizationId },
      select: { id: true },
    });
    if (!category) throw notFound('Expense category');

    let projectId: string | undefined;
    let shootId: string | undefined;

    if (input.assignmentId) {
      const assignment = await tx.shootAssignment.findFirst({
        where: {
          id: input.assignmentId,
          freelancerId,
          shoot: { organizationId: auth.organizationId },
        },
        include: { shoot: { select: { id: true, projectId: true } } },
      });
      if (!assignment) throw notFound('Shoot assignment');
      projectId = assignment.shoot.projectId;
      shootId = assignment.shoot.id;
    }

    const expense = await tx.expense.create({
      data: {
        organizationId: auth.organizationId,
        branchId: auth.branchId,
        projectId,
        shootId,
        freelancerId,
        categoryId: input.categoryId,
        amount,
        expenseDate: toDateOnly(input.paymentDate),
        vendor: freelancer.fullName,
        paymentMethod: input.paymentMethod ?? 'BANK_TRANSFER',
        description: `Freelancer payout — ${freelancer.code}${input.notes ? `: ${input.notes}` : ''}`,
        approvalStatus: 'APPROVED',
        createdById: auth.userId,
        approvedById: auth.userId,
        approvedAt: new Date(),
      },
    });

    const payout = await tx.freelancerPayout.create({
      data: {
        organizationId: auth.organizationId,
        freelancerId,
        assignmentId: input.assignmentId,
        expenseId: expense.id,
        amount,
        paymentDate: toDateOnly(input.paymentDate),
        paymentMethod: input.paymentMethod ?? 'BANK_TRANSFER',
        transactionRef: input.transactionRef,
        notes: input.notes,
        paidById: auth.userId,
      },
    });

    await recordAudit(tx, ctx, {
      action: 'PAYMENT_RECORDED',
      entityType: 'FreelancerPayout',
      entityId: payout.id,
      summary: `Payout of ${amount.toString()} to ${freelancer.code}`,
      newData: { payout, expenseId: expense.id },
    });

    return { payout, expense };
  });
}

/** Outstanding balance per assignment: agreed cost minus what has been paid. */
export async function getFreelancerLedger(organizationId: string, freelancerId: string) {
  const assignments = await prisma.shootAssignment.findMany({
    where: { freelancerId, shoot: { organizationId, deletedAt: null } },
    include: {
      shoot: { select: { id: true, title: true, shootDate: true, projectId: true } },
      payouts: { select: { amount: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  return assignments.map((assignment) => {
    const committed = round2(
      money(assignment.agreedAmount)
        .plus(assignment.travelAmount)
        .plus(assignment.extraAmount),
    );
    const paid = round2(
      assignment.payouts.reduce((acc, p) => acc.plus(p.amount), money(0)),
    );
    return {
      assignmentId: assignment.id,
      shoot: assignment.shoot,
      role: assignment.role,
      status: assignment.status,
      committed: committed.toString(),
      paid: paid.toString(),
      outstanding: round2(committed.minus(paid)).toString(),
    };
  });
}

export function listFreelancerPlans(
  organizationId: string,
  query: {
    page?: number;
    limit?: number;
    search?: string;
    active?: boolean;
    sortBy?: string;
    sortOrder?: string;
  },
) {
  const sort = resolveSort(query.sortBy, query.sortOrder, PLAN_SORTABLE, 'createdAt');
  return paginate(prisma.freelancerPlan, {
    where: andWhere(
      { organizationId },
      typeof query.active === 'boolean' ? { isActive: query.active } : undefined,
      searchFilter(query.search, ['name', 'slug', 'description']),
    ),
    orderBy: { [sort.field]: sort.direction },
    page: query.page,
    limit: query.limit,
  });
}

export async function createFreelancerPlan(
  auth: AuthContext,
  input: {
    name: string;
    slug: string;
    description?: string;
    price: Prisma.Decimal.Value;
    currency?: string;
    billingInterval?: BillingInterval;
    features?: Prisma.InputJsonValue;
    limits?: Prisma.InputJsonValue;
    isActive?: boolean;
  },
  ctx: AuditRequestContext,
) {
  const plan = await prisma.freelancerPlan.create({
    data: {
      organizationId: auth.organizationId,
      ...input,
      currency: input.currency ?? 'INR',
      price: money(input.price),
    },
  });
  await recordAudit(prisma, ctx, {
    action: 'CREATE',
    entityType: 'FreelancerPlan',
    entityId: plan.id,
    summary: `Freelancer plan ${plan.slug} created`,
    newData: plan,
  });
  return plan;
}

export async function updateFreelancerPlan(
  auth: AuthContext,
  id: string,
  input: Partial<{
    name: string;
    slug: string;
    description: string;
    price: Prisma.Decimal.Value;
    currency: string;
    billingInterval: BillingInterval;
    features: Prisma.InputJsonValue;
    limits: Prisma.InputJsonValue;
    isActive: boolean;
  }>,
  ctx: AuditRequestContext,
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.freelancerPlan.findFirst({ where: { id, organizationId: auth.organizationId } });
    if (!existing) throw notFound('Freelancer plan');
    const updated = await tx.freelancerPlan.update({
      where: { id },
      data: { ...input, price: input.price === undefined ? undefined : money(input.price) },
    });
    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'FreelancerPlan',
      entityId: id,
      summary: `Freelancer plan ${updated.slug} updated`,
      oldData: existing,
      newData: updated,
    });
    return updated;
  });
}

export function listFreelancerSubscriptions(organizationId: string, freelancerId: string) {
  return prisma.freelancerSubscription.findMany({
    where: { freelancerId, freelancer: { organizationId, deletedAt: null } },
    include: { plan: true },
    orderBy: { createdAt: 'desc' },
  });
}

export async function isFreelancerSearchable(
  organizationId: string,
  freelancerId: string,
  now = new Date(),
): Promise<boolean> {
  const freelancer = await prisma.freelancer.findFirst({
    where: { id: freelancerId, ...searchableFreelancerWhere(organizationId, now) },
    select: { id: true },
  });
  return Boolean(freelancer);
}

const SEARCHABLE_SUBSCRIPTION_STATUSES: FreelancerSubscriptionStatus[] = ['ACTIVE'];

function searchableFreelancerWhere(organizationId: string, now = new Date()): Prisma.FreelancerWhereInput {
  return {
    organizationId,
    deletedAt: null,
    status: 'ACTIVE',
    fullName: { not: '' },
    phone: { not: '' },
    // Discoverability is the paid freelancer feature: an approved application and a live subscription.
    applications: { some: { status: 'APPROVED' } },
    subscriptions: {
      some: {
        status: { in: SEARCHABLE_SUBSCRIPTION_STATUSES },
        OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { gte: now } }],
        canceledAt: null,
      },
    },
  };
}

export async function searchFreelancers(
  auth: AuthContext,
  query: {
    q?: string;
    location?: string;
    specialization?: CrewRole;
    skill?: string;
    availabilityDate?: string;
    availabilityStatus?: FreelancerAvailabilityStatus;
    page?: number;
    pageSize?: number;
  },
) {
  const page = query.page ?? 1;
  const limit = query.pageSize ?? 20;
  const availabilityDate = query.availabilityDate ? toDateOnly(query.availabilityDate) : undefined;
  const searchTerm = query.q?.trim();
  const matchingRoles = searchTerm
    ? Object.values(CrewRole).filter((role) => role.replaceAll('_', ' ').toLowerCase().includes(searchTerm.toLowerCase()))
    : [];
  const availabilityStatuses: FreelancerAvailabilityStatus[] = query.availabilityStatus
    ? [query.availabilityStatus]
    : ['AVAILABLE', 'PARTIALLY_AVAILABLE'];
  const where = andWhere(
    searchableFreelancerWhere(auth.organizationId),
    searchTerm ? {
      OR: [
        { fullName: { contains: searchTerm, mode: 'insensitive' } },
        { email: { contains: searchTerm, mode: 'insensitive' } },
        { phone: { contains: searchTerm, mode: 'insensitive' } },
        { code: { contains: searchTerm, mode: 'insensitive' } },
        { city: { contains: searchTerm, mode: 'insensitive' } },
        { skills: { has: searchTerm } },
        ...(matchingRoles.length ? [{ primarySkill: { in: matchingRoles } }] : []),
      ],
    } : undefined,
    query.location ? { city: { contains: query.location, mode: 'insensitive' } } : undefined,
    query.specialization ? { primarySkill: query.specialization } : undefined,
    query.skill ? { skills: { has: query.skill } } : undefined,
    availabilityDate ? {
      availability: {
        some: {
          date: availabilityDate,
          status: { in: availabilityStatuses },
        },
      },
    } : undefined,
  );

  const [total, rows] = await Promise.all([
    prisma.freelancer.count({ where }),
    prisma.freelancer.findMany({
      where,
      orderBy: [{ fullName: 'asc' }, { createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        code: true,
        fullName: true,
        city: true,
        primarySkill: true,
        skills: true,
        experienceYears: true,
        status: true,
        availability: availabilityDate
          ? { where: { date: availabilityDate }, select: { id: true, date: true, status: true, startTime: true, endTime: true }, take: 1 }
          : { orderBy: { date: 'asc' }, where: { date: { gte: new Date() } }, select: { id: true, date: true, status: true, startTime: true, endTime: true }, take: 1 },
        portfolioItems: {
          where: { isPublished: true },
          select: { id: true, title: true, fileObject: { select: { id: true, originalName: true, mimeType: true, sizeBytes: true } } },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
          take: 3,
        },
        connections: {
          where: { organizationId: auth.organizationId, status: { in: ACTIVE_CONNECTION_STATUSES } },
          select: { id: true, status: true, projectId: true, shootId: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        _count: { select: { portfolioItems: true } },
      },
    }),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      code: row.code,
      displayName: row.fullName,
      city: row.city,
      specialization: row.primarySkill,
      experienceYears: row.experienceYears,
      skills: row.skills,
      status: row.status,
      searchable: true,
      availability: row.availability[0] ?? null,
      portfolioPreview: row.portfolioItems,
      portfolioCount: row._count.portfolioItems,
      connection: row.connections[0] ?? null,
    })),
    pagination: {
      page,
      limit,
      total,
      totalPages: limit > 0 ? Math.ceil(total / limit) : 0,
      hasNext: page * limit < total,
      hasPrev: page > 1,
    },
  };
}

export async function createFreelancerSubscription(
  auth: AuthContext,
  freelancerId: string,
  input: {
    planId: string;
    status?: FreelancerSubscriptionStatus;
    startedAt?: Date;
    currentPeriodStart?: Date;
    currentPeriodEnd?: Date;
    canceledAt?: Date;
    externalCustomerId?: string;
    externalSubscriptionId?: string;
    metadata?: Prisma.InputJsonValue;
  },
  ctx: AuditRequestContext,
) {
  return prisma.$transaction(async (tx) => {
    await findScoped(tx.freelancer, auth.organizationId, freelancerId, 'Freelancer');
    const plan = await tx.freelancerPlan.findFirst({
      where: { id: input.planId, organizationId: auth.organizationId },
      select: { id: true, slug: true },
    });
    if (!plan) throw notFound('Freelancer plan');

    const subscription = await tx.freelancerSubscription.create({
      data: { freelancerId, ...input },
      include: { plan: true },
    });
    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'FreelancerSubscription',
      entityId: subscription.id,
      summary: `Freelancer subscription to ${plan.slug} created`,
      newData: subscription,
    });
    return subscription;
  });
}

export async function updateFreelancerSubscription(
  auth: AuthContext,
  freelancerId: string,
  subscriptionId: string,
  input: Partial<{
    status: FreelancerSubscriptionStatus;
    startedAt: Date;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    canceledAt: Date;
    externalCustomerId: string;
    externalSubscriptionId: string;
    metadata: Prisma.InputJsonValue;
  }>,
  ctx: AuditRequestContext,
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.freelancerSubscription.findFirst({
      where: { id: subscriptionId, freelancerId, freelancer: { organizationId: auth.organizationId } },
    });
    if (!existing) throw notFound('Freelancer subscription');
    if (
      input.status &&
      input.status !== existing.status &&
      !SUBSCRIPTION_TRANSITIONS[existing.status].includes(input.status)
    ) {
      throw conflict(`Cannot change subscription from ${existing.status} to ${input.status}`);
    }
    const updated = await tx.freelancerSubscription.update({
      where: { id: subscriptionId },
      data: input,
      include: { plan: true },
    });
    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'FreelancerSubscription',
      entityId: subscriptionId,
      summary: 'Freelancer subscription updated',
      oldData: existing,
      newData: updated,
    });
    return updated;
  });
}

export function listAvailability(
  organizationId: string,
  freelancerId: string,
  query: {
    page?: number;
    limit?: number;
    from?: string;
    to?: string;
    status?: FreelancerAvailabilityStatus;
  },
) {
  return paginate(prisma.freelancerAvailability, {
    where: andWhere(
      { freelancerId, freelancer: { organizationId, deletedAt: null } },
      query.status ? { status: query.status } : undefined,
      query.from ? { date: { gte: toDateOnly(query.from) } } : undefined,
      query.to ? { date: { lte: toDateOnly(query.to) } } : undefined,
    ),
    orderBy: { date: 'asc' },
    page: query.page,
    limit: query.limit,
  });
}

export async function upsertAvailability(
  auth: AuthContext,
  freelancerId: string,
  input: {
    date: string;
    status: FreelancerAvailabilityStatus;
    startTime?: Date | null;
    endTime?: Date | null;
    notes?: string | null;
  },
  ctx: AuditRequestContext,
) {
  return prisma.$transaction(async (tx) => {
    await findScoped(tx.freelancer, auth.organizationId, freelancerId, 'Freelancer');
    const date = toDateOnly(input.date);
    const availability = await tx.freelancerAvailability.upsert({
      where: { freelancerId_date: { freelancerId, date } },
      create: {
        freelancerId,
        date,
        status: input.status,
        startTime: input.startTime,
        endTime: input.endTime,
        notes: input.notes,
      },
      update: { status: input.status, startTime: input.startTime, endTime: input.endTime, notes: input.notes },
    });
    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'FreelancerAvailability',
      entityId: availability.id,
      summary: 'Freelancer availability saved',
      newData: availability,
    });
    return availability;
  });
}

export async function createPortfolioItem(
  auth: AuthContext,
  freelancerId: string,
  input: {
    fileObjectId: string;
    title: string;
    description?: string;
    category?: string;
    sortOrder?: number;
    isPublished?: boolean;
  },
  ctx: AuditRequestContext,
) {
  return prisma.$transaction(async (tx) => {
    await findScoped(tx.freelancer, auth.organizationId, freelancerId, 'Freelancer');
    const file = await tx.fileObject.findFirst({
      where: { id: input.fileObjectId, organizationId: auth.organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!file) throw notFound('File');
    const item = await tx.freelancerPortfolioItem.create({ data: { freelancerId, ...input } });
    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'FreelancerPortfolioItem',
      entityId: item.id,
      summary: 'Freelancer portfolio item added',
      newData: item,
    });
    return item;
  });
}

export function listPortfolioItems(organizationId: string, freelancerId: string) {
  return prisma.freelancerPortfolioItem.findMany({
    where: { freelancerId, freelancer: { organizationId, deletedAt: null } },
    include: { fileObject: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
  });
}

export async function updatePortfolioItem(
  auth: AuthContext,
  freelancerId: string,
  itemId: string,
  input: Partial<{
    title: string;
    description: string;
    category: string;
    sortOrder: number;
    isPublished: boolean;
  }>,
  ctx: AuditRequestContext,
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.freelancerPortfolioItem.findFirst({
      where: { id: itemId, freelancerId, freelancer: { organizationId: auth.organizationId } },
    });
    if (!existing) throw notFound('Freelancer portfolio item');
    const updated = await tx.freelancerPortfolioItem.update({ where: { id: itemId }, data: input });
    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'FreelancerPortfolioItem',
      entityId: itemId,
      summary: 'Freelancer portfolio item updated',
      oldData: existing,
      newData: updated,
    });
    return updated;
  });
}

export function listApplications(
  organizationId: string,
  query: {
    page?: number;
    limit?: number;
    search?: string;
    status?: FreelancerApplicationStatus;
    primarySkill?: CrewRole;
    city?: string;
    sortBy?: string;
    sortOrder?: string;
  },
) {
  const sort = resolveSort(query.sortBy, query.sortOrder, APPLICATION_SORTABLE, 'submittedAt');
  return paginate(prisma.freelancerApplication, {
    where: andWhere(
      { organizationId },
      query.status ? { status: query.status } : undefined,
      query.primarySkill ? { primarySkill: query.primarySkill } : undefined,
      query.city ? { city: { equals: query.city, mode: 'insensitive' } } : undefined,
      searchFilter(query.search, ['fullName', 'phone', 'email', 'city']),
    ),
    orderBy: { [sort.field]: sort.direction },
    page: query.page,
    limit: query.limit,
    include: { freelancer: { select: { id: true, code: true, fullName: true } }, reviewedBy: { select: { id: true, fullName: true } } },
  });
}

export async function createApplication(
  auth: AuthContext,
  input: {
    freelancerId?: string;
    fullName: string;
    phone: string;
    whatsapp?: string;
    email?: string;
    city?: string;
    primarySkill?: CrewRole;
    skills?: string[];
    experienceYears?: number;
    portfolioUrl?: string;
    expectedRate?: Prisma.Decimal.Value;
    rateType?: RateType;
    notes?: string;
  },
  ctx: AuditRequestContext,
) {
  return prisma.$transaction(async (tx) => {
    if (input.freelancerId) {
      await findScoped(tx.freelancer, auth.organizationId, input.freelancerId, 'Freelancer');
    }
    const duplicate = await tx.freelancerApplication.findFirst({
      where: {
        organizationId: auth.organizationId,
        status: { in: ACTIVE_APPLICATION_STATUSES },
        OR: [
          { phone: input.phone },
          ...(input.email ? [{ email: input.email.toLowerCase() }] : []),
        ],
      },
      select: { id: true },
    });
    if (duplicate) throw conflict('An active freelancer application already exists for this applicant');
    const application = await tx.freelancerApplication.create({
      data: {
        organizationId: auth.organizationId,
        ...input,
        email: input.email?.toLowerCase(),
        skills: input.skills ?? [],
        status: 'SUBMITTED',
        expectedRate: input.expectedRate === undefined ? undefined : money(input.expectedRate),
      },
    });
    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'FreelancerApplication',
      entityId: application.id,
      summary: 'Freelancer application created',
      newData: application,
    });
    return application;
  });
}

export async function reviewApplication(
  auth: AuthContext,
  id: string,
  input: {
    status: FreelancerApplicationStatus;
    freelancerId?: string;
    rejectionReason?: string;
    notes?: string;
  },
  ctx: AuditRequestContext,
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.freelancerApplication.findFirst({
      where: { id, organizationId: auth.organizationId },
    });
    if (!existing) throw notFound('Freelancer application');
    if (existing.status === 'APPROVED' && input.status === 'APPROVED') {
      throw conflict('Freelancer application is already approved');
    }
    if (existing.status === 'REJECTED' || existing.status === 'WITHDRAWN') {
      throw conflict('Settled freelancer applications cannot be reviewed again');
    }
    let freelancerId = input.freelancerId ?? existing.freelancerId ?? undefined;
    if (input.freelancerId) {
      await findScoped(tx.freelancer, auth.organizationId, input.freelancerId, 'Freelancer');
    }
    if (input.status === 'APPROVED' && !freelancerId) {
      const code = await nextDocumentNumber(tx, auth.organizationId, 'FREELANCER');
      const freelancer = await tx.freelancer.create({
        data: {
          organizationId: auth.organizationId,
          code,
          fullName: existing.fullName,
          phone: existing.phone,
          whatsapp: existing.whatsapp,
          email: existing.email?.toLowerCase(),
          city: existing.city,
          primarySkill: existing.primarySkill,
          skills: existing.skills,
          experienceYears: existing.experienceYears,
          rate: existing.expectedRate ?? undefined,
          rateType: existing.rateType,
          notes: existing.notes,
        },
      });
      freelancerId = freelancer.id;
      await recordAudit(tx, ctx, {
        action: 'CREATE',
        entityType: 'Freelancer',
        entityId: freelancer.id,
        summary: `Freelancer ${code} created from approved application`,
        newData: freelancer,
      });
    }
    const updated = await tx.freelancerApplication.update({
      where: { id },
      data: {
        status: input.status,
        freelancerId,
        rejectionReason: input.rejectionReason,
        notes: input.notes,
        reviewedById: auth.userId,
        reviewedAt: new Date(),
      },
    });
    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'FreelancerApplication',
      entityId: id,
      summary: `Freelancer application marked ${input.status}`,
      oldData: existing,
      newData: updated,
    });
    if (input.status !== 'APPROVED' || !freelancerId) return updated;

    const onboarding = await createOnboardingInvitation(tx, {
      organizationId: auth.organizationId,
      freelancerId,
      applicationId: updated.id,
      createdById: auth.userId,
    }, ctx);

    return {
      ...updated,
      onboardingInvitation: {
        id: onboarding.invitation.id,
        expiresAt: onboarding.invitation.expiresAt,
        invitationPath: env.isProduction ? undefined : onboarding.invitationPath,
      },
    };
  });
}

export function listConnections(
  organizationId: string,
  query: {
    page?: number;
    limit?: number;
    status?: FreelancerConnectionStatus;
    projectId?: string;
    shootId?: string;
    freelancerId?: string;
    sortBy?: string;
    sortOrder?: string;
  },
) {
  const sort = resolveSort(query.sortBy, query.sortOrder, CONNECTION_SORTABLE, 'createdAt');
  return paginate(prisma.freelancerConnection, {
    where: andWhere(
      { organizationId },
      query.status ? { status: query.status } : undefined,
      query.projectId ? { projectId: query.projectId } : undefined,
      query.shootId ? { shootId: query.shootId } : undefined,
      query.freelancerId ? { freelancerId: query.freelancerId } : undefined,
    ),
    orderBy: { [sort.field]: sort.direction },
    page: query.page,
    limit: query.limit,
    include: {
      freelancer: { select: { id: true, code: true, fullName: true, primarySkill: true, city: true } },
      project: { select: { id: true, projectNumber: true, name: true } },
      shoot: { select: { id: true, title: true, shootDate: true } },
      createdBy: { select: { id: true, fullName: true } },
    },
  });
}

export async function createConnection(
  auth: AuthContext,
  input: {
    freelancerId: string;
    projectId?: string;
    shootId?: string;
    status?: FreelancerConnectionStatus;
    notes?: string;
  },
  ctx: AuditRequestContext,
) {
  return prisma.$transaction(async (tx) => {
    const freelancer = await findScoped<{ id: string; fullName: string; maxShootsPerDay: number }>(
      tx.freelancer,
      auth.organizationId,
      input.freelancerId,
      'Freelancer',
      { select: { id: true, fullName: true, maxShootsPerDay: true } },
    );
    const searchable = await tx.freelancer.findFirst({
      where: { id: input.freelancerId, ...searchableFreelancerWhere(auth.organizationId) },
      select: { id: true },
    });
    if (!searchable) {
      throw conflict('This freelancer is not currently searchable');
    }
    if (input.projectId) await findScoped(tx.project, auth.organizationId, input.projectId, 'Project');
    if (input.shootId) {
      const shoot = await findScoped<{ id: string; projectId: string }>(
        tx.shoot,
        auth.organizationId,
        input.shootId,
        'Shoot',
        { select: { id: true, projectId: true } },
      );
      if (input.projectId && shoot.projectId !== input.projectId) {
        throw conflict('Shoot does not belong to the selected project');
      }
    }
    const duplicate = await tx.freelancerConnection.findFirst({
      where: {
        organizationId: auth.organizationId,
        freelancerId: input.freelancerId,
        projectId: input.projectId ?? null,
        shootId: input.shootId ?? null,
        status: { in: ACTIVE_CONNECTION_STATUSES },
      },
      select: { id: true },
    });
    if (duplicate) throw conflict('An active freelancer connection already exists for this context');

    const connection = await tx.freelancerConnection.create({
      data: {
        organizationId: auth.organizationId,
        ...input,
        status: input.status ?? 'INTERESTED',
        createdById: auth.userId,
      },
    });
    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'FreelancerConnection',
      entityId: connection.id,
      summary: `${freelancer.fullName} marked ${connection.status}`,
      newData: connection,
    });
    return connection;
  });
}

export async function updateConnection(
  auth: AuthContext,
  id: string,
  input: {
    status?: FreelancerConnectionStatus;
    notes?: string | null;
  },
  ctx: AuditRequestContext,
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.freelancerConnection.findFirst({
      where: { id, organizationId: auth.organizationId },
    });
    if (!existing) throw notFound('Freelancer connection');
    if (
      input.status &&
      input.status !== existing.status &&
      !CONNECTION_TRANSITIONS[existing.status].includes(input.status)
    ) {
      throw conflict(`Cannot change connection from ${existing.status} to ${input.status}`);
    }
    const updated = await tx.freelancerConnection.update({ where: { id }, data: input });
    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'FreelancerConnection',
      entityId: id,
      summary: 'Freelancer connection updated',
      oldData: existing,
      newData: updated,
    });
    return updated;
  });
}

export async function connectConnection(
  auth: AuthContext,
  id: string,
  input: {
    projectId: string;
    shootId?: string;
    role?: CrewRole;
    notes?: string;
  },
  ctx: AuditRequestContext,
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.freelancerConnection.findFirst({
      where: { id, organizationId: auth.organizationId },
      include: { freelancer: { select: { id: true, fullName: true, primarySkill: true, maxShootsPerDay: true } } },
    });
    if (!existing) throw notFound('Freelancer connection');
    // ASSIGNED, DECLINED and EXPIRED are terminal in CONNECTION_TRANSITIONS.
    // updateConnection honours that; without the same guard here a second
    // /connect reset an assigned connection to CONTACTED and left its
    // ShootAssignment behind, so the booking and the connection diverged.
    if (CONNECTION_TRANSITIONS[existing.status].length === 0) {
      throw conflict(`Cannot connect a connection that is already ${existing.status}`);
    }
    const searchable = await tx.freelancer.findFirst({
      where: { id: existing.freelancerId, ...searchableFreelancerWhere(auth.organizationId) },
      select: { id: true },
    });
    if (!searchable) {
      throw conflict('This freelancer is not currently searchable');
    }
    const project = await findScoped<{ id: string; name: string }>(
      tx.project,
      auth.organizationId,
      input.projectId,
      'Project',
      { select: { id: true, name: true } },
    );

    const selectedShoot = input.shootId
      ? await findScoped<{ id: string; title: string; projectId: string; shootDate: Date }>(
        tx.shoot,
        auth.organizationId,
        input.shootId,
        'Shoot',
        { select: { id: true, title: true, projectId: true, shootDate: true } },
      )
      : null;
    if (selectedShoot && selectedShoot.projectId !== project.id) {
      throw conflict('Shoot does not belong to the selected project');
    }

    if (existing.status !== 'ACCEPTED') {
      const requested = await tx.freelancerConnection.update({
        where: { id },
        data: {
          projectId: project.id,
          shootId: input.shootId ?? null,
          status: 'CONTACTED',
          notes: input.notes ?? existing.notes,
        },
        include: {
          freelancer: { select: { id: true, code: true, fullName: true, primarySkill: true, city: true } },
          project: { select: { id: true, projectNumber: true, name: true } },
          shoot: { select: { id: true, title: true, shootDate: true } },
        },
      });
      await recordAudit(tx, ctx, {
        action: 'UPDATE',
        entityType: 'FreelancerConnection',
        entityId: id,
        summary: `Freelancer approval requested for project ${project.name}`,
        oldData: existing,
        newData: requested,
      });
      return { connection: requested, assignment: null };
    }

    let assignment: unknown = null;
    let nextStatus: FreelancerConnectionStatus = 'ACCEPTED';
    if (selectedShoot) {
      const sameDay = await tx.shootAssignment.count({
        where: {
          freelancerId: existing.freelancerId,
          status: { notIn: ['DECLINED', 'CANCELLED'] },
          shoot: { projectId: { not: project.id }, shootDate: selectedShoot.shootDate, deletedAt: null },
        },
      });
      if (sameDay >= existing.freelancer.maxShootsPerDay) {
        throw conflict(`This freelancer is already booked for ${sameDay} shoot(s) on that date`);
      }
      const assignmentRole = input.role ?? existing.freelancer.primarySkill ?? 'OTHER';
      const duplicateAssignment = await tx.shootAssignment.findFirst({
        where: {
          shootId: selectedShoot.id,
          freelancerId: existing.freelancerId,
          role: assignmentRole,
          status: { notIn: ['DECLINED', 'CANCELLED'] },
        },
        select: { id: true },
      });
      if (duplicateAssignment) throw conflict('This freelancer is already assigned to this shoot in that role');
      assignment = await tx.shootAssignment.create({
        data: {
          shootId: selectedShoot.id,
          freelancerId: existing.freelancerId,
          role: assignmentRole,
          assignedById: auth.userId,
          notes: input.notes,
        },
        include: { freelancer: { select: { id: true, fullName: true, code: true } } },
      });
      nextStatus = 'ASSIGNED';
    }

    const updated = await tx.freelancerConnection.update({
      where: { id },
      data: {
        projectId: project.id,
        shootId: input.shootId ?? null,
        status: nextStatus,
        notes: input.notes ?? existing.notes,
      },
      include: {
        freelancer: { select: { id: true, code: true, fullName: true, primarySkill: true, city: true } },
        project: { select: { id: true, projectNumber: true, name: true } },
        shoot: { select: { id: true, title: true, shootDate: true } },
      },
    });
    if (assignment && typeof assignment === 'object' && 'id' in assignment) {
      await recordAudit(tx, ctx, {
        action: 'ASSIGN',
        entityType: 'ShootAssignment',
        entityId: (assignment as { id: string }).id,
        summary: 'Freelancer assigned after approval',
        newData: assignment,
      });
    }
    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'FreelancerConnection',
      entityId: id,
      summary: `Freelancer connected to project ${project.name}`,
      oldData: existing,
      newData: updated,
    });
    return { connection: updated, assignment };
  });
}
