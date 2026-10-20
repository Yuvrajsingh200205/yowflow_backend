import { beforeEach, describe, expect, it } from 'vitest';
import { authed, base, login } from '../helpers/api';
import { prisma, resetDatabase, seedTestOrganization, TestOrg } from '../helpers/factory';

describe('CRM: clients, projects, events, shoots', () => {
  let org: TestOrg;
  let token: string;

  beforeEach(async () => {
    await resetDatabase();
    org = await seedTestOrganization();
    token = await login(org.admin);
  });

  const createClient = async (name = 'Aarav & Diya') => {
    const response = await authed(token)
      .post(`${base}/clients`)
      .send({ displayName: name, primaryPhone: '9812345678', primaryEmail: 'a@example.com' })
      .expect(201);
    return response.body.data;
  };

  const createProject = async (clientId: string) => {
    const response = await authed(token)
      .post(`${base}/projects`)
      .send({
        clientId,
        name: 'Aarav & Diya — Wedding',
        type: 'WEDDING',
        weddingDate: '2026-12-14',
        totalQuotation: '450000.00',
        events: [{ name: 'Wedding Ceremony', eventDate: '2026-12-14', venueName: 'Fairmont' }],
      })
      .expect(201);
    return response.body.data;
  };

  const grantRolePermissions = async (roleId: string, keys: string[]) => {
    const permissions = await prisma.permission.findMany({ where: { key: { in: keys } }, select: { id: true } });
    await prisma.rolePermission.createMany({
      data: permissions.map((permission) => ({ roleId, permissionId: permission.id })),
      skipDuplicates: true,
    });
  };

  it('creates a client with an auto-allocated client code', async () => {
    const client = await createClient();
    expect(client.clientCode).toMatch(/^CLI-\d{4}$/);
    expect(client.displayName).toBe('Aarav & Diya');
  });

  it('allocates sequential, unique client codes', async () => {
    const first = await createClient('First Couple');
    const second = await createClient('Second Couple');
    expect(first.clientCode).not.toBe(second.clientCode);
  });

  it('lists stable backend employee codes without mutating team rows', async () => {
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: org.member.id },
      select: { employeeCode: true, updatedAt: true },
    });

    const response = await authed(token).get(`${base}/team?page=1&limit=10`).expect(200);
    const member = response.body.data.find((user: { id: string }) => user.id === org.member.id);

    expect(member.employeeCode).toBe(before.employeeCode);
    expect(member.employeeCode).toMatch(/^EMP-S\d{2,}$/);

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: org.member.id },
      select: { employeeCode: true, updatedAt: true },
    });
    expect(after.employeeCode).toBe(before.employeeCode);
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
  });

  it('automatically assigns the next employee code when creating a user', async () => {
    const response = await authed(token)
      .post(`${base}/users`)
      .send({
        fullName: 'New Employee',
        email: 'new.employee@test-studio.test',
        password: 'TestPassw0rd!',
        roleIds: [org.roleIds.MEMBER],
      })
      .expect(201);

    expect(response.body.data.employeeCode).toBe('EMP-S04');
  });

  it('validates manually supplied employee codes and rejects duplicates', async () => {
    await authed(token)
      .post(`${base}/users`)
      .send({
        fullName: 'Bad Employee Code',
        email: 'bad.employee@test-studio.test',
        password: 'TestPassw0rd!',
        employeeCode: 'EMP-999',
        roleIds: [org.roleIds.MEMBER],
      })
      .expect(400);

    await authed(token)
      .post(`${base}/users`)
      .send({
        fullName: 'Duplicate Employee Code',
        email: 'duplicate.employee@test-studio.test',
        password: 'TestPassw0rd!',
        employeeCode: 'EMP-S01',
        roleIds: [org.roleIds.MEMBER],
      })
      .expect(409);
  });

  it('allocates unique employee codes for concurrent user creation', async () => {
    const payloads = ['one', 'two'].map((suffix) => ({
      fullName: `Concurrent ${suffix}`,
      email: `concurrent.${suffix}@test-studio.test`,
      password: 'TestPassw0rd!',
      roleIds: [org.roleIds.MEMBER],
    }));

    const responses = await Promise.all(
      payloads.map((payload) => authed(token).post(`${base}/users`).send(payload).expect(201)),
    );

    const codes = responses.map((response) => response.body.data.employeeCode).sort();
    expect(codes).toEqual(['EMP-S04', 'EMP-S05']);
  });

  it('scopes employee team access to self unless all-team permission is granted', async () => {
    await prisma.employeeProfile.upsert({
      where: { userId: org.member.id },
      create: { userId: org.member.id, monthlySalary: 50000, dailyRate: 2000 },
      update: { monthlySalary: 50000, dailyRate: 2000 },
    });
    const memberToken = await login(org.member);

    const selfOnly = await authed(memberToken).get(`${base}/team?page=1&limit=10`).expect(200);
    expect(selfOnly.body.data.map((user: { id: string }) => user.id)).toEqual([org.member.id]);
    expect(selfOnly.body.data[0].employeeProfile.monthlySalary).toBeNull();

    await grantRolePermissions(org.roleIds.MEMBER, ['TEAM_VIEW_ALL']);
    const allTeam = await authed(memberToken).get(`${base}/team?page=1&limit=10`).expect(200);
    expect(allTeam.body.data.map((user: { id: string }) => user.id)).toEqual(
      expect.arrayContaining([org.admin.id, org.manager.id, org.member.id]),
    );
  });

  it('honors an employee-specific self-only override even when the fixed role can view the team', async () => {
    await prisma.userPermissionOverride.upsert({
      where: { userId: org.manager.id },
      create: {
        organizationId: org.organizationId,
        userId: org.manager.id,
        permissionKeys: ['TEAM_VIEW_SELF'],
      },
      update: { permissionKeys: ['TEAM_VIEW_SELF'] },
    });

    const managerToken = await login(org.manager);
    const selfOnly = await authed(managerToken).get(`${base}/team?page=1&limit=100`).expect(200);

    expect(selfOnly.body.data.map((user: { id: string }) => user.id)).toEqual([org.manager.id]);
    await authed(managerToken).get(`${base}/team/${org.member.id}`).expect(403);
    await authed(managerToken).get(`${base}/team/${org.manager.id}`).expect(200);
  });

  it('does not let team-directory access open another employee profile', async () => {
    await prisma.userPermissionOverride.upsert({
      where: { userId: org.manager.id },
      create: {
        organizationId: org.organizationId,
        userId: org.manager.id,
        permissionKeys: ['TEAM_VIEW'],
      },
      update: { permissionKeys: ['TEAM_VIEW'] },
    });

    const managerToken = await login(org.manager);
    const directory = await authed(managerToken).get(`${base}/team?page=1&limit=100`).expect(200);
    expect(directory.body.data.map((user: { id: string }) => user.id)).toEqual(
      expect.arrayContaining([org.member.id, org.manager.id]),
    );

    await authed(managerToken).get(`${base}/team/${org.member.id}`).expect(403);
    await authed(managerToken).get(`${base}/team/${org.manager.id}`).expect(200);

    await prisma.userPermissionOverride.update({
      where: { userId: org.manager.id },
      data: { permissionKeys: ['TEAM_VIEW', 'EMPLOYEE_PROFILE_VIEW'] },
    });
    const withProfileToken = await login(org.manager);
    await authed(withProfileToken).get(`${base}/team/${org.member.id}`).expect(200);
  });

  it('scopes attendance access to self unless all-attendance permission is granted', async () => {
    await prisma.attendance.createMany({
      data: [
        {
          organizationId: org.organizationId,
          branchId: org.branchId,
          userId: org.member.id,
          date: new Date('2026-09-01T00:00:00.000Z'),
          status: 'PRESENT',
          source: 'ADMIN',
          workLocation: 'OFFICE',
          markedById: org.admin.id,
        },
        {
          organizationId: org.organizationId,
          branchId: org.branchId,
          userId: org.manager.id,
          date: new Date('2026-09-01T00:00:00.000Z'),
          status: 'PRESENT',
          source: 'ADMIN',
          workLocation: 'OFFICE',
          markedById: org.admin.id,
        },
      ],
    });
    const memberToken = await login(org.member);

    const selfOnly = await authed(memberToken).get(`${base}/attendance?page=1&limit=10`).expect(200);
    expect(selfOnly.body.data).toHaveLength(1);
    expect(selfOnly.body.data[0].userId).toBe(org.member.id);

    await authed(memberToken)
      .get(`${base}/attendance?userId=${org.manager.id}&page=1&limit=10`)
      .expect(403);

    const summary = await authed(memberToken)
      .get(`${base}/attendance/monthly-summary?month=2026-09`)
      .expect(200);
    expect(summary.body.data.employees).toHaveLength(1);
    expect(summary.body.data.employees[0].userId).toBe(org.member.id);
    expect(summary.body.data.employees[0].dailyRate).toBeNull();
    expect(summary.body.data.employees[0].calculatedSalary).toBeNull();

    await grantRolePermissions(org.roleIds.MEMBER, ['ATTENDANCE_VIEW_ALL']);
    const allAttendance = await authed(memberToken).get(`${base}/attendance?page=1&limit=10`).expect(200);
    expect(allAttendance.body.data.map((row: { userId: string }) => row.userId)).toEqual(
      expect.arrayContaining([org.member.id, org.manager.id]),
    );
  });

  it('separates self attendance marking from manager attendance marking', async () => {
    await prisma.userPermissionOverride.upsert({
      where: { userId: org.member.id },
      create: {
        organizationId: org.organizationId,
        userId: org.member.id,
        permissionKeys: ['ATTENDANCE_MARK'],
      },
      update: { permissionKeys: ['ATTENDANCE_MARK'] },
    });
    const memberToken = await login(org.member);

    await authed(memberToken)
      .post(`${base}/attendance`)
      .send({ date: '2026-09-02', status: 'PRESENT', workLocation: 'OFFICE' })
      .expect(201);

    await authed(memberToken)
      .post(`${base}/attendance`)
      .send({ userId: org.manager.id, date: '2026-09-02', status: 'PRESENT', workLocation: 'OFFICE' })
      .expect(409);

    await prisma.userPermissionOverride.upsert({
      where: { userId: org.manager.id },
      create: {
        organizationId: org.organizationId,
        userId: org.manager.id,
        permissionKeys: ['ATTENDANCE_CREATE'],
      },
      update: { permissionKeys: ['ATTENDANCE_CREATE'] },
    });
    const managerToken = await login(org.manager);

    await authed(managerToken)
      .post(`${base}/attendance`)
      .send({ userId: org.member.id, date: '2026-09-03', status: 'PRESENT', workLocation: 'OFFICE' })
      .expect(201);
  });

  it('scopes leave requests to self unless all-leave permission is granted', async () => {
    await prisma.userPermissionOverride.upsert({
      where: { userId: org.member.id },
      create: {
        organizationId: org.organizationId,
        userId: org.member.id,
        permissionKeys: ['LEAVE_REQUEST', 'LEAVE_VIEW_SELF'],
      },
      update: { permissionKeys: ['LEAVE_REQUEST', 'LEAVE_VIEW_SELF'] },
    });
    const memberToken = await login(org.member);

    const ownLeave = await authed(memberToken)
      .post(`${base}/attendance/leave`)
      .send({ type: 'CASUAL', startDate: '2026-09-04', endDate: '2026-09-05', reason: 'Family work' })
      .expect(201);

    await prisma.leaveRequest.create({
      data: {
        organizationId: org.organizationId,
        userId: org.manager.id,
        type: 'SICK',
        startDate: new Date('2026-09-06T00:00:00.000Z'),
        endDate: new Date('2026-09-06T00:00:00.000Z'),
        days: 1,
      },
    });

    const selfOnly = await authed(memberToken).get(`${base}/attendance/leave?page=1&limit=20`).expect(200);
    expect(selfOnly.body.data.map((leave: { id: string }) => leave.id)).toEqual([ownLeave.body.data.id]);

    await authed(memberToken)
      .get(`${base}/attendance/leave?userId=${org.manager.id}&page=1&limit=20`)
      .expect(403);

    await prisma.userPermissionOverride.upsert({
      where: { userId: org.manager.id },
      create: {
        organizationId: org.organizationId,
        userId: org.manager.id,
        permissionKeys: ['LEAVE_VIEW', 'LEAVE_APPROVE'],
      },
      update: { permissionKeys: ['LEAVE_VIEW', 'LEAVE_APPROVE'] },
    });
    const managerToken = await login(org.manager);
    const allLeave = await authed(managerToken).get(`${base}/attendance/leave?page=1&limit=20`).expect(200);
    expect(allLeave.body.data.map((leave: { userId: string }) => leave.userId)).toEqual(
      expect.arrayContaining([org.member.id, org.manager.id]),
    );

    await authed(managerToken)
      .post(`${base}/attendance/leave/${ownLeave.body.data.id}/review`)
      .send({ decision: 'APPROVE', note: 'Approved' })
      .expect(200);
  });

  it('allows managers to apply leave for an employee but blocks self-service spoofing', async () => {
    await prisma.userPermissionOverride.upsert({
      where: { userId: org.member.id },
      create: {
        organizationId: org.organizationId,
        userId: org.member.id,
        permissionKeys: ['LEAVE_REQUEST', 'LEAVE_VIEW_SELF'],
      },
      update: { permissionKeys: ['LEAVE_REQUEST', 'LEAVE_VIEW_SELF'] },
    });
    const memberToken = await login(org.member);

    await authed(memberToken)
      .post(`${base}/attendance/leave`)
      .send({
        userId: org.manager.id,
        type: 'PERSONAL',
        startDate: '2026-09-07',
        endDate: '2026-09-07',
      })
      .expect(403);

    const managerToken = await login(org.manager);
    const delegated = await authed(managerToken)
      .post(`${base}/attendance/leave`)
      .send({
        userId: org.member.id,
        type: 'PERSONAL',
        startDate: '2026-09-08',
        endDate: '2026-09-09',
        reason: 'Submitted by manager',
      })
      .expect(201);

    expect(delegated.body.data.userId).toBe(org.member.id);
    expect(delegated.body.data.days).toBe('2');
  });

  it('creates a project with its events in one transaction', async () => {
    const client = await createClient();
    const project = await createProject(client.id);

    expect(project.projectNumber).toMatch(/^PRJ-\d{4}-\d{4}$/);
    expect(project.status).toBe('UPCOMING');
    expect(project.events).toHaveLength(1);
    // Money is an exact decimal string, never a float. Trailing zeros are not
    // padded, so 450000.00 is sent as "450000".
    expect(project.totalQuotation).toBe('450000');
    expect(typeof project.totalQuotation).toBe('string');

    const history = await prisma.projectStatusHistory.findMany({ where: { projectId: project.id } });
    expect(history).toHaveLength(1);
    expect(history[0].newStatus).toBe('UPCOMING');
  });

  it('creates client, tasks, shoots and assignees in one project request', async () => {
    const response = await authed(token)
      .post(`${base}/projects`)
      .send({
        client: { displayName: 'Aarav & Diya', primaryPhone: '9812345678' },
        name: 'Aarav & Diya — Wedding',
        type: 'WEDDING',
        status: 'CONFIRMED',
        weddingDate: '2026-12-14',
        totalQuotation: '450000.00',
        tasks: [
          {
            title: 'Cinematic Teaser',
            description: 'Deliver the opening teaser',
            assigneeId: org.member.id,
            status: 'ASSIGNED',
          },
        ],
        shoots: [
          {
            title: 'Wedding Day Coverage',
            shootDate: '2026-12-14',
            status: 'SCHEDULED',
            crewAssignments: [{ userId: org.member.id, role: 'LEAD_PHOTOGRAPHER' }],
          },
        ],
      })
      .expect(201);

    expect(response.body.data.client.displayName).toBe('Aarav & Diya');
    expect(response.body.data.client.primaryPhone).toBe('9812345678');
    expect(response.body.data.status).toBe('CONFIRMED');
    expect(response.body.data.tasks).toHaveLength(1);
    expect(response.body.data.tasks[0].assignee.id).toBe(org.member.id);
    expect(response.body.data.tasks[0].assignee.fullName).toBe('Member User');
    expect(response.body.data.shoots).toHaveLength(1);
    expect(response.body.data.shoots[0].assignments).toHaveLength(1);
    expect(response.body.data.shoots[0].assignments[0].user.id).toBe(org.member.id);

    const list = await authed(token).get(`${base}/projects?page=1&limit=10`).expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].tasks).toHaveLength(1);
    expect(list.body.data[0].tasks[0].assignee.fullName).toBe('Member User');
  });

  it('enforces project visibility by assignment for managers and employees', async () => {
    const client = await createClient();
    const assignedToMember = await authed(token)
      .post(`${base}/projects`)
      .send({
        clientId: client.id,
        name: 'Assigned to Member',
        type: 'WEDDING',
        tasks: [{ title: 'Edit teaser', assigneeId: org.member.id, status: 'ASSIGNED' }],
      })
      .expect(201);
    const assignedToManager = await authed(token)
      .post(`${base}/projects`)
      .send({
        clientId: client.id,
        name: 'Managed by Manager',
        type: 'WEDDING',
        managerId: org.manager.id,
      })
      .expect(201);
    const unassigned = await authed(token)
      .post(`${base}/projects`)
      .send({ clientId: client.id, name: 'Private Admin Project', type: 'WEDDING' })
      .expect(201);

    const adminList = await authed(token).get(`${base}/projects?page=1&limit=10`).expect(200);
    expect(adminList.body.data.map((p: { id: string }) => p.id)).toEqual(
      expect.arrayContaining([assignedToMember.body.data.id, assignedToManager.body.data.id, unassigned.body.data.id]),
    );

    const memberToken = await login(org.member);
    const memberList = await authed(memberToken).get(`${base}/projects?page=1&limit=10`).expect(200);
    expect(memberList.body.data.map((p: { id: string }) => p.id)).toEqual([assignedToMember.body.data.id]);
    await authed(memberToken).get(`${base}/projects/${assignedToMember.body.data.id}`).expect(200);
    await authed(memberToken).get(`${base}/projects/${unassigned.body.data.id}`).expect(404);

    const managerToken = await login(org.manager);
    const managerList = await authed(managerToken).get(`${base}/projects?page=1&limit=10`).expect(200);
    expect(managerList.body.data.map((p: { id: string }) => p.id)).toEqual([assignedToManager.body.data.id]);
    await authed(managerToken).get(`${base}/projects/${assignedToManager.body.data.id}`).expect(200);
    await authed(managerToken).get(`${base}/projects/${unassigned.body.data.id}`).expect(404);
  });

  it('enforces feature-level permissions inside an authorized project', async () => {
    const client = await createClient();
    const assignedToMember = await authed(token)
      .post(`${base}/projects`)
      .send({
        clientId: client.id,
        name: 'Feature Scoped Member Project',
        type: 'WEDDING',
        totalQuotation: '450000.00',
        tasks: [{ title: 'Cull images', assigneeId: org.member.id, status: 'ASSIGNED' }],
      })
      .expect(201);
    const assignedToManager = await authed(token)
      .post(`${base}/projects`)
      .send({
        clientId: client.id,
        name: 'Feature Scoped Manager Project',
        type: 'WEDDING',
        managerId: org.manager.id,
        totalQuotation: '550000.00',
      })
      .expect(201);
    const unassigned = await authed(token)
      .post(`${base}/projects`)
      .send({ clientId: client.id, name: 'Feature Scoped Private Project', type: 'WEDDING', totalQuotation: '650000.00' })
      .expect(201);

    await authed(token)
      .post(`${base}/payments`)
      .set('Idempotency-Key', 'admin-payment-assigned-manager')
      .send({
        clientId: client.id,
        projectId: assignedToManager.body.data.id,
        amount: '25000.00',
        paymentDate: '2026-12-01',
        paymentMethod: 'UPI',
      })
      .expect(201);
    await authed(token)
      .post(`${base}/projects/${assignedToMember.body.data.id}/payment-milestones`)
      .send({ title: 'Booking', amount: '100000.00', dueDate: '2026-11-01', status: 'PENDING' })
      .expect(201);

    const memberToken = await login(org.member);
    const memberProject = await authed(memberToken)
      .get(`${base}/projects/${assignedToMember.body.data.id}`)
      .expect(200);
    expect(memberProject.body.data.totalQuotation).toBeNull();
    expect(memberProject.body.data.paymentMilestones).toBeUndefined();
    expect(memberProject.body.data.payments).toBeUndefined();
    await authed(memberToken).get(`${base}/projects/${assignedToMember.body.data.id}/payment-milestones`).expect(403);
    await authed(memberToken).get(`${base}/payments?projectId=${assignedToMember.body.data.id}`).expect(403);

    await grantRolePermissions(org.roleIds.MANAGER, ['PAYMENT_VIEW', 'PROJECT_FINANCIAL_VIEW', 'PAYMENT_MILESTONE_VIEW']);
    const managerToken = await login(org.manager);
    const managerProject = await authed(managerToken)
      .get(`${base}/projects/${assignedToManager.body.data.id}`)
      .expect(200);
    expect(managerProject.body.data.totalQuotation).toBe('550000');
    const managerPayments = await authed(managerToken)
      .get(`${base}/payments?projectId=${assignedToManager.body.data.id}`)
      .expect(200);
    expect(managerPayments.body.data).toHaveLength(1);
    await authed(managerToken).get(`${base}/payments?projectId=${unassigned.body.data.id}`).expect(404);
  });

  it('rolls the whole project creation back when the client does not exist', async () => {
    const before = await prisma.project.count();
    const response = await authed(token)
      .post(`${base}/projects`)
      .send({ clientId: '00000000-0000-4000-8000-000000000000', name: 'Orphan' });

    expect(response.status).toBe(404);
    expect(await prisma.project.count()).toBe(before);
  });

  it('enforces the project status machine and records every transition', async () => {
    const client = await createClient();
    const project = await createProject(client.id);

    // UPCOMING -> COMPLETED is not a legal jump.
    const illegal = await authed(token)
      .patch(`${base}/projects/${project.id}/status`)
      .send({ status: 'COMPLETED' });
    expect(illegal.status).toBe(400);

    await authed(token)
      .patch(`${base}/projects/${project.id}/status`)
      .send({ status: 'CONFIRMED', reason: 'Advance received' })
      .expect(200);

    const history = await prisma.projectStatusHistory.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(history.map((h) => h.newStatus)).toEqual(['UPCOMING', 'CONFIRMED']);
    expect(history[1].reason).toBe('Advance received');
    expect(history[1].changedById).toBe(org.admin.id);
  });

  it('creates an event attached to a project', async () => {
    const client = await createClient();
    const project = await createProject(client.id);

    const response = await authed(token)
      .post(`${base}/events`)
      .send({
        projectId: project.id,
        eventTypeId: org.eventTypeId,
        name: 'Sangeet',
        eventDate: '2026-12-12',
        venueName: 'Fairmont Lawn',
      })
      .expect(201);

    expect(response.body.data.name).toBe('Sangeet');
    expect(response.body.data.projectId).toBe(project.id);
  });

  it('creates a shoot and rejects an event from a different project', async () => {
    const client = await createClient();
    const projectA = await createProject(client.id);
    const projectB = await createProject(client.id);

    const shoot = await authed(token)
      .post(`${base}/shoots`)
      .send({
        projectId: projectA.id,
        eventId: projectA.events[0].id,
        title: 'Wedding Day Coverage',
        shootDate: '2026-12-14',
      })
      .expect(201);
    expect(shoot.body.data.status).toBe('SCHEDULED');

    const mismatched = await authed(token)
      .post(`${base}/shoots`)
      .send({
        projectId: projectB.id,
        eventId: projectA.events[0].id,
        title: 'Wrong event',
        shootDate: '2026-12-14',
      });
    expect(mismatched.status).toBe(400);
  });

  it('paginates and never exceeds the maximum page size', async () => {
    await createClient('Alpha');
    await createClient('Beta');

    const capped = await authed(token).get(`${base}/clients?page=1&limit=9999`);
    expect(capped.status).toBe(400);

    const page = await authed(token).get(`${base}/clients?page=1&limit=1`).expect(200);
    expect(page.body.data).toHaveLength(1);
    expect(page.body.meta.pagination.total).toBe(2);
    expect(page.body.meta.pagination.hasNext).toBe(true);
  });

  it('filters clients by search term', async () => {
    await createClient('Aarav & Diya');
    await createClient('Rohan & Meera');

    const response = await authed(token).get(`${base}/clients?search=rohan`).expect(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].displayName).toBe('Rohan & Meera');
  });

  it('soft-deletes a client and hides it from lists', async () => {
    const client = await createClient();
    await authed(token).delete(`${base}/clients/${client.id}`).expect(204);

    const list = await authed(token).get(`${base}/clients`).expect(200);
    expect(list.body.data).toHaveLength(0);

    // The row is retained with a tombstone, not removed.
    const row = await prisma.client.findUnique({ where: { id: client.id } });
    expect(row).not.toBeNull();
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.deletedBy).toBe(org.admin.id);
  });

  it('refuses to archive a client that still has live projects', async () => {
    const client = await createClient();
    await createProject(client.id);

    const response = await authed(token).delete(`${base}/clients/${client.id}`);
    expect(response.status).toBe(409);
  });

  it('converts a lead into a client exactly once', async () => {
    const lead = await authed(token)
      .post(`${base}/leads`)
      .send({ name: 'Karan & Simran', phone: '9900112233', estimatedValue: '300000.00' })
      .expect(201);

    const converted = await authed(token)
      .post(`${base}/leads/${lead.body.data.id}/convert`)
      .send({})
      .expect(200);

    expect(converted.body.data.status).toBe('WON');
    expect(converted.body.data.client.displayName).toBe('Karan & Simran');

    const second = await authed(token)
      .post(`${base}/leads/${lead.body.data.id}/convert`)
      .send({});
    expect(second.status).toBe(409);
  });

  it('scopes lead lists and direct detail access to the assigned employee', async () => {
    const memberLead = await authed(token)
      .post(`${base}/leads`)
      .send({ name: 'Assigned Couple', phone: '9900112234', ownerId: org.member.id })
      .expect(201);
    const otherLead = await authed(token)
      .post(`${base}/leads`)
      .send({ name: 'Another Couple', phone: '9900112235', ownerId: org.manager.id })
      .expect(201);

    const memberToken = await login(org.member);
    const memberList = await authed(memberToken).get(`${base}/leads?search=couple`).expect(200);
    expect(memberList.body.data.map((lead: { id: string }) => lead.id)).toEqual([memberLead.body.data.id]);
    expect(memberList.body.meta.pagination.total).toBe(1);

    await authed(memberToken).get(`${base}/leads/${memberLead.body.data.id}`).expect(200);
    // A guessed UUID reads as missing, without revealing another employee's lead.
    await authed(memberToken).get(`${base}/leads/${otherLead.body.data.id}`).expect(404);

    const adminList = await authed(token).get(`${base}/leads?search=couple`).expect(200);
    expect(adminList.body.meta.pagination.total).toBe(2);
  });

  it('rejects a malformed UUID before it reaches the database', async () => {
    const response = await authed(token).get(`${base}/clients/not-a-uuid`);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});
