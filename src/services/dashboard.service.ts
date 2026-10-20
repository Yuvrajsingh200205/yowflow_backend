import { ProjectStatus, ShootStatus, TaskStatus } from '@prisma/client';
import { Prisma, prisma } from '../config/prisma';
import { AuthContext } from '../types';

const OPEN_TASK_STATUSES: TaskStatus[] = [
  TaskStatus.TODO,
  TaskStatus.ASSIGNED,
  TaskStatus.IN_PROGRESS,
  TaskStatus.PAUSED,
  TaskStatus.IN_REVIEW,
];

const ACTIVE_PROJECT_STATUSES: ProjectStatus[] = [
  ProjectStatus.CONFIRMED,
  ProjectStatus.PLANNING,
  ProjectStatus.SHOOTING,
  ProjectStatus.EDITING,
  ProjectStatus.DELIVERY,
];

/** Local calendar day, used for "today" attendance which is stored as a date. */
function today(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

export interface DashboardSummary {
  stats: {
    projects: number;
    activeProjects: number;
    completedProjects: number;
    urgentProjects: number;
    shoots: number;
    upcomingShoots: number;
    tasks: number;
    openTasks: number;
    overdueTasks: number;
    todos: number;
    pendingTodos: number;
    teamMembers: number;
    unreadNotifications: number;
    presentToday: number;
  };
  /** Counts keyed by `ProjectStatus`, so a client can render its own buckets. */
  projectsByStatus: Record<string, number>;
  finance: { received: number; quoted: number; outstanding: number } | null;
  attendance: {
    status: string;
    checkIn: string | null;
    checkOut: string | null;
    date: string;
  } | null;
  upcomingShoots: {
    id: string;
    title: string;
    shootDate: string;
    startTime: string | null;
    status: string;
    location: string | null;
    projectName: string;
    projectNumber: string;
    clientName: string;
    eventName: string | null;
    crew: { role: string; name: string | null }[];
  }[];
  urgentProjects: {
    id: string;
    projectNumber: string;
    name: string;
    status: string;
    weddingDate: string | null;
    deliveryDueDate: string | null;
  }[];
}

interface UpcomingShootRow {
  id: string;
  title: string;
  shoot_date: Date;
  start_time: Date | null;
  status: string;
  location: string | null;
  project_name: string;
  project_number: string;
  client_name: string;
  event_name: string | null;
  crew: { role: string; name: string | null }[];
}

interface CountRow {
  projects: bigint;
  active_projects: bigint;
  completed_projects: bigint;
  shoots: bigint;
  tasks: bigint;
  open_tasks: bigint;
  overdue_tasks: bigint;
  todos: bigint;
  pending_todos: bigint;
  team_members: bigint;
  unread_notifications: bigint;
  present_today: bigint;
  my_status: string | null;
  my_check_in: Date | null;
  my_check_out: Date | null;
  projects_by_status: Record<string, number>;
  received: string | null;
  quoted: string | null;
}

/**
 * A single read model for the dashboard.
 *
 * Every figure is computed by PostgreSQL, and the only rows returned are the
 * handful the UI renders — the dashboard used to page in ~500 full records to
 * derive these numbers in the browser. All the aggregates travel as one
 * statement on purpose: against a managed database a round trip costs far more
 * than the scans do, and enough concurrent queries would exhaust the pool and
 * serialise anyway.
 */
export async function getSummary(auth: AuthContext): Promise<DashboardSummary> {
  const organizationId = auth.organizationId;
  const now = new Date();
  const day = today();
  const canSeeFinance = auth.permissions.has('DASHBOARD_FINANCIAL');
  const orgScope = { organizationId, deletedAt: null };
  const org = Prisma.sql`${organizationId}::uuid`;
  const userId = Prisma.sql`${auth.userId}::uuid`;
  const activeStatuses = Prisma.sql`(${Prisma.join(ACTIVE_PROJECT_STATUSES.map(String))})`;
  const openStatuses = Prisma.sql`(${Prisma.join(OPEN_TASK_STATUSES.map(String))})`;

  const [countRows, urgentProjectRows, upcomingShootRows] = await Promise.all([
    prisma.$queryRaw<CountRow[]>`
      SELECT
        (SELECT count(*) FROM projects
          WHERE organization_id = ${org} AND deleted_at IS NULL) AS projects,
        (SELECT count(*) FROM projects
          WHERE organization_id = ${org} AND deleted_at IS NULL
            AND status::text IN ${activeStatuses}) AS active_projects,
        (SELECT count(*) FROM projects
          WHERE organization_id = ${org} AND deleted_at IS NULL
            AND status = 'COMPLETED') AS completed_projects,
        (SELECT count(*) FROM shoots
          WHERE organization_id = ${org} AND deleted_at IS NULL) AS shoots,
        (SELECT count(*) FROM tasks
          WHERE organization_id = ${org} AND deleted_at IS NULL) AS tasks,
        (SELECT count(*) FROM tasks
          WHERE organization_id = ${org} AND deleted_at IS NULL
            AND status::text IN ${openStatuses}) AS open_tasks,
        (SELECT count(*) FROM tasks
          WHERE organization_id = ${org} AND deleted_at IS NULL
            AND status::text IN ${openStatuses} AND due_date < ${day}) AS overdue_tasks,
        (SELECT count(*) FROM personal_todos
          WHERE organization_id = ${org} AND user_id = ${userId}
            AND deleted_at IS NULL) AS todos,
        (SELECT count(*) FROM personal_todos
          WHERE organization_id = ${org} AND user_id = ${userId}
            AND deleted_at IS NULL AND completed = false) AS pending_todos,
        (SELECT count(*) FROM users
          WHERE organization_id = ${org} AND deleted_at IS NULL
            AND status = 'ACTIVE') AS team_members,
        (SELECT count(*) FROM notifications
          WHERE organization_id = ${org} AND user_id = ${userId}
            AND is_read = false) AS unread_notifications,
        (SELECT count(*) FROM attendance
          WHERE organization_id = ${org} AND date = ${day}
            AND status = 'PRESENT') AS present_today,
        (SELECT status::text FROM attendance
          WHERE user_id = ${userId} AND date = ${day}) AS my_status,
        (SELECT check_in FROM attendance
          WHERE user_id = ${userId} AND date = ${day}) AS my_check_in,
        (SELECT check_out FROM attendance
          WHERE user_id = ${userId} AND date = ${day}) AS my_check_out,
        (SELECT coalesce(jsonb_object_agg(s.status, s.total), '{}'::jsonb)
          FROM (
            SELECT status::text AS status, count(*) AS total
            FROM projects
            WHERE organization_id = ${org} AND deleted_at IS NULL
            GROUP BY status
          ) s) AS projects_by_status,
        CASE WHEN ${canSeeFinance} THEN (SELECT coalesce(sum(payments.amount), 0) FROM payments
          INNER JOIN projects ON projects.id = payments.project_id
          WHERE payments.organization_id = ${org} AND payments.status = 'COMPLETED'
            AND projects.organization_id = ${org} AND projects.deleted_at IS NULL) END AS received,
        CASE WHEN ${canSeeFinance} THEN (SELECT coalesce(sum(total_quotation), 0) FROM projects
          WHERE organization_id = ${org} AND deleted_at IS NULL) END AS quoted
    `,
    prisma.project.findMany({
      where: {
        ...orgScope,
        status: { in: ACTIVE_PROJECT_STATUSES },
        deliveryDueDate: { not: null, lte: new Date(now.getTime() + 14 * 86_400_000) },
      },
      select: {
        id: true,
        projectNumber: true,
        name: true,
        status: true,
        weddingDate: true,
        deliveryDueDate: true,
      },
      orderBy: { deliveryDueDate: 'asc' },
      take: 5,
    }),
    // Joined in SQL: a nested `select` on project/event would cost Prisma an
    // extra round trip per relation.
    prisma.$queryRaw<UpcomingShootRow[]>`
      SELECT
        s.id,
        s.title,
        s.shoot_date,
        s.start_time,
        s.status::text AS status,
        s.location,
        p.name           AS project_name,
        p.project_number AS project_number,
        c.display_name   AS client_name,
        e.name           AS event_name,
        crew.crew        AS crew
      FROM shoots s
      JOIN projects p ON p.id = s.project_id
      JOIN clients c ON c.id = p.client_id
      LEFT JOIN events e ON e.id = s.event_id
      LEFT JOIN LATERAL (
        SELECT coalesce(
          json_agg(json_build_object('role', sa.role::text, 'name', coalesce(u.full_name, f.full_name))),
          '[]'::json
        ) AS crew
        FROM shoot_assignments sa
        LEFT JOIN users u ON u.id = sa.user_id
        LEFT JOIN freelancers f ON f.id = sa.freelancer_id
        WHERE sa.shoot_id = s.id
      ) crew ON true
      WHERE s.organization_id = ${org}
        AND s.deleted_at IS NULL
        AND s.status = ${ShootStatus.SCHEDULED}::"ShootStatus"
        AND s.shoot_date >= ${day}
      ORDER BY s.shoot_date ASC
      LIMIT 5
    `,
  ]);

  const counts = countRows[0];
  const number = (value: bigint | null | undefined) => Number(value ?? 0);
  const received = Number(counts?.received ?? 0);
  const quoted = Number(counts?.quoted ?? 0);

  return {
    stats: {
      projects: number(counts?.projects),
      activeProjects: number(counts?.active_projects),
      completedProjects: number(counts?.completed_projects),
      urgentProjects: urgentProjectRows.length,
      shoots: number(counts?.shoots),
      upcomingShoots: upcomingShootRows.length,
      tasks: number(counts?.tasks),
      openTasks: number(counts?.open_tasks),
      overdueTasks: number(counts?.overdue_tasks),
      todos: number(counts?.todos),
      pendingTodos: number(counts?.pending_todos),
      teamMembers: number(counts?.team_members),
      unreadNotifications: number(counts?.unread_notifications),
      presentToday: number(counts?.present_today),
    },
    projectsByStatus: counts?.projects_by_status ?? {},
    finance: canSeeFinance
      ? { received, quoted, outstanding: Math.max(quoted - received, 0) }
      : null,
    attendance: counts?.my_status
      ? {
          status: counts.my_status,
          checkIn: counts.my_check_in?.toISOString() ?? null,
          checkOut: counts.my_check_out?.toISOString() ?? null,
          date: day.toISOString().slice(0, 10),
        }
      : null,
    upcomingShoots: upcomingShootRows.map((shoot) => ({
      id: shoot.id,
      title: shoot.title,
      shootDate: shoot.shoot_date.toISOString().slice(0, 10),
      startTime: shoot.start_time?.toISOString() ?? null,
      status: shoot.status,
      location: shoot.location,
      projectName: shoot.project_name,
      projectNumber: shoot.project_number,
      clientName: shoot.client_name,
      eventName: shoot.event_name,
      crew: shoot.crew.filter((member) => member.name !== null),
    })),
    urgentProjects: urgentProjectRows.map((project) => ({
      id: project.id,
      projectNumber: project.projectNumber,
      name: project.name,
      status: project.status,
      weddingDate: project.weddingDate?.toISOString().slice(0, 10) ?? null,
      deliveryDueDate: project.deliveryDueDate?.toISOString().slice(0, 10) ?? null,
    })),
  };
}


const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/**
 * Month-by-month series for the dashboard charts. Money series are only
 * included when the caller may view payments / expenses, so the dashboard
 * can never leak figures a role is not entitled to.
 */
export async function getTrends(auth: AuthContext, months = 8) {
  const count = Math.min(Math.max(Math.trunc(months), 3), 24);
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (count - 1), 1));
  const keys = Array.from({ length: count }, (_, i) => monthKey(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1))));
  const bucket = (rows: Array<{ at: Date; value: number }>) => {
    const m = new Map<string, number>(keys.map((k) => [k, 0]));
    for (const r of rows) { const k = monthKey(r.at); if (m.has(k)) m.set(k, (m.get(k) ?? 0) + r.value); }
    return keys.map((k) => m.get(k) ?? 0);
  };
  const org = auth.organizationId;
  const canPay = auth.permissions.has('PAYMENT_VIEW');
  const canExpense = auth.permissions.has('EXPENSE_VIEW');

  const [payments, expenses, leads, projects] = await Promise.all([
    canPay ? prisma.payment.findMany({ where: { organizationId: org, status: 'COMPLETED', paymentDate: { gte: start } }, select: { paymentDate: true, amount: true } }) : [],
    canExpense ? prisma.expense.findMany({ where: { organizationId: org, deletedAt: null, expenseDate: { gte: start } }, select: { expenseDate: true, amount: true } }) : [],
    prisma.lead.findMany({ where: { organizationId: org, deletedAt: null, createdAt: { gte: start } }, select: { createdAt: true } }),
    prisma.project.findMany({ where: { organizationId: org, deletedAt: null, createdAt: { gte: start } }, select: { createdAt: true } }),
  ]);

  return {
    months: keys,
    revenue: canPay ? bucket(payments.map((p) => ({ at: p.paymentDate, value: Number(p.amount) }))) : null,
    expenses: canExpense ? bucket(expenses.map((e) => ({ at: e.expenseDate, value: Number(e.amount) }))) : null,
    leads: bucket(leads.map((l) => ({ at: l.createdAt, value: 1 }))),
    bookings: bucket(projects.map((p) => ({ at: p.createdAt, value: 1 }))),
  };
}
