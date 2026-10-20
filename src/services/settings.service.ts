import { ModuleAccessRequestStatus, Prisma, RoleStatus, RoleType } from '@prisma/client';
import { Tx, prisma } from '../config/prisma';
import { AuthContext } from '../types';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors';
import { AuditRequestContext, recordAudit } from './audit.service';
import * as authService from './auth.service';
import * as platformService from './platform.service';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  DEFAULT_SECURITY_PREFERENCES,
  SETTINGS_MODULES,
  SecurityPreferences,
  SettingsModuleDefinition,
  findSettingsModule,
} from '../types/settingsModules';

/**
 * The Settings workspace.
 *
 * Two rules shape everything below:
 *   1. Settings owns no second copy of a fact another module owns. Studio
 *      identity is read and written on `Organization`, employee identity on
 *      `User`, and module access in the existing RBAC tables. Only the genuinely
 *      Settings-specific extras live in `organization_settings` /
 *      `user_settings`.
 *   2. Approving a module request grants permissions through
 *      `Role` -> `RolePermission` -> `UserRole` — the same rows the Roles &
 *      Permissions desk edits — so the two screens can never disagree (§6).
 */

/**
 * Who may act on the studio rather than only on themselves. Mirrors what the
 * Settings UI already treats as an admin; the mutations themselves are gated by
 * the specific permission each route names, never by this flag.
 */
const isAdmin = (auth: AuthContext): boolean =>
  auth.permissions.has('ORG_UPDATE') || auth.permissions.has('SETTING_UPDATE');

/** A caller with this key is the one who may approve or reject a request. */
const REVIEW_PERMISSION = 'PERMISSION_ASSIGN';

// --- Stored preference shapes ---------------------------------------------

/**
 * Defaults are merged in on read, not written on create, so adding a switch to
 * the catalogue turns it on for everyone without a backfill, and a switch the
 * employee has actually set always wins.
 */
function mergeNotifications(stored: Prisma.JsonValue | null | undefined): Record<string, boolean> {
  const saved =
    stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  const merged: Record<string, boolean> = { ...DEFAULT_NOTIFICATION_PREFERENCES };
  for (const [key, value] of Object.entries(saved)) {
    if (typeof value === 'boolean') merged[key] = value;
  }
  return merged;
}

function mergeSecurity(stored: Prisma.JsonValue | null | undefined): SecurityPreferences {
  const saved =
    stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  return {
    sessionTimeoutMinutes:
      typeof saved.sessionTimeoutMinutes === 'number'
        ? saved.sessionTimeoutMinutes
        : DEFAULT_SECURITY_PREFERENCES.sessionTimeoutMinutes,
    notifyNewLogin:
      typeof saved.notifyNewLogin === 'boolean'
        ? saved.notifyNewLogin
        : DEFAULT_SECURITY_PREFERENCES.notifyNewLogin,
  };
}

/** An empty string from a cleared form field means "unset", not "set to ''". */
const nullable = (value: string | undefined): string | null | undefined =>
  value === undefined ? undefined : value === '' ? null : value;

// --- Module catalogue view -------------------------------------------------

const toModuleSummary = (module: SettingsModuleDefinition) => ({
  key: module.key,
  label: module.label,
  description: module.description,
});

/** A module counts as granted only when the holder has *every* key it bundles. */
const holdsModule = (permissions: Set<string>, module: SettingsModuleDefinition): boolean =>
  module.permissionKeys.every((key) => permissions.has(key));

function splitModules(permissions: Set<string>) {
  const granted = SETTINGS_MODULES.filter((module) => holdsModule(permissions, module));
  const available = SETTINGS_MODULES.filter((module) => !holdsModule(permissions, module));
  return { grantedModules: granted.map(toModuleSummary), availableModules: available.map(toModuleSummary) };
}

// --- Serialization ---------------------------------------------------------

type RequestRow = Prisma.ModuleAccessRequestGetPayload<{
  include: {
    employee: { select: { fullName: true; email: true } };
    reviewedBy: { select: { fullName: true } };
  };
}>;

function toRequestResponse(row: RequestRow) {
  const module = findSettingsModule(row.moduleKey);
  return {
    id: row.id,
    employeeName: row.employee.fullName,
    employeeEmail: row.employee.email,
    moduleKey: row.moduleKey,
    // A module retired from the catalogue still has to render in the history.
    moduleLabel: module?.label ?? row.moduleKey,
    reason: row.reason,
    status: row.status,
    createdAt: row.createdAt,
    reviewedAt: row.reviewedAt,
    reviewerName: row.reviewedBy?.fullName ?? null,
    reviewReason: row.reviewReason,
  };
}

const REQUEST_INCLUDE = {
  employee: { select: { fullName: true, email: true } },
  reviewedBy: { select: { fullName: true } },
} as const;

// --- Workspace -------------------------------------------------------------

export async function getWorkspace(auth: AuthContext) {
  const admin = isAdmin(auth);

  // One round trip per independent read rather than four sequential ones (§27).
  const [user, organization, organizationSetting, requests] = await Promise.all([
    prisma.user.findFirst({
      where: { id: auth.userId, deletedAt: null },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        userSetting: { select: { avatarUrl: true, notifications: true, security: true } },
      },
    }),
    prisma.organization.findFirst({
      where: { id: auth.organizationId, deletedAt: null },
      select: { name: true, email: true, phone: true, timezone: true, currency: true },
    }),
    prisma.organizationSetting.findUnique({
      where: { organizationId: auth.organizationId },
      select: { logoUrl: true, dateFormat: true },
    }),
    prisma.moduleAccessRequest.findMany({
      // An employee sees their own history; a reviewer sees the studio queue.
      where: auth.permissions.has(REVIEW_PERMISSION)
        ? { organizationId: auth.organizationId }
        : { organizationId: auth.organizationId, employeeId: auth.userId },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      include: REQUEST_INCLUDE,
      take: 200,
    }),
  ]);

  if (!user) throw notFound('User');

  return {
    viewer: {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      phone: user.phone,
      imageUrl: user.userSetting?.avatarUrl ?? null,
      isAdmin: admin,
    },
    organization: organization
      ? {
          name: organization.name,
          logoUrl: organizationSetting?.logoUrl ?? null,
          contactEmail: organization.email,
          contactPhone: organization.phone,
          timezone: organization.timezone,
          currency: organization.currency,
          dateFormat: organizationSetting?.dateFormat ?? null,
        }
      : undefined,
    notifications: mergeNotifications(user.userSetting?.notifications),
    security: mergeSecurity(user.userSetting?.security),
    ...splitModules(auth.permissions),
    requests: requests.map(toRequestResponse),
  };
}

// --- Profile ---------------------------------------------------------------

export async function updateProfile(
  auth: AuthContext,
  input: { fullName: string; phone?: string; imageUrl?: string },
  ctx: AuditRequestContext,
) {
  const before = await prisma.user.findFirst({
    where: { id: auth.userId, deletedAt: null },
    select: { fullName: true, phone: true, userSetting: { select: { avatarUrl: true } } },
  });
  if (!before) throw notFound('User');

  const avatarUrl = nullable(input.imageUrl);

  const user = await prisma.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id: auth.userId },
      data: { fullName: input.fullName, phone: nullable(input.phone) },
      select: { id: true, fullName: true, email: true, phone: true },
    });

    // Only touch the settings row when the avatar is actually part of the edit,
    // so saving the name never silently clears a picture.
    if (avatarUrl !== undefined) {
      await tx.userSetting.upsert({
        where: { userId: auth.userId },
        create: { userId: auth.userId, avatarUrl },
        update: { avatarUrl },
      });
    }

    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'User',
      entityId: auth.userId,
      summary: 'Profile updated from Settings',
      oldData: { fullName: before.fullName, phone: before.phone, imageUrl: before.userSetting?.avatarUrl ?? null },
      newData: { fullName: updated.fullName, phone: updated.phone, imageUrl: avatarUrl },
    });

    return updated;
  });

  const imageUrl = avatarUrl === undefined ? before.userSetting?.avatarUrl ?? null : avatarUrl;
  return { ...user, imageUrl, isAdmin: isAdmin(auth) };
}

// --- Organization ----------------------------------------------------------

export async function updateOrganizationSettings(
  auth: AuthContext,
  input: {
    name?: string;
    logoUrl?: string;
    contactEmail?: string;
    contactPhone?: string;
    timezone?: string;
    currency?: string;
    dateFormat?: string;
  },
  ctx: AuditRequestContext,
) {
  // Studio identity keeps its existing owner: the same service and the same
  // audit entry the Organization screen already produces. Settings adds no
  // second write path for a field other modules read.
  const organizationFields: Record<string, unknown> = {};
  if (input.name !== undefined) organizationFields.name = input.name;
  if (input.contactEmail !== undefined) organizationFields.email = nullable(input.contactEmail);
  if (input.contactPhone !== undefined) organizationFields.phone = nullable(input.contactPhone);
  if (input.timezone !== undefined) organizationFields.timezone = input.timezone;
  if (input.currency !== undefined) organizationFields.currency = input.currency;

  if (Object.keys(organizationFields).length > 0) {
    await platformService.updateOrganization(auth, organizationFields, ctx);
  }

  const hasExtras = input.logoUrl !== undefined || input.dateFormat !== undefined;
  if (hasExtras) {
    const extras = {
      ...(input.logoUrl !== undefined ? { logoUrl: nullable(input.logoUrl) } : {}),
      ...(input.dateFormat !== undefined ? { dateFormat: nullable(input.dateFormat) } : {}),
    };
    await prisma.organizationSetting.upsert({
      where: { organizationId: auth.organizationId },
      create: { organizationId: auth.organizationId, ...extras },
      update: extras,
    });
  }

  const [organization, setting] = await Promise.all([
    prisma.organization.findFirst({
      where: { id: auth.organizationId, deletedAt: null },
      select: { name: true, email: true, phone: true, timezone: true, currency: true },
    }),
    prisma.organizationSetting.findUnique({
      where: { organizationId: auth.organizationId },
      select: { logoUrl: true, dateFormat: true },
    }),
  ]);
  if (!organization) throw notFound('Organization');

  return {
    name: organization.name,
    logoUrl: setting?.logoUrl ?? null,
    contactEmail: organization.email,
    contactPhone: organization.phone,
    timezone: organization.timezone,
    currency: organization.currency,
    dateFormat: setting?.dateFormat ?? null,
  };
}

// --- Preferences -----------------------------------------------------------

export async function updatePreferences(
  auth: AuthContext,
  input: { notifications?: Record<string, boolean>; security?: SecurityPreferences },
  ctx: AuditRequestContext,
) {
  const existing = await prisma.userSetting.findUnique({
    where: { userId: auth.userId },
    select: { notifications: true, security: true },
  });

  // Merge rather than replace: the screen posts only the section it edited, and
  // a partial save must not wipe the toggles it never rendered.
  const notifications = input.notifications
    ? { ...mergeNotifications(existing?.notifications), ...input.notifications }
    : mergeNotifications(existing?.notifications);
  const security = input.security
    ? { ...mergeSecurity(existing?.security), ...input.security }
    : mergeSecurity(existing?.security);

  // `SecurityPreferences` is a named shape, which jsonb columns will not accept
  // without an index signature; the values are already validated.
  const securityJson = security as unknown as Prisma.InputJsonObject;

  await prisma.$transaction(async (tx) => {
    await tx.userSetting.upsert({
      where: { userId: auth.userId },
      create: { userId: auth.userId, notifications, security: securityJson },
      update: { notifications, security: securityJson },
    });
    await recordAudit(tx, ctx, {
      action: 'UPDATE',
      entityType: 'UserSetting',
      entityId: auth.userId,
      summary: 'Notification and security preferences updated',
      oldData: {
        notifications: mergeNotifications(existing?.notifications),
        security: mergeSecurity(existing?.security),
      },
      newData: { notifications, security },
    });
  });

  return { notifications, security };
}

// --- Password --------------------------------------------------------------

/**
 * Delegates to the existing account service, so Settings and `/auth` share one
 * password policy, one "current password is wrong" answer and one
 * revoke-other-sessions rule.
 */
export async function changePassword(
  auth: AuthContext,
  input: { currentPassword: string; newPassword: string },
  meta: authService.RequestMeta,
): Promise<void> {
  await authService.changePassword(auth.userId, input.currentPassword, input.newPassword, meta);
}

// --- Module access requests ------------------------------------------------

export async function listModuleAccessRequests(
  auth: AuthContext,
  query: { status?: ModuleAccessRequestStatus } = {},
) {
  const rows = await prisma.moduleAccessRequest.findMany({
    where: {
      organizationId: auth.organizationId,
      ...(auth.permissions.has(REVIEW_PERMISSION) ? {} : { employeeId: auth.userId }),
      ...(query.status ? { status: query.status } : {}),
    },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    include: REQUEST_INCLUDE,
    take: 200,
  });
  return rows.map(toRequestResponse);
}

export async function createModuleAccessRequest(
  auth: AuthContext,
  input: { moduleKey: string; reason: string },
  ctx: AuditRequestContext,
) {
  const module = findSettingsModule(input.moduleKey);
  if (!module) {
    throw badRequest('Unknown module', [{ field: 'moduleKey', message: input.moduleKey }]);
  }

  // Asking for access already held would create a request nobody can act on.
  if (holdsModule(auth.permissions, module)) {
    throw conflict(`You already have access to ${module.label}`, [
      { field: 'moduleKey', message: 'Access already granted' },
    ]);
  }

  const pending = await prisma.moduleAccessRequest.findFirst({
    where: {
      employeeId: auth.userId,
      moduleKey: module.key,
      status: ModuleAccessRequestStatus.PENDING,
    },
    select: { id: true },
  });
  if (pending) {
    throw conflict(`A request for ${module.label} is already awaiting review`, [
      { field: 'moduleKey', message: 'Duplicate request' },
    ]);
  }

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.moduleAccessRequest.create({
      data: {
        organizationId: auth.organizationId,
        employeeId: auth.userId,
        moduleKey: module.key,
        reason: input.reason,
      },
      include: REQUEST_INCLUDE,
    });
    await recordAudit(tx, ctx, {
      action: 'CREATE',
      entityType: 'ModuleAccessRequest',
      entityId: row.id,
      summary: `${auth.fullName} requested access to ${module.label}`,
      newData: { moduleKey: module.key, reason: input.reason },
    });
    return row;
  });

  return toRequestResponse(created);
}

/**
 * Grants a module's permission keys through the existing RBAC tables.
 *
 * The keys land on the employee's *personal* role — the same construct the
 * Roles desk creates with `personalForUserId` — so one employee gaining a
 * module never widens access for colleagues who share a job-title role.
 */
async function grantModuleViaRbac(
  tx: Tx,
  auth: AuthContext,
  employee: { id: string; fullName: string },
  module: SettingsModuleDefinition,
): Promise<{ roleId: string; addedKeys: string[] }> {
  const permissions = await tx.permission.findMany({
    where: { key: { in: module.permissionKeys } },
    select: { id: true, key: true },
  });
  const missing = module.permissionKeys.filter((key) => !permissions.some((p) => p.key === key));
  if (missing.length > 0) {
    // The catalogue names a key the database has never been seeded with, so the
    // approval would appear to succeed while granting nothing.
    throw badRequest(`Permission catalogue is missing: ${missing.join(', ')}`);
  }

  let role = await tx.role.findFirst({
    where: {
      organizationId: auth.organizationId,
      personalForUserId: employee.id,
      deletedAt: null,
      status: RoleStatus.ACTIVE,
    },
    select: { id: true, name: true },
  });

  if (!role) {
    // Role names are unique per studio, so a collision (two employees sharing a
    // name) falls back to a suffixed name rather than failing the approval.
    const base = `${employee.fullName} — Personal Access`.slice(0, 64);
    const taken = await tx.role.findFirst({
      where: { organizationId: auth.organizationId, name: base },
      select: { id: true },
    });
    const name = taken ? `${base.slice(0, 55)} ${employee.id.slice(0, 8)}` : base;

    role = await tx.role.create({
      data: {
        organizationId: auth.organizationId,
        name,
        description: `Personal access for ${employee.fullName}, granted from Settings.`,
        type: RoleType.CUSTOM,
        status: RoleStatus.ACTIVE,
        personalForUserId: employee.id,
      },
      select: { id: true, name: true },
    });
  }

  // Idempotent: re-approving a module the employee already holds is a no-op
  // rather than a unique-constraint error.
  await tx.userRole.createMany({
    data: [{ userId: employee.id, roleId: role.id, assignedBy: auth.userId }],
    skipDuplicates: true,
  });

  const existingKeys = new Set(
    (
      await tx.rolePermission.findMany({
        where: { roleId: role.id, permissionId: { in: permissions.map((p) => p.id) } },
        select: { permission: { select: { key: true } } },
      })
    ).map((rp) => rp.permission.key),
  );
  const added = permissions.filter((p) => !existingKeys.has(p.key));

  if (added.length > 0) {
    await tx.rolePermission.createMany({
      data: added.map((p) => ({ roleId: role!.id, permissionId: p.id })),
      skipDuplicates: true,
    });
  }

  return { roleId: role.id, addedKeys: added.map((p) => p.key).sort() };
}

export async function reviewModuleAccessRequest(
  auth: AuthContext,
  id: string,
  input: { status: 'APPROVED' | 'REJECTED'; reviewReason?: string },
  ctx: AuditRequestContext,
) {
  const request = await prisma.moduleAccessRequest.findFirst({
    where: { id, organizationId: auth.organizationId },
    include: { ...REQUEST_INCLUDE, employee: { select: { id: true, fullName: true, email: true, deletedAt: true } } },
  });
  if (!request) throw notFound('Module access request');

  if (request.status !== ModuleAccessRequestStatus.PENDING) {
    throw conflict(`This request was already ${request.status.toLowerCase()}`, [
      { field: 'status', message: 'Only a pending request can be reviewed' },
    ]);
  }
  if (request.employeeId === auth.userId) {
    // Otherwise a reviewer could grant themselves any module in the catalogue.
    throw forbidden('You cannot review your own access request');
  }
  if (request.employee.deletedAt !== null) {
    throw conflict('The employee who raised this request no longer exists');
  }

  const module = findSettingsModule(request.moduleKey);
  if (!module) {
    throw badRequest(`Module "${request.moduleKey}" is no longer available`, [
      { field: 'moduleKey', message: 'Unknown module' },
    ]);
  }

  if (input.status === 'APPROVED') {
    // The same escalation rule the Roles desk enforces (§16): an actor can
    // never hand out authority it does not itself hold.
    const escalating = module.permissionKeys.filter((key) => !auth.permissions.has(key));
    if (escalating.length > 0) {
      throw forbidden(
        `You cannot grant permissions you do not hold: ${escalating.sort().join(', ')}`,
      );
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    let grant: { roleId: string; addedKeys: string[] } | null = null;
    if (input.status === 'APPROVED') {
      grant = await grantModuleViaRbac(
        tx,
        auth,
        { id: request.employee.id, fullName: request.employee.fullName },
        module,
      );
    }

    const row = await tx.moduleAccessRequest.update({
      where: { id },
      data: {
        status:
          input.status === 'APPROVED'
            ? ModuleAccessRequestStatus.APPROVED
            : ModuleAccessRequestStatus.REJECTED,
        reviewedById: auth.userId,
        reviewedAt: new Date(),
        reviewReason: input.reviewReason ?? null,
      },
      include: REQUEST_INCLUDE,
    });

    await recordAudit(tx, ctx, {
      action: input.status === 'APPROVED' ? 'APPROVE' : 'REJECT',
      entityType: 'ModuleAccessRequest',
      entityId: id,
      summary: `${module.label} access ${input.status.toLowerCase()} for ${request.employee.fullName}`,
      oldData: { status: request.status },
      newData: { status: input.status, reviewReason: input.reviewReason ?? null, grant },
    });

    // Mirrors the Roles desk entry, so an audit reader sees the permission
    // change itself and not merely the decision that caused it (§24).
    if (grant && grant.addedKeys.length > 0) {
      await recordAudit(tx, ctx, {
        action: 'PERMISSION_CHANGED',
        entityType: 'Role',
        entityId: grant.roleId,
        summary: `+${grant.addedKeys.length} permission(s) from a Settings module approval`,
        newData: { added: grant.addedKeys, forUserId: request.employee.id, moduleKey: module.key },
      });
    }

    return row;
  });

  // No session invalidation is needed: `requireAuth` re-reads roles and
  // permissions from PostgreSQL on every request, so the employee's next call
  // — and their next `/auth/me` — already carries the new module.
  return toRequestResponse(updated);
}


/** Everyone who can sign in to this workspace (unlike the employee directory, this includes owners and admins). */
export async function listWorkspaceMembers(auth: AuthContext) {
  const users = await prisma.user.findMany({
    where: { organizationId: auth.organizationId, deletedAt: null },
    orderBy: [{ createdAt: 'asc' }],
    select: {
      id: true, fullName: true, email: true, status: true, lastLoginAt: true, emailVerifiedAt: true,
      userRoles: { select: { role: { select: { name: true, deletedAt: true, status: true } } } },
    },
  });
  return users.map((u) => ({
    id: u.id,
    fullName: u.fullName,
    email: u.email,
    status: u.status,
    lastLoginAt: u.lastLoginAt,
    emailVerified: u.emailVerifiedAt !== null,
    roles: u.userRoles.filter((ur) => ur.role.deletedAt === null && ur.role.status === 'ACTIVE').map((ur) => ur.role.name),
  }));
}
