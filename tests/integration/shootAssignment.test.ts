import { beforeEach, describe, expect, it } from 'vitest';
import { authed, base, login } from '../helpers/api';
import { prisma, resetDatabase, seedTestOrganization, TestOrg } from '../helpers/factory';

describe('shoot crew assignment', () => {
  let org: TestOrg;
  let token: string;
  let shootId: string;
  let freelancerId: string;
  let clientId: string;

  beforeEach(async () => {
    await resetDatabase();
    org = await seedTestOrganization();
    token = await login(org.admin);

    const client = await authed(token)
      .post(`${base}/clients`)
      .send({ displayName: 'Test Couple', primaryPhone: '9812345678' })
      .expect(201);
    clientId = client.body.data.id;

    const project = await authed(token)
      .post(`${base}/projects`)
      .send({ clientId: client.body.data.id, name: 'Test Wedding', weddingDate: '2026-12-14' })
      .expect(201);

    const shoot = await authed(token)
      .post(`${base}/shoots`)
      .send({ projectId: project.body.data.id, title: 'Wedding Day', shootDate: '2026-12-14' })
      .expect(201);
    shootId = shoot.body.data.id;

    const freelancer = await authed(token)
      .post(`${base}/freelancers`)
      .send({ fullName: 'Rohit Candid', phone: '9900112233', rate: '18000.00' })
      .expect(201);
    freelancerId = freelancer.body.data.id;
  });

  it('assigns an employee to a shoot', async () => {
    const response = await authed(token)
      .post(`${base}/shoots/${shootId}/assignments`)
      .send({ userId: org.member.id, role: 'LEAD_PHOTOGRAPHER' })
      .expect(201);

    expect(response.body.data.userId).toBe(org.member.id);
    expect(response.body.data.freelancerId).toBeNull();
    expect(response.body.data.status).toBe('ASSIGNED');
  });

  it('assigns a freelancer with an agreed cost', async () => {
    const response = await authed(token)
      .post(`${base}/shoots/${shootId}/assignments`)
      .send({
        freelancerId,
        role: 'CANDID_PHOTOGRAPHER',
        agreedAmount: '18000.00',
        travelAmount: '2000.00',
      })
      .expect(201);

    expect(response.body.data.freelancerId).toBe(freelancerId);
    expect(response.body.data.agreedAmount).toBe('18000');
  });

  it('rejects an assignment naming both an employee and a freelancer', async () => {
    const response = await authed(token)
      .post(`${base}/shoots/${shootId}/assignments`)
      .send({ userId: org.member.id, freelancerId, role: 'ASSISTANT' });

    expect(response.status).toBe(400);
    // The envelope message is stable; the specific rule is in `details`.
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(response.body.error.details)).toMatch(/exactly one/i);
  });

  it('rejects an assignment naming neither', async () => {
    const response = await authed(token)
      .post(`${base}/shoots/${shootId}/assignments`)
      .send({ role: 'ASSISTANT' });
    expect(response.status).toBe(400);
  });

  it('allows the same employee on multiple roles of one shoot', async () => {
    await authed(token)
      .post(`${base}/shoots/${shootId}/assignments`)
      .send({ userId: org.member.id, role: 'LEAD_PHOTOGRAPHER' })
      .expect(201);

    const secondRole = await authed(token)
      .post(`${base}/shoots/${shootId}/assignments`)
      .send({ userId: org.member.id, role: 'ASSISTANT' })
      .expect(201);

    expect(secondRole.body.data.role).toBe('ASSISTANT');
    expect(await prisma.shootAssignment.count({ where: { shootId, userId: org.member.id } })).toBe(2);
  });

  it('returns the existing row when the same employee is assigned the same role again', async () => {
    const created = await authed(token)
      .post(`${base}/shoots/${shootId}/assignments`)
      .send({ userId: org.member.id, role: 'LEAD_PHOTOGRAPHER' })
      .expect(201);

    const duplicate = await authed(token)
      .post(`${base}/shoots/${shootId}/assignments`)
      .send({ userId: org.member.id, role: 'LEAD_PHOTOGRAPHER' })
      .expect(201);

    expect(duplicate.body.data.id).toBe(created.body.data.id);
    expect(await prisma.shootAssignment.count({ where: { shootId } })).toBe(1);
  });

  it('blocks an employee on the same date across projects but allows a different date', async () => {
    const secondProject = await authed(token)
      .post(`${base}/projects`)
      .send({ clientId, name: 'Second Wedding', weddingDate: '2026-12-14' })
      .expect(201);
    const sameDateShoot = await authed(token)
      .post(`${base}/shoots`)
      .send({ projectId: secondProject.body.data.id, title: 'Same-date shoot', shootDate: '2026-12-14' })
      .expect(201);
    const differentDateShoot = await authed(token)
      .post(`${base}/shoots`)
      .send({ projectId: secondProject.body.data.id, title: 'Different-date shoot', shootDate: '2026-12-15' })
      .expect(201);

    await authed(token)
      .post(`${base}/shoots/${shootId}/assignments`)
      .send({ userId: org.member.id, role: 'LEAD_PHOTOGRAPHER' })
      .expect(201);

    const conflict = await authed(token)
      .post(`${base}/shoots/${sameDateShoot.body.data.id}/assignments`)
      .send({ userId: org.member.id, role: 'LEAD_PHOTOGRAPHER' });
    expect(conflict.status).toBe(409);
    // The clash now names the person, the date and the shoot they are on.
    expect(conflict.body.error.message).toContain('Member User');
    expect(conflict.body.error.message).toMatch(/already assigned on/);

    await authed(token)
      .post(`${base}/shoots/${differentDateShoot.body.data.id}/assignments`)
      .send({ userId: org.member.id, role: 'LEAD_PHOTOGRAPHER' })
      .expect(201);
  });

  it('allows the same freelancer on multiple roles of one shoot', async () => {
    await authed(token)
      .post(`${base}/shoots/${shootId}/assignments`)
      .send({ freelancerId, role: 'CANDID_PHOTOGRAPHER' })
      .expect(201);

    const secondRole = await authed(token)
      .post(`${base}/shoots/${shootId}/assignments`)
      .send({ freelancerId, role: 'DRONE_OPERATOR' })
      .expect(201);

    expect(secondRole.body.data.role).toBe('DRONE_OPERATOR');
    expect(await prisma.shootAssignment.count({ where: { shootId, freelancerId } })).toBe(2);
  });

  it('returns the existing row when the same freelancer is assigned the same role again', async () => {
    const created = await authed(token)
      .post(`${base}/shoots/${shootId}/assignments`)
      .send({ freelancerId, role: 'CANDID_PHOTOGRAPHER' })
      .expect(201);

    const duplicate = await authed(token)
      .post(`${base}/shoots/${shootId}/assignments`)
      .send({ freelancerId, role: 'CANDID_PHOTOGRAPHER' })
      .expect(201);

    expect(duplicate.body.data.id).toBe(created.body.data.id);
  });

  it('blocks over-booking a freelancer beyond their daily limit', async () => {
    // A single wedding legitimately runs several shoots in one day, so the
    // daily limit only counts bookings on *other* projects. The clash has to be
    // built across projects, exactly as the employee rule above is.
    const otherProject = await authed(token)
      .post(`${base}/projects`)
      .send({ clientId, name: 'Over-booking Wedding', weddingDate: '2026-12-14' })
      .expect(201);

    const second = await authed(token)
      .post(`${base}/shoots`)
      .send({
        projectId: otherProject.body.data.id,
        title: 'Second shoot same day',
        shootDate: '2026-12-14',
      })
      .expect(201);

    await authed(token)
      .post(`${base}/shoots/${shootId}/assignments`)
      .send({ freelancerId, role: 'CANDID_PHOTOGRAPHER' })
      .expect(201);

    // maxShootsPerDay defaults to 1.
    const clash = await authed(token)
      .post(`${base}/shoots/${second.body.data.id}/assignments`)
      .send({ freelancerId, role: 'CANDID_PHOTOGRAPHER' });

    expect(clash.status).toBe(409);
    expect(clash.body.error.message).toMatch(/already booked/i);
  });

  it('notifies an employee when they are assigned', async () => {
    await authed(token)
      .post(`${base}/shoots/${shootId}/assignments`)
      .send({ userId: org.member.id, role: 'LEAD_PHOTOGRAPHER' })
      .expect(201);

    const notification = await prisma.notification.findFirst({
      where: { userId: org.member.id, type: 'SHOOT_ASSIGNED' },
    });
    expect(notification).not.toBeNull();
  });

  it('writes an audit entry for the assignment', async () => {
    await authed(token)
      .post(`${base}/shoots/${shootId}/assignments`)
      .send({ userId: org.member.id, role: 'LEAD_PHOTOGRAPHER' })
      .expect(201);

    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'ShootAssignment', action: 'ASSIGN' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorId).toBe(org.admin.id);
  });

  it('is rejected at the database level even when the service is bypassed', async () => {
    // Direct insert with neither assignee — the CHECK constraint must hold.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO shoot_assignments (id, shoot_id, user_id, freelancer_id, role, status,
           agreed_amount, travel_amount, extra_amount, data_received, assigned_at, created_at, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, NULL, NULL, 'ASSISTANT', 'ASSIGNED', 0, 0, 0, false, now(), now(), now())`,
        shootId,
      ),
    ).rejects.toThrow();
  });
});
