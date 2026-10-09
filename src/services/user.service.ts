import { LogoutReason, Prisma, RoleStatus, SessionStatus, UserStatus } from '@prisma/client';
import { prisma, Tx } from '../config/prisma';
import { andWhere, findScoped, paginate, searchFilter } from '../repositories/base.repository';
import { resolveSort } from '../utils/pagination';
import { hashPassword } from '../utils/password';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors';
import { AuthContext } from '../types';
import { AuditRequestContext, recordAudit } from './audit.service';
import { revokeAllSessions } from './auth.service';

const SORTABLE = ['createdAt', 'fullName', 'email', 'lastLoginAt'] as const;
const EMPLOYEE_CODE_PREFIX = 'EMP-S';
const EMPLOYEE_CODE_PATTERN = /^EMP-S\d{2,}$/;
const EMPLOYEE_DIRECTORY_FILTER = { employeeProfile: { isNot: null } } as const;

const PUBLIC_SELECT = {
  id: true,
  organizationId: true,
  branchId: true,
  employeeCode: true,
  fullName: true,
  email: true,
  phone: true,
  status: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  userRoles: { select: { role: { select: { id: true, name: true, type: true } } } },
  employeeProfile: {
    select: {
      id: true,
      employmentType: true,
      joiningDate: true,
      monthlySalary: true,
      dailyRate: true,
      shiftStart: true,
      shiftEnd: true,
      workLocation: true,
      skills: true,
      department: { select: { id: true, name: true } },
      designation: { select: { id: true, title: true } },
    },
  },
} as const;

type PublicUser = {
  id: string;
  phone?: string | null;
  email?: string | null;
  employeeProfile?: {
    monthlySalary?: unknown;
    dailyRate?: unknown;
    skills?: string[];
  } | null;
};

async function nextEmployeeCode(tx: Tx, organizationId: string): Promise<string> {
  const lockKey = `employee-code:${organizationId}`;

  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', lockKey);

  const rows = await tx.$queryRawUnsafe<{ max_seq: number | null }[]>(
    `SELECT MAX(CAST(SUBSTRING("employee_code" FROM '[0-9]+$') AS INTEGER)) AS max_seq
       FROM "users"
      WHERE "organization_id" = $1::uuid
        AND "employee_code" LIKE $2`,
    organizationId,
    `${EMPLOYEE_CODE_PREFIX}%`,
  );

  const next = (rows[0]?.max_seq ?? 0) + 1;
  return `${EMPLOYEE_CODE_PREFIX}${String(next).padStart(2, '0')}`;
}

function normalizeEmployeeCode(input?: string): string | undefined {
  const value = input?.trim().toUpperCase();
  if (!value) return undefined;
  if (!EMPLOYEE_CODE_PATTERN.test(value)) {
    throw badRequest('Employee ID must use the format EMP-S01');
  }
  return value;
}

async function assertEmployeeCodeAvailable(
  tx: Tx,
  organizationId: string,
  employeeCode: string,
  exceptUserId?: string,
): Promise<void> {
  const existing = await tx.user.findFirst({
    where: {
      organizationId,
      employeeCode,
      ...(exceptUserId ? { id: { not: exceptUserId } } : {}),
    },
    select: { id: true },
  });
  if (existing) throw conflict('Employee ID is already in use');
}

function isEmployeeCodeUniqueConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;
  const target = error.meta?.target;
  return Array.isArray(target) && target.includes('employee_code');
}

export async function listUsers(
  auth: AuthContext,
  query: {
    page?: number;
    limit?: number;
    search?: string;
    status?: UserStatus;
    branchId?: string;
    roleId?: string;
    departmentId?: string;
    sortBy?: string;
    sortOrder?: string;
  },
) {
  const canViewAllTeam =
    auth.permissions.has('TEAM_VIEW_ALL') ||
    auth.permissions.has('TEAM_VIEW') ||
    auth.permissions.has('USER_VIEW');
  const canViewSelf =
    canViewAllTeam ||
    auth.permissions.has('TEAM_VIEW_SELF') ||
    auth.permissions.has('EMPLOYEE_PROFILE_VIEW');
  if (!canViewSelf) throw forbidden('You do not have permission to view team members');

  const sort = resolveSort(query.sortBy, query.sortOrder, SORTABLE, 'createdAt');
  const result = await paginate(prisma.user, {
    where: andWhere(
      { organizationId: auth.organizationId, deletedAt: null },
      EMPLOYEE_DIRECTORY_FILTER,
      canViewAllTeam ? undefined : { id: auth.userId },
      query.status ? { status: query.status } : undefined,
      query.branchId ? { branchId: query.branchId } : undefined,
      query.roleId ? { userRoles: { some: { roleId: query.roleId } } } : undefined,
      query.departmentId
        ? { employeeProfile: { departmentId: query.departmentId } }
        : undefined,
      searchFilter(query.search, ['fullName', 'email', 'employeeCode', 'phone']),
    ),
    orderBy: { [sort.field]: sort.direction },
    page: query.page,
    limit: query.limit,
    select: PUBLIC_SELECT,
  });
  return {
    ...result,
    items: (result.items as PublicUser[]).map((user) => redactUserForAuth(user, auth)),
  };
}

export function getUser(
  organizationId: string,
  id: string,
  db: { user: typeof prisma.user } = prisma,
) {
  // PUBLIC_SELECT deliberately omits passwordHash — it never leaves the DB (§37).
  return db.user.findFirst({
    where: {
      id,
      organizationId,
      deletedAt: null,
      ...EMPLOYEE_DIRECTORY_FILTER,
    },
    select: PUBLIC_SELECT,
  }).then((user) => {
    if (!user) throw notFound('User');
    return user;
  });
}

export async function getUserForAuth(auth: AuthContext, id: string) {
  const canViewOwnProfile =
    id === auth.userId &&
    (
      auth.permissions.has('TEAM_VIEW_SELF') ||
      auth.permissions.has('TEAM_VIEW') ||
      auth.permissions.has('TEAM_VIEW_ALL') ||
      auth.permissions.has('EMPLOYEE_PROFILE_VIEW') ||
      auth.permissions.has('USER_VIEW')
    );
  const canViewOtherProfile =
    id !== auth.userId &&
    (
      auth.permissions.has('EMPLOYEE_PROFILE_VIEW') ||
      auth.permissions.has('USER_VIEW')
    );
  if (!canViewOwnProfile && !canViewOtherProfile) {
    throw forbidden(id === auth.userId ? 'You do not have permission to view your employee profile' : 'You do not have permission to view employee profiles');
  }
  const user = await getUser(auth.organizationId, id) as PublicUser;
  return redactUserForAuth(user, auth);
}

function redactUserForAuth<T extends PublicUser>(
  user: T,
  auth: AuthContext,
): T {
  const canViewSelf = user.id === auth.userId;
  const canViewContact =
    canViewSelf ||
    auth.permissions.has('EMPLOYEE_CONTACT_VIEW') ||
    auth.permissions.has('TEAM_VIEW_ALL') ||
    auth.permissions.has('USER_VIEW');
  const canViewSalary =
    auth.permissions.has('EMPLOYEE_SALARY_VIEW') ||
    auth.permissions.has('EMPLOYEE_SALARY_MANAGE');
  const canViewSensitive =
    auth.permissions.has('EMPLOYEE_PROFILE_VIEW_SENSITIVE') ||
    auth.permissions.has('TEAM_VIEW_ALL') ||
    auth.permissions.has('USER_VIEW');

  const next: T = {
    ...user,
    phone: canViewContact ? user.phone : null,
    email: canViewContact ? user.email : null,
    employeeProfile: user.employeeProfile
      ? {
          ...user.employeeProfile,
          monthlySalary: canViewSalary ? user.employeeProfile.monthlySalary : null,
          dailyRate: canViewSalary ? user.employeeProfile.dailyRate : null,
          skills: canViewSensitive || canViewSelf ? user.employeeProfile.skills : [],
        }
      : user.employeeProfile,
  };
  return next;
}

export interface CreateUserInput {
  fullName: string;
  email: string;
  password: string;
  phone?: string;
  employeeCode?: string;
  branchId?: string;
  roleIds: string[];
  profile?: {
    departmentId?: string;
    designationId?: string;
    employmentType?: 'FULL_TIME' | 'PART_TIME' | 'CONTRACT' | 'INTERN';
    joiningDate?: Date;
    monthlySalary?: number;
    dailyRate?: number;
    shiftStart?: string;
    shiftEnd?: string;
    workLocation?: 'OFFICE' | 'WFH' | 'HYBRID' | 'ON_SHOOT';
    skills?: string[];
    reportingManagerId?: string;
  };
}

type RoleReader = Pick<typeof prisma.role, 'findMany'>;

/**
 * The single gate for handing out authority (§16). Every caller that writes
 * `user_roles` goes through this, so the checks cannot be bypassed by using a
 * different endpoint:
 *
 *   1. the role exists, is not soft-deleted, and belongs to the actor's studio
 *   2. the role is ACTIVE — a suspended role must not gain new holders
 *   3. the actor already holds every permission the role grants, so nobody can
 *      escalate privilege by assigning a stronger role to an account they
 *      control
 */
async function assertAssignableRoles(
  db: RoleReader,
  auth: AuthContext,
  roleIds: string[],
  targetUserId?: string,
): Promise<Array<{ id: string; name: string }>> {
  const roles = await db.findMany({
    where: { id: { in: roleIds }, organizationId: auth.organizationId, deletedAt: null },
    select: {
      id: true,
      name: true,
      status: true,
      personalForUserId: true,
      rolePermissions: { select: { permission: { select: { key: true } } } },
    },
  });
  if (roles.length !== roleIds.length) throw badRequest('One or more roles are invalid');


  // A personal role holds one employee's own permission set; handing it to a
  // colleague would silently change access for both of them.
  const foreign = roles.filter(
    (role) => role.personalForUserId && role.personalForUserId !== targetUserId,
  );
  if (foreign.length > 0) {
    throw conflict(
      `Role(s) ${foreign.map((r) => `"${r.name}"`).join(', ')} belong to one specific ` +
        'employee and cannot be assigned to anyone else',
    );
  }

  const inactive = roles.filter((role) => role.status !== RoleStatus.ACTIVE);
  if (inactive.length > 0) {
    throw conflict(
      `Cannot assign inactive role(s): ${inactive.map((r) => r.name).join(', ')}`,
    );
  }

  for (const role of roles) {
    const escalating = role.rolePermissions
      .map((rp) => rp.permission.key)
      .filter((key) => !auth.permissions.has(key));
    if (escalating.length > 0) {
      throw forbidden(
        `You are not allowed to assign the role "${role.name}" because it grants ` +
          'permissions you do not hold',
      );
    }
  }

  return roles.map(({ id, name }) => ({ id, name }));
}

/**
 * User writes run several sequential queries inside one interactive
 * transaction. Prisma's 5 s default expires under real pooled-DB latency
 * (P2028 surfaced as a 500), so these match the 15 s budget in utils/transaction.
 */
const USER_TX_OPTIONS = { maxWait: 10_000, timeout: 15_000 } as const;

export async function createUser(auth: AuthContext, input: CreateUserInput, ctx: AuditRequestContext) {
  if (input.roleIds.length === 0) throw badRequest('At least one role must be assigned');

  // CPU-bound hashing needs no DB round trip, so it stays outside the transaction.
  const passwordHash = await hashPassword(input.password);

  return prisma.$transaction(async (tx) => {
    await assertAssignableRoles(tx.role, auth, input.roleIds);

    const email = input.email.toLowerCase();
    const existing = await tx.user.findFirst({
      where: { organizationId: auth.organizationId, email },
      select: { id: true },
    });
    if (existing) throw conflict('A user with this email already exists in the organization');

    const manualEmployeeCode = normalizeEmployeeCode(input.employeeCode);
    if (manualEmployeeCode) {
      await assertEmployeeCodeAvailable(tx, auth.organizationId, manualEmployeeCode);
    }
    const employeeCode = manualEmployeeCode || await nextEmployeeCode(tx, auth.organizationId);

    const user = await tx.user.create({
      data: {
        organizationId: auth.organizationId,
        branchId: input.branchId,
        fullName: input.fullName,
        email,
        phone: input.phone,
        employeeCode,
        passwordHash,
        userRoles: {
          createMany: {
            data: input.roleIds.map((roleId) => ({ roleId, assignedBy: auth.userId })),
          },
        },
        // Every CRM user is a staff member, and every read path filters the
        // directory on EMPLOYEE_DIRECTORY_FILTER. Creating a user without a
        // profile left it invisible to GET /team and made a role change commit
        // and then answer 404, so the profile is always created.
        employeeProfile: { create: input.profile ?? {} },
      },
      select: PUBLIC_SELECT,
    });

    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'User',
      entityId: user.id,
      summary: `User ${email} created`,
      newData: user,
    });

    return user;
  }, USER_TX_OPTIONS).catch((error: unknown) => {
    if (isEmployeeCodeUniqueConflict(error)) throw conflict('Employee ID is already in use');
    throw error;
  });
}

export async function updateUser(
  auth: AuthContext,
  id: string,
  input: Partial<Omit<CreateUserInput, 'password' | 'roleIds' | 'email'>> & { status?: UserStatus },
  ctx: AuditRequestContext,
) {
  return prisma.$transaction(async (tx) => {
    const existing = await findScoped<{ id: string; status: UserStatus }>(
      tx.user,
      auth.organizationId,
      id,
      'User',
      { select: { id: true, status: true } },
    );

    const employeeCode = input.employeeCode === undefined
      ? undefined
      : normalizeEmployeeCode(input.employeeCode);
    if (employeeCode) {
      await assertEmployeeCodeAvailable(tx, auth.organizationId, employeeCode, id);
    }

    const updated = await tx.user.update({
      where: { id },
      data: {
        fullName: input.fullName,
        phone: input.phone,
        employeeCode,
        branchId: input.branchId,
        status: input.status,
        employeeProfile: input.profile
          ? { upsert: { create: input.profile, update: input.profile } }
          : undefined,
      },
      select: PUBLIC_SELECT,
    });

    // Deactivating an account must take effect immediately, not at token expiry.
    if (input.status && input.status !== 'ACTIVE' && existing.status === 'ACTIVE') {
      await tx.session.updateMany({
        where: { userId: id, status: SessionStatus.ACTIVE },
        data: { status: SessionStatus.REVOKED, revokedAt: new Date(), revokeReason: LogoutReason.ADMIN_REVOKED },
      });
    }

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'User',
      entityId: id,
      summary: 'User updated',
      oldData: existing,
      newData: updated,
    });

    return updated;
  }, USER_TX_OPTIONS).catch((error: unknown) => {
    if (isEmployeeCodeUniqueConflict(error)) throw conflict('Employee ID is already in use');
    throw error;
  });
}

export async function upsertSalaryPayment(auth: AuthContext, userId: string, input: { paymentMonth: string; baseSalary: number; paidAmount: number; notes?: string; installments?: unknown }) {
  await findScoped(prisma.user, auth.organizationId, userId, 'User', { select: { id: true } });
  return prisma.staffSalaryPayment.upsert({
    where: { organizationId_userId_paymentMonth: { organizationId: auth.organizationId, userId, paymentMonth: input.paymentMonth } },
    create: { organizationId: auth.organizationId, userId, paymentMonth: input.paymentMonth, baseSalary: input.baseSalary, paidAmount: input.paidAmount, notes: input.notes, installments: input.installments as Prisma.InputJsonValue },
    update: { baseSalary: input.baseSalary, paidAmount: input.paidAmount, notes: input.notes, installments: input.installments as Prisma.InputJsonValue },
  });
}

export function listSalaryPayments(organizationId: string, paymentMonth?: string) {
  return prisma.staffSalaryPayment.findMany({ where: { organizationId, ...(paymentMonth ? { paymentMonth } : {}) }, orderBy: { updatedAt: 'desc' } });
}

export async function setUserRoles(
  auth: AuthContext,
  id: string,
  roleIds: string[],
  ctx: AuditRequestContext,
) {
  if (roleIds.length === 0) throw badRequest('A user must keep at least one role');

  return prisma.$transaction(async (tx) => {
    await findScoped(tx.user, auth.organizationId, id, 'User', { select: { id: true } });

    const roles = await assertAssignableRoles(tx.role, auth, roleIds, id);

    const before = await tx.userRole.findMany({
      where: { userId: id },
      select: { role: { select: { name: true } } },
    });

    await tx.userRole.deleteMany({ where: { userId: id } });
    await tx.userRole.createMany({
      data: roleIds.map((roleId) => ({ userId: id, roleId, assignedBy: auth.userId })),
    });

    await recordAudit(tx, ctx, {
      action: 'ROLE_CHANGED',
      entityType: 'User',
      entityId: id,
      summary: `Roles set to ${roles.map((r) => r.name).join(', ')}`,
      oldData: { roles: before.map((b) => b.role.name) },
      newData: { roles: roles.map((r) => r.name) },
    });

    // Inside the transaction, so the response carries the new role set.
    return getUser(auth.organizationId, id, tx);
  });
}

export async function resetUserPassword(
  auth: AuthContext,
  id: string,
  newPassword: string,
  ctx: AuditRequestContext,
) {
  const user = await findScoped<{ id: string; email: string }>(
    prisma.user,
    auth.organizationId,
    id,
    'User',
    { select: { id: true, email: true } },
  );

  await prisma.user.update({
    where: { id },
    data: { passwordHash: await hashPassword(newPassword), passwordChangedAt: new Date() },
  });
  await revokeAllSessions(id, LogoutReason.PASSWORD_CHANGED);

  await recordAudit(prisma, ctx, {
    action: 'UPDATE',
    entityType: 'User',
    entityId: id,
    summary: `Password reset for ${user.email}; sessions revoked`,
  });
}

export async function deleteUser(auth: AuthContext, id: string, ctx: AuditRequestContext) {
  if (id === auth.userId) throw conflict('You cannot delete your own account');

  return prisma.$transaction(async (tx) => {
    const user = await findScoped<{ id: string; email: string }>(
      tx.user,
      auth.organizationId,
      id,
      'User',
      { select: { id: true, email: true } },
    );

    // This is deliberately a hard delete.  Employee profile, attendance,
    // sessions, roles, settings, access requests, personal work data and
    // notifications are cascade-related in the database.  Shoot assignments
    // and salary records need explicit removal because they are not cascade
    // relations, and must be cleared before the user row to satisfy FKs.
    await tx.shootAssignment.deleteMany({ where: { userId: id } });
    await tx.staffSalaryPayment.deleteMany({ where: { organizationId: auth.organizationId, userId: id } });
    await tx.fileObject.deleteMany({
      where: {
        organizationId: auth.organizationId,
        OR: [
          { entityId: id },
          { uploadedById: id, entityType: { in: ['USER', 'EMPLOYEE', 'EMPLOYEE_DOCUMENT'] } },
        ],
      },
    });
    await tx.user.delete({ where: { id } });

    await recordAudit(tx, ctx, {
      action: 'DELETE',
      entityType: 'User',
      entityId: id,
      summary: `User ${user.email} permanently deleted with employee-dependent data`,
      oldData: user,
    });
  });
}
