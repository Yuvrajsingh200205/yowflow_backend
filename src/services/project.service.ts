import {
  CrewRole,
  Prisma,
  ProjectStatus,
  ProjectType,
  ShootStatus,
  ShootType,
  TaskCategory,
  TaskPriority,
  TaskStatus,
} from '@prisma/client';
import { prisma } from '../config/prisma';
import { andWhere, findScoped, paginate, searchFilter } from '../repositories/base.repository';
import { resolveSort } from '../utils/pagination';
import { nextDocumentNumber } from '../utils/documentNumber';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors';
import { dateRangeFilter } from '../utils/date';
import { AuthContext } from '../types';
import { AuditRequestContext, recordAudit } from './audit.service';

const SORTABLE = ['createdAt', 'weddingDate', 'name', 'projectNumber', 'totalQuotation'] as const;
const BOOKING_BLOCKING_SHOOT_STATUSES: ShootStatus[] = [ShootStatus.SCHEDULED, ShootStatus.IN_PROGRESS, ShootStatus.COMPLETED];
const formatDateKey = (date: Date) => date.toISOString().slice(0, 10);
const hasKnownNonOverlappingTimes = (
  next: { startTime?: Date | null; endTime?: Date | null },
  existing: { startTime?: Date | null; endTime?: Date | null },
) => {
  if (!next.startTime || !next.endTime || !existing.startTime || !existing.endTime) return false;
  return next.endTime.getTime() <= existing.startTime.getTime() || existing.endTime.getTime() <= next.startTime.getTime();
};

/**
 * Legal status transitions. A project cannot jump from LEAD straight to
 * COMPLETED. Completed projects may move back to delivery when the studio
 * needs to correct a premature completion.
 */
const ALLOWED_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  UPCOMING: ['CONFIRMED', 'CANCELLED'],
  LEAD: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['UPCOMING', 'PLANNING', 'SHOOTING', 'CANCELLED'],
  PLANNING: ['SHOOTING', 'CANCELLED'],
  SHOOTING: ['EDITING', 'CANCELLED'],
  EDITING: ['DELIVERY', 'CANCELLED'],
  DELIVERY: ['COMPLETED', 'EDITING', 'CANCELLED'],
  COMPLETED: ['DELIVERY'],
  CANCELLED: [],
};

const PROJECT_TASK_INCLUDE = {
  where: { deletedAt: null },
  orderBy: { createdAt: 'asc' as const },
  include: { assignee: { select: { id: true, fullName: true } } },
};

const PROJECT_SHOOT_INCLUDE = {
  where: { deletedAt: null },
  orderBy: { shootDate: 'asc' as const },
  include: {
    assignments: {
      include: {
        user: { select: { id: true, fullName: true, phone: true } },
        freelancer: { select: { id: true, fullName: true, code: true, phone: true } },
      },
    },
  },
};

const PROJECT_CREATE_INCLUDE = {
  client: { select: { id: true, clientCode: true, displayName: true, primaryPhone: true } },
  events: { where: { deletedAt: null }, orderBy: { eventDate: 'asc' as const } },
  shoots: PROJECT_SHOOT_INCLUDE,
  tasks: PROJECT_TASK_INCLUDE,
};

type Tx = Prisma.TransactionClient;

function canViewAllProjects(auth: AuthContext) {
  return auth.permissions.has('PROJECT_VIEW_ALL');
}

function assignedProjectWhere(auth: AuthContext): Prisma.ProjectWhereInput {
  if (canViewAllProjects(auth)) return {};
  return {
    OR: [
      { managerId: auth.userId },
      { tasks: { some: { assigneeId: auth.userId, deletedAt: null } } },
      { shoots: { some: { deletedAt: null, assignments: { some: { userId: auth.userId } } } } },
    ],
  };
}

export function scopedProjectWhere(auth: AuthContext, extra?: Prisma.ProjectWhereInput): Prisma.ProjectWhereInput {
  return andWhere(
    { organizationId: auth.organizationId, deletedAt: null },
    assignedProjectWhere(auth),
    extra,
  );
}

export async function assertCanAccessProject(auth: AuthContext, projectId: string) {
  const project = await prisma.project.findFirst({
    where: scopedProjectWhere(auth, { id: projectId }),
    select: { id: true },
  });
  if (!project) throw notFound('Project');
}

function redactProjectForFeatureAccess<T extends Record<string, any>>(auth: AuthContext, project: T): T {
  const canViewFinancials = auth.permissions.has('PROJECT_FINANCIAL_VIEW');
  const canViewMilestones = auth.permissions.has('PAYMENT_MILESTONE_VIEW');
  const canViewPayments = auth.permissions.has('PAYMENT_VIEW');
  const canViewClient = auth.permissions.has('CLIENT_VIEW');
  const next: Record<string, any> = { ...project };
  if (!canViewFinancials) {
    next.totalQuotation = null;
    next.incomes = undefined;
    next.expenses = undefined;
  }
  if (!canViewMilestones) next.paymentMilestones = undefined;
  if (!canViewPayments) next.payments = undefined;
  if (!canViewClient && next.client) {
    next.client = { id: next.client.id, clientCode: next.client.clientCode ?? null, displayName: next.name, primaryPhone: null };
  }
  return next as T;
}

async function loadCreatedProject(tx: Tx, organizationId: string, projectId: string) {
  return findScoped<Record<string, unknown>>(tx.project, organizationId, projectId, 'Project', {
    include: PROJECT_CREATE_INCLUDE,
  });
}

function assertNestedCreatePermissions(auth: AuthContext, input: CreateProjectInput) {
  if (input.tasks?.length && !auth.permissions.has('TASK_CREATE')) {
    throw forbidden('TASK_CREATE permission is required to create project tasks.');
  }
  if (input.shoots?.length && !auth.permissions.has('SHOOT_CREATE')) {
    throw forbidden('SHOOT_CREATE permission is required to create project shoots.');
  }
  if (input.shoots?.some((shoot) => (shoot.crewAssignments || []).length > 0) && !auth.permissions.has('SHOOT_ASSIGN')) {
    throw forbidden('SHOOT_ASSIGN permission is required to assign project shoot crew.');
  }
}

async function resolveProjectClient(
  tx: Tx,
  auth: AuthContext,
  input: CreateProjectInput,
  ctx: AuditRequestContext,
): Promise<string> {
  if (input.clientId) {
    const client = await tx.client.findFirst({
      where: { id: input.clientId, organizationId: auth.organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!client) throw notFound('Client');
    return client.id;
  }

  const pendingClient = input.client;
  if (!pendingClient) throw badRequest('Provide either clientId or client details.');

  const phoneMatch = await tx.client.findFirst({
    where: {
      organizationId: auth.organizationId,
      deletedAt: null,
      primaryPhone: pendingClient.primaryPhone,
    },
    select: { id: true },
  });
  if (phoneMatch) return phoneMatch.id;

  const nameMatch = await tx.client.findFirst({
    where: {
      organizationId: auth.organizationId,
      deletedAt: null,
      displayName: { equals: pendingClient.displayName, mode: 'insensitive' },
    },
    select: { id: true },
  });
  if (nameMatch) return nameMatch.id;

  if (!auth.permissions.has('CLIENT_CREATE')) {
    throw forbidden('CLIENT_CREATE permission is required to create a new client during project intake.');
  }

  const clientCode = await nextDocumentNumber(tx, auth.organizationId, 'CLIENT');
  const created = await tx.client.create({
    data: {
      organizationId: auth.organizationId,
      clientCode,
      displayName: pendingClient.displayName,
      primaryPhone: pendingClient.primaryPhone,
      primaryEmail: pendingClient.primaryEmail?.toLowerCase(),
    },
  });

  await recordAudit(tx, ctx, {
    action: 'CREATE',
    entityType: 'Client',
    entityId: created.id,
    summary: `Client ${clientCode} created during project intake`,
    newData: created,
  });

  return created.id;
}

async function createProjectTasks(
  tx: Tx,
  auth: AuthContext,
  projectId: string,
  projectName: string,
  clientId: string,
  tasks: NonNullable<CreateProjectInput['tasks']>,
) {
  const assigneeIds = [...new Set(tasks.map((task) => task.assigneeId).filter((value): value is string => Boolean(value)))];
  const validAssigneeIds = new Set<string>();
  if (assigneeIds.length > 0) {
    const users = await tx.user.findMany({
      where: { id: { in: assigneeIds }, organizationId: auth.organizationId, deletedAt: null },
      select: { id: true },
    });
    users.forEach((user) => validAssigneeIds.add(user.id));
  }

  const notified = new Set<string>();
  for (const item of tasks) {
    const assigneeId = item.assigneeId && validAssigneeIds.has(item.assigneeId) ? item.assigneeId : undefined;
    const requestedStatus = item.status ?? (assigneeId ? TaskStatus.ASSIGNED : TaskStatus.TODO);
    const status =
      requestedStatus === TaskStatus.TODO && assigneeId ? TaskStatus.ASSIGNED
        : requestedStatus === TaskStatus.ASSIGNED && !assigneeId ? TaskStatus.TODO
        : requestedStatus;

    const task = await tx.task.create({
      data: {
        organizationId: auth.organizationId,
        projectId,
        clientId,
        title: item.title,
        description: item.description,
        category: item.category ?? TaskCategory.OTHER,
        priority: item.priority ?? TaskPriority.MEDIUM,
        quantity: item.quantity ?? 1,
        unit: item.unit,
        dueDate: item.dueDate,
        status,
        assigneeId,
        createdById: auth.userId,
        startedAt: status === TaskStatus.IN_PROGRESS ? new Date() : undefined,
        completedAt: status === TaskStatus.COMPLETED ? new Date() : undefined,
      },
    });

    await tx.taskStatusHistory.create({
      data: {
        taskId: task.id,
        oldStatus: null,
        newStatus: status,
        changedById: auth.userId,
        reason: 'Task created',
      },
    });

    if (!assigneeId) continue;

    await tx.taskAssignment.create({
      data: {
        taskId: task.id,
        fromUserId: null,
        toUserId: assigneeId,
        assignedById: auth.userId,
        reason: 'Assigned on project create',
      },
    });

    if (notified.has(assigneeId)) continue;
    notified.add(assigneeId);
    await tx.notification.create({
      data: {
        organizationId: auth.organizationId,
        userId: assigneeId,
        type: 'TASK_ASSIGNED',
        title: 'You were assigned to a project',
        message: `${projectName}: ${item.title}`,
        entityType: 'Project',
        entityId: projectId,
      },
    });
  }
}

async function createProjectShoots(
  tx: Tx,
  auth: AuthContext,
  projectId: string,
  shoots: NonNullable<CreateProjectInput['shoots']>,
) {
  const crewUserIds = [...new Set(
    shoots.flatMap((shoot) => shoot.crewAssignments || []).map((assignment) => assignment.userId),
  )];
  const validUserIds = new Set<string>();
  const crewUserNames = new Map<string, string>();
  if (crewUserIds.length > 0) {
    const users = await tx.user.findMany({
      where: { id: { in: crewUserIds }, organizationId: auth.organizationId, deletedAt: null },
      select: { id: true, fullName: true },
    });
    users.forEach((user) => {
      validUserIds.add(user.id);
      crewUserNames.set(user.id, user.fullName);
    });
  }

  for (const [index, item] of shoots.entries()) {
    if (item.startTime && item.endTime && item.endTime.getTime() <= item.startTime.getTime()) {
      throw badRequest('A shoot end time must be later than its start time.', [
        { field: `shoots.${index}.endTime`, message: 'Must be later than startTime' },
      ]);
    }

    const status = item.status ?? ShootStatus.SCHEDULED;
    const shoot = await tx.shoot.create({
      data: {
        organizationId: auth.organizationId,
        projectId,
        title: item.title,
        shootType: item.shootType ?? ShootType.PHOTO_AND_VIDEO,
        shootDate: item.shootDate,
        startTime: item.startTime,
        endTime: item.endTime,
        location: item.location,
        city: item.city,
        notes: item.notes,
        plannedRoleSlots: item.plannedRoleSlots,
        status,
        createdById: auth.userId,
        completedAt: status === ShootStatus.COMPLETED ? new Date() : undefined,
      },
    });

    const seenCrewRoleAssignments = new Set<string>();
    for (const assignment of item.crewAssignments || []) {
      if (!validUserIds.has(assignment.userId)) throw notFound('Team member');
      const assignmentDate = formatDateKey(item.shootDate);
      const employeeName = crewUserNames.get(assignment.userId) || 'This employee';
      const crewRoleKey = `${assignment.userId}:${assignment.role}`;
      if (seenCrewRoleAssignments.has(crewRoleKey)) {
        throw conflict(`${employeeName} is already assigned to ${assignment.role} for ${assignmentDate}.`);
      }
      seenCrewRoleAssignments.add(crewRoleKey);

      const sameDayAssignments = await tx.shootAssignment.findMany({
        where: {
          userId: assignment.userId,
          status: { notIn: ['DECLINED', 'CANCELLED'] },
          shoot: {
            projectId: { not: projectId },
            shootDate: dateRangeFilter(assignmentDate, assignmentDate),
            status: { in: BOOKING_BLOCKING_SHOOT_STATUSES },
            deletedAt: null,
          },
        },
        select: { shoot: { select: { title: true, shootDate: true, startTime: true, endTime: true } }, user: { select: { fullName: true } } },
      });
      const sameDay = sameDayAssignments.find((row) => !hasKnownNonOverlappingTimes(item, row.shoot));
      if (sameDay) {
        throw conflict(`${sameDay.user?.fullName || employeeName} is already assigned on ${formatDateKey(sameDay.shoot.shootDate)} for "${sameDay.shoot.title}".`);
      }

      await tx.shootAssignment.create({
        data: {
          shootId: shoot.id,
          userId: assignment.userId,
          role: assignment.role,
          assignedById: auth.userId,
        },
      });

      await tx.notification.create({
        data: {
          organizationId: auth.organizationId,
          userId: assignment.userId,
          type: 'SHOOT_ASSIGNED',
          title: 'You have been assigned to a shoot',
          message: `${shoot.title} — role ${assignment.role}`,
          entityType: 'Shoot',
          entityId: shoot.id,
        },
      });
    }
  }
}

export interface ProjectListQuery {
  page?: number;
  limit?: number;
  search?: string;
  status?: ProjectStatus;
  isUrgent?: boolean;
  type?: ProjectType;
  clientId?: string;
  managerId?: string;
  branchId?: string;
  from?: string;
  to?: string;
  sortBy?: string;
  sortOrder?: string;
}

export function listProjects(auth: AuthContext, query: ProjectListQuery) {
  const sort = resolveSort(query.sortBy, query.sortOrder, SORTABLE, 'createdAt');
  const weddingDate = dateRangeFilter(query.from, query.to);
  return paginate(prisma.project, {
    where: andWhere(
      scopedProjectWhere(auth),
      query.status ? { status: query.status } : undefined,
      query.isUrgent === undefined ? undefined : { isUrgent: query.isUrgent },
      query.type ? { type: query.type } : undefined,
      query.clientId ? { clientId: query.clientId } : undefined,
      query.managerId ? { managerId: query.managerId } : undefined,
      query.branchId ? { branchId: query.branchId } : undefined,
      weddingDate ? { weddingDate } : undefined,
      searchFilter(query.search, ['name', 'projectNumber', 'venueName', 'venueCity']),
    ),
    orderBy: { [sort.field]: sort.direction },
    page: query.page,
    limit: query.limit,
    include: {
      client: { select: { id: true, clientCode: true, displayName: true, primaryPhone: true } },
      manager: { select: { id: true, fullName: true } },
      tasks: PROJECT_TASK_INCLUDE,
      paymentMilestones: { select: { id: true, amount: true, status: true } },
      _count: { select: { events: true, shoots: true, tasks: true, deliveries: true } },
    },
  }).then((result) => ({
    ...result,
    items: result.items.map((project) => redactProjectForFeatureAccess(auth, project as Record<string, any>)),
  }));
}

export async function getProject(auth: AuthContext, id: string) {
  const project = await prisma.project.findFirst({
    where: scopedProjectWhere(auth, { id }),
    include: {
      client: { include: { contacts: true, addresses: true } },
      manager: { select: { id: true, fullName: true, email: true } },
      createdBy: { select: { id: true, fullName: true } },
      branch: { select: { id: true, name: true, code: true } },
      events: { where: { deletedAt: null }, orderBy: { eventDate: 'asc' } },
      shoots: PROJECT_SHOOT_INCLUDE,
      tasks: PROJECT_TASK_INCLUDE,
      payments: {
        orderBy: { paymentDate: 'desc' },
      },
      paymentMilestones: { select: { id: true, amount: true, status: true } },
      deliveries: { where: { deletedAt: null }, orderBy: { expectedDate: 'asc' } },
      statusHistory: {
        orderBy: { createdAt: 'desc' },
        take: 25,
        include: { changedBy: { select: { id: true, fullName: true } } },
      },
    },
  });
  if (!project) throw notFound('Project');

  let meta: { dataBackup?: Record<string, unknown>; deliveryStatus?: Record<string, unknown> } = {};
  if (project.otherClientDetails) {
    try {
      meta = JSON.parse(project.otherClientDetails);
    } catch {
      meta = {};
    }
  }

  return redactProjectForFeatureAccess(auth, {
    ...project,
    dataBackup: meta.dataBackup || null,
    deliveryStatus: meta.deliveryStatus || null,
  });
}

/** Removes only the planned instalment; recorded payments and project totals stay intact. */
export async function deletePaymentMilestone(
  auth: AuthContext, projectId: string, milestoneId: string,
  legacyMilestones: Array<{ id: string; stageName: string; dueDate?: string; amount: number; status?: string; notes?: string }> = [],
  ctx: AuditRequestContext,
) {
  const project = await prisma.project.findFirst({ where: scopedProjectWhere(auth, { id: projectId }), select: { id: true } });
  if (!project) throw notFound('Project');
  const milestone = await prisma.paymentMilestone.findFirst({
    where: { id: milestoneId, projectId, organizationId: auth.organizationId },
    select: { id: true, title: true, projectId: true },
  });
  // Existing UI schedules used `sched-*` IDs before milestones had a table.
  // Persist every remaining legacy item, deliberately excluding the requested
  // item; after this first delete the DB is authoritative.
  if (!milestone && legacyMilestones.length > 0) {
    await prisma.paymentMilestone.createMany({
      data: legacyMilestones
        .filter((item) => item.id !== milestoneId)
        .map((item) => ({
          id: item.id, organizationId: auth.organizationId, projectId,
          title: item.stageName, amount: item.amount,
          dueDate: item.dueDate && !Number.isNaN(Date.parse(item.dueDate)) ? new Date(item.dueDate) : null,
          status: item.status?.toUpperCase() || 'PENDING', notes: item.notes,
        })),
      skipDuplicates: true,
    });
    return;
  }
  if (!milestone) throw notFound('Payment milestone');
  await prisma.paymentMilestone.delete({ where: { id: milestone.id } });
  await recordAudit(prisma, ctx, {
    action: 'DELETE', entityType: 'PaymentMilestone', entityId: milestone.id,
    summary: `Payment milestone ${milestone.title} deleted`, oldData: milestone,
  });
}

export async function listPaymentMilestones(auth: AuthContext, projectId: string) {
  await assertCanAccessProject(auth, projectId);
  if (!auth.permissions.has('PAYMENT_MILESTONE_VIEW')) throw forbidden('PAYMENT_MILESTONE_VIEW permission is required.');
  return prisma.paymentMilestone.findMany({ where: { organizationId: auth.organizationId, projectId }, orderBy: { createdAt: 'asc' } });
}

export interface PaymentMilestoneInput {
  title: string;
  amount: string;
  /** Derived by the UI from amount / project total; not a database column. */
  percentage?: string;
  dueDate: Date;
  status: 'PENDING' | 'RECEIVED' | 'OVERDUE';
  notes?: string;
}

async function assertMilestonesWithinProjectTotal(
  auth: AuthContext,
  projectId: string,
  nextAmount: string,
  replacingMilestoneId?: string,
) {
  const project = await prisma.project.findFirst({
    where: scopedProjectWhere(auth, { id: projectId }),
    select: { id: true, totalQuotation: true },
  });
  if (!project) throw notFound('Project');
  const existing = await prisma.paymentMilestone.aggregate({
    where: {
      organizationId: auth.organizationId,
      projectId,
      ...(replacingMilestoneId ? { id: { not: replacingMilestoneId } } : {}),
    },
    _sum: { amount: true },
  });
  const scheduledTotal = Number(existing._sum.amount ?? 0) + Number(nextAmount || 0);
  if (scheduledTotal > Number(project.totalQuotation || 0)) {
    throw badRequest('Scheduled payment milestones cannot exceed the project total.');
  }
}

export async function createPaymentMilestone(
  auth: AuthContext, projectId: string, input: PaymentMilestoneInput, ctx: AuditRequestContext,
) {
  if (!auth.permissions.has('PAYMENT_MILESTONE_MANAGE')) throw forbidden('PAYMENT_MILESTONE_MANAGE permission is required.');
  await assertMilestonesWithinProjectTotal(auth, projectId, input.amount);
  const { percentage: _percentage, ...milestoneData } = input;
  const milestone = await prisma.paymentMilestone.create({
    data: { organizationId: auth.organizationId, projectId, ...milestoneData },
  });
  await recordAudit(prisma, ctx, {
    action: 'CREATE', entityType: 'PaymentMilestone', entityId: milestone.id,
    summary: `Payment milestone ${milestone.title} created`, newData: milestone,
  });
  return milestone;
}

export async function updatePaymentMilestone(
  auth: AuthContext, projectId: string, milestoneId: string, input: PaymentMilestoneInput, ctx: AuditRequestContext,
) {
  if (!auth.permissions.has('PAYMENT_MILESTONE_MANAGE')) throw forbidden('PAYMENT_MILESTONE_MANAGE permission is required.');
  const existing = await prisma.paymentMilestone.findFirst({
    where: { id: milestoneId, projectId, organizationId: auth.organizationId },
  });
  if (!existing) throw notFound('Payment milestone');
  await assertMilestonesWithinProjectTotal(auth, projectId, input.amount, milestoneId);
  const { percentage: _percentage, ...milestoneData } = input;
  const milestone = await prisma.paymentMilestone.update({ where: { id: milestoneId }, data: milestoneData });
  await recordAudit(prisma, ctx, {
    action: 'UPDATE', entityType: 'PaymentMilestone', entityId: milestone.id,
    summary: `Payment milestone ${milestone.title} updated`, oldData: existing, newData: milestone,
  });
  return milestone;
}

export interface CreateProjectInput {
  clientId?: string;
  client?: {
    displayName: string;
    primaryPhone: string;
    primaryEmail?: string;
  };
  leadId?: string;
  branchId?: string;
  name: string;
  type?: ProjectType;
  status?: ProjectStatus;
  isUrgent?: boolean;
  weddingDate?: Date;
  deliveryDueDate?: Date;
  venueName?: string;
  venueAddress?: string;
  venueCity?: string;
  totalQuotation?: Prisma.Decimal.Value;
  totalStorageCapacityGb?: Prisma.Decimal.Value;
  customServiceType?: string;
  otherClientDetails?: string;
  notes?: string;
  managerId?: string;
  events?: Array<{
    name: string;
    eventTypeId?: string;
    eventDate: Date;
    startTime?: Date;
    endTime?: Date;
    venueName?: string;
    address?: string;
    city?: string;
    notes?: string;
  }>;
  tasks?: Array<{
    title: string;
    description?: string;
    category?: TaskCategory;
    priority?: TaskPriority;
    quantity?: number;
    unit?: string;
    dueDate?: Date;
    assigneeId?: string;
    status?: TaskStatus;
  }>;
  shoots?: Array<{
    title: string;
    shootType?: ShootType;
    shootDate: Date;
    startTime?: Date;
    endTime?: Date;
    location?: string;
    city?: string;
    notes?: string;
    status?: ShootStatus;
    plannedRoleSlots?: Array<{ role: string; requiredCount: number; name?: string; mobile?: string; dataReceived?: boolean; dataSizeGb?: string; copyInHD?: string; backupInHD?: string }>;
    crewAssignments?: Array<{
      userId: string;
      role: CrewRole;
    }>;
  }>;
}

/**
 * Project creation is one atomic unit (§34): number allocation, the project
 * row, its wedding events, the opening status-history entry and the audit
 * record either all land or none do.
 */
export async function createProject(
  auth: AuthContext,
  input: CreateProjectInput,
  ctx: AuditRequestContext,
) {
  return prisma.$transaction(async (tx) => {
    if (!auth.permissions.has('PAYMENT_MILESTONE_MANAGE')) throw forbidden('PAYMENT_MILESTONE_MANAGE permission is required.');
    assertNestedCreatePermissions(auth, input);
    const clientId = await resolveProjectClient(tx, auth, input, ctx);

    if (input.branchId) {
      const branch = await tx.branch.findFirst({
        where: { id: input.branchId, organizationId: auth.organizationId, deletedAt: null },
        select: { id: true },
      });
      if (!branch) throw notFound('Branch');
    }

    const projectNumber = await nextDocumentNumber(tx, auth.organizationId, 'PROJECT');

    const project = await tx.project.create({
      data: {
        organizationId: auth.organizationId,
        branchId: input.branchId,
        clientId,
        leadId: input.leadId,
        projectNumber,
        name: input.name,
        type: input.type ?? 'WEDDING',
        status: input.status ?? ProjectStatus.UPCOMING,
        isUrgent: input.isUrgent ?? false,
        weddingDate: input.weddingDate,
        deliveryDueDate: input.deliveryDueDate,
        venueName: input.venueName,
        venueAddress: input.venueAddress,
        venueCity: input.venueCity,
        totalQuotation: input.totalQuotation ?? 0,
        totalStorageCapacityGb: input.totalStorageCapacityGb ?? 5000,
        customServiceType: input.customServiceType,
        otherClientDetails: input.otherClientDetails,
        notes: input.notes,
        managerId: input.managerId,
        createdById: auth.userId,
        completedAt: input.status === ProjectStatus.COMPLETED ? new Date() : undefined,
        cancelledAt: input.status === ProjectStatus.CANCELLED ? new Date() : undefined,
        events: input.events?.length
          ? {
              createMany: {
                data: input.events.map((e) => ({
                  organizationId: auth.organizationId,
                  name: e.name,
                  eventTypeId: e.eventTypeId,
                  eventDate: e.eventDate,
                  startTime: e.startTime,
                  endTime: e.endTime,
                  venueName: e.venueName,
                  address: e.address,
                  city: e.city,
                  notes: e.notes,
                })),
              },
            }
          : undefined,
      },
    });

    await tx.projectStatusHistory.create({
      data: {
        projectId: project.id,
        oldStatus: null,
        newStatus: input.status ?? ProjectStatus.UPCOMING,
        changedById: auth.userId,
        reason: 'Project created',
      },
    });

    if (input.tasks?.length) await createProjectTasks(tx, auth, project.id, project.name, clientId, input.tasks);
    if (input.shoots?.length) await createProjectShoots(tx, auth, project.id, input.shoots);

    const createdProject = await loadCreatedProject(tx, auth.organizationId, project.id);

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'Project',
      entityId: project.id,
      summary: `Project ${project.projectNumber} created`,
      newData: createdProject,
    });

    return createdProject;
  }, { timeout: 60_000, maxWait: 20_000 });
}

export async function updateProject(
  auth: AuthContext,
  id: string,
  input: Partial<Omit<CreateProjectInput, 'events' | 'clientId'>>,
  ctx: AuditRequestContext,
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.project.findFirst({
      where: scopedProjectWhere(auth, { id }),
    });
    if (!existing) throw notFound('Project');

    const updated = await tx.project.update({
      where: { id },
      data: {
        name: input.name,
        type: input.type,
        weddingDate: input.weddingDate,
        deliveryDueDate: input.deliveryDueDate,
        venueName: input.venueName,
        venueAddress: input.venueAddress,
        venueCity: input.venueCity,
        totalQuotation: input.totalQuotation,
        totalStorageCapacityGb: input.totalStorageCapacityGb,
        customServiceType: input.customServiceType,
        otherClientDetails: input.otherClientDetails,
        notes: input.notes,
        managerId: input.managerId,
        branchId: input.branchId,
        isUrgent: input.isUrgent,
      },
    });

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'Project',
      entityId: id,
      summary: 'Project updated',
      oldData: existing,
      newData: updated,
    });

    return updated;
  });
}

export async function changeProjectStatus(
  auth: AuthContext,
  id: string,
  newStatus: ProjectStatus,
  reason: string | undefined,
  ctx: AuditRequestContext,
) {
  return prisma.$transaction(async (tx) => {
    const project = await tx.project.findFirst({
      where: scopedProjectWhere(auth, { id }),
      select: { id: true, status: true, projectNumber: true },
    });
    if (!project) throw notFound('Project');

    if (project.status === newStatus) {
      throw conflict(`Project is already ${newStatus}`);
    }
    if (!ALLOWED_TRANSITIONS[project.status].includes(newStatus)) {
      throw badRequest(
        `Cannot move a project from ${project.status} to ${newStatus}`,
        [{ field: 'status', message: `Allowed: ${ALLOWED_TRANSITIONS[project.status].join(', ') || 'none'}` }],
      );
    }

    const updated = await tx.project.update({
      where: { id },
      data: {
        status: newStatus,
        completedAt: newStatus === 'COMPLETED' ? new Date() : undefined,
        cancelledAt: newStatus === 'CANCELLED' ? new Date() : undefined,
      },
    });

    await tx.projectStatusHistory.create({
      data: {
        projectId: id,
        oldStatus: project.status,
        newStatus,
        changedById: auth.userId,
        reason,
      },
    });

    await recordAudit(tx, ctx, {
      action: 'STATUS_CHANGE',
      entityType: 'Project',
      entityId: id,
      summary: `Project ${project.projectNumber}: ${project.status} -> ${newStatus}`,
      oldData: { status: project.status },
      newData: { status: newStatus, reason },
    });

    return updated;
  });
}

export async function deleteProject(auth: AuthContext, id: string, ctx: AuditRequestContext) {
  return prisma.$transaction(async (tx) => {
    const project = await tx.project.findFirst({
      where: scopedProjectWhere(auth, { id }),
      select: { id: true, projectNumber: true },
    });
    if (!project) throw notFound('Project');

    // A user-initiated delete is a permanent removal. Database foreign-key
    // actions remove project-owned records (shoots, tasks, deliveries, etc.)
    // and detach retained accounting records where the schema requires it.
    await tx.project.delete({ where: { id } });

    await recordAudit(tx, ctx, {
      action: 'DELETE',
      entityType: 'Project',
      entityId: id,
      summary: `Project ${project.projectNumber} permanently deleted`,
      oldData: project,
    });
  });
}

export async function getProjectStatusHistory(auth: AuthContext, projectId: string) {
  await assertCanAccessProject(auth, projectId);
  return prisma.projectStatusHistory.findMany({
    where: { project: { id: projectId, organizationId: auth.organizationId } },
    orderBy: { createdAt: 'desc' },
    include: { changedBy: { select: { id: true, fullName: true } } },
  });
}

export async function updateProjectDataBackup(
  auth: AuthContext,
  projectId: string,
  dataBackup: Record<string, unknown>,
  ctx: AuditRequestContext,
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.project.findFirst({
      where: scopedProjectWhere(auth, { id: projectId }),
      select: { id: true, otherClientDetails: true },
    });
    if (!existing) throw notFound('Project');
    let parsed: Record<string, unknown> = {};
    if (existing.otherClientDetails) {
      try {
        parsed = JSON.parse(existing.otherClientDetails);
      } catch {
        parsed = { customDetails: existing.otherClientDetails };
      }
    }
    const capacity = Number(dataBackup.totalStorageCapacityGb ?? dataBackup.totalStorageCapacityGB);
    const backupOnly = { ...dataBackup };
    delete backupOnly.totalStorageCapacityGb;
    delete backupOnly.totalStorageCapacityGB;
    parsed.dataBackup = backupOnly;
    const updated = await tx.project.update({
      where: { id: projectId },
      data: {
        otherClientDetails: JSON.stringify(parsed),
        ...(Number.isFinite(capacity) && capacity >= 0 ? { totalStorageCapacityGb: capacity } : {}),
      },
    });
    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'ProjectDataBackup',
      entityId: projectId,
      summary: 'Project data backup posture updated',
      newData: dataBackup,
    });
    return updated;
  });
}

export async function updateProjectDeliveries(
  auth: AuthContext,
  projectId: string,
  deliveryStatus: Record<string, unknown>,
  ctx: AuditRequestContext,
) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.project.findFirst({
      where: scopedProjectWhere(auth, { id: projectId }),
      select: { id: true, otherClientDetails: true },
    });
    if (!existing) throw notFound('Project');
    let parsed: Record<string, unknown> = {};
    if (existing.otherClientDetails) {
      try {
        parsed = JSON.parse(existing.otherClientDetails);
      } catch {
        parsed = { customDetails: existing.otherClientDetails };
      }
    }
    parsed.deliveryStatus = deliveryStatus;
    const updated = await tx.project.update({
      where: { id: projectId },
      data: { otherClientDetails: JSON.stringify(parsed) },
    });
    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'ProjectDeliveries',
      entityId: projectId,
      summary: 'Project delivery status updated',
      newData: deliveryStatus,
    });
    return updated;
  });
}
