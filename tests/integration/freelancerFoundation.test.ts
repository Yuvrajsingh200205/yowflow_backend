import { beforeEach, describe, expect, it } from 'vitest';
import { api, authed, base, login } from '../helpers/api';
import { prisma, resetDatabase, seedTestOrganization, TestOrg } from '../helpers/factory';
import { isFreelancerSearchable } from '../../src/services/freelancer.service';
import { hashPassword } from '../../src/utils/password';
import { hashRefreshToken } from '../../src/utils/jwt';

const cookieHeader = (response: { headers: Record<string, string | string[] | undefined> }) => {
  const setCookie = response.headers['set-cookie'];
  return Array.isArray(setCookie) ? setCookie.map((cookie) => cookie.split(';')[0]).join('; ') : '';
};

const cookieValue = (cookies: string, name: string) =>
  cookies
    .split('; ')
    .find((cookie) => cookie.startsWith(`${name}=`))
    ?.slice(name.length + 1);

const tokenFromInvitationPath = (path: string) => {
  const url = new URL(path, 'http://localhost');
  return url.searchParams.get('token') ?? '';
};

async function makeSearchableFreelancer(input: {
  organizationId: string;
  fullName: string;
  phone: string;
  email?: string;
  primarySkill?: 'LEAD_PHOTOGRAPHER' | 'CINEMATOGRAPHER' | 'DRONE_OPERATOR';
  skills?: string[];
  city?: string;
  availabilityDate?: string;
}) {
  const freelancer = await prisma.freelancer.create({
    data: {
      organizationId: input.organizationId,
      code: `MKT-${input.phone.slice(-4)}`,
      fullName: input.fullName,
      phone: input.phone,
      email: input.email,
      primarySkill: input.primarySkill ?? 'LEAD_PHOTOGRAPHER',
      skills: input.skills ?? [],
      city: input.city,
    },
  });
  await prisma.freelancerApplication.create({
    data: {
      organizationId: input.organizationId,
      freelancerId: freelancer.id,
      fullName: input.fullName,
      phone: input.phone,
      email: input.email,
      status: 'APPROVED',
    },
  });
  const plan = await prisma.freelancerPlan.create({
    data: { organizationId: input.organizationId, name: `Plan ${input.phone}`, slug: `plan-${input.phone}`, price: '1000.00' },
  });
  await prisma.freelancerSubscription.create({
    data: { freelancerId: freelancer.id, planId: plan.id, status: 'ACTIVE', startedAt: new Date(), currentPeriodEnd: new Date(Date.now() + 86_400_000) },
  });
  if (input.availabilityDate) {
    await prisma.freelancerAvailability.create({
      data: { freelancerId: freelancer.id, date: new Date(`${input.availabilityDate}T00:00:00Z`), status: 'AVAILABLE' },
    });
  }
  return freelancer;
}

describe('freelancer foundation security', () => {
  let org: TestOrg;
  let otherOrg: TestOrg;
  let adminToken: string;
  let memberToken: string;
  let freelancerId: string;
  let projectId: string;
  let shootId: string;

  beforeEach(async () => {
    await resetDatabase();
    org = await seedTestOrganization('foundation-a');
    otherOrg = await seedTestOrganization('foundation-b');
    adminToken = await login(org.admin);
    memberToken = await login(org.member);

    const client = await authed(adminToken)
      .post(`${base}/clients`)
      .send({ displayName: 'Foundation Couple', primaryPhone: '9812345678' })
      .expect(201);

    const project = await authed(adminToken)
      .post(`${base}/projects`)
      .send({ clientId: client.body.data.id, name: 'Foundation Wedding', weddingDate: '2026-12-14' })
      .expect(201);
    projectId = project.body.data.id;

    const shoot = await authed(adminToken)
      .post(`${base}/shoots`)
      .send({ projectId, title: 'Foundation Shoot', shootDate: '2026-12-14' })
      .expect(201);
    shootId = shoot.body.data.id;

    const freelancer = await authed(adminToken)
      .post(`${base}/freelancers`)
      .send({ fullName: 'Foundation Artist', phone: '9900112233', rate: '12000.00' })
      .expect(201);
    freelancerId = freelancer.body.data.id;
  });

  it('rejects unauthenticated and unauthorized freelancer foundation mutations', async () => {
    await api()
      .get(`${base}/freelancers/plans`)
      .expect(401);

    await authed(memberToken)
      .post(`${base}/freelancers/plans`)
      .send({ name: 'Pro', slug: 'pro', price: '1000.00' })
      .expect(403);

    const response = await authed(memberToken)
      .post(`${base}/freelancers/applications`)
      .send({ fullName: 'Applicant', phone: '9876543210' });
    expect(response.status).toBe(403);
  });

  it('keeps application creation submitted-only and detects active duplicates', async () => {
    const created = await authed(adminToken)
      .post(`${base}/freelancers/applications`)
      .send({
        fullName: 'Privilege Escalation Attempt',
        phone: '9876543210',
        email: 'artist@example.com',
        status: 'APPROVED',
      })
      .expect(201);

    expect(created.body.data.status).toBe('SUBMITTED');
    expect(created.body.data.reviewedById).toBeNull();

    const duplicate = await authed(adminToken)
      .post(`${base}/freelancers/applications`)
      .send({ fullName: 'Duplicate Applicant', phone: '9876543210' });
    expect(duplicate.status).toBe(409);
  });

  it('keeps public portal applications submitted-only and ignores tenant/status escalation', async () => {
    const created = await api()
      .post(`${base}/freelancer-portal/applications`)
      .send({
        studio: 'foundation-a',
        organizationId: otherOrg.organizationId,
        fullName: 'Public Applicant',
        phone: '9876543212',
        email: 'public.artist@example.com',
        // Public sign-up sets portal credentials as part of applying.
        password: 'portal-pass-123',
        status: 'APPROVED',
        reviewedById: org.admin.id,
        freelancerId,
      })
      .expect(201);

    expect(created.body.data.status).toBe('SUBMITTED');
    expect(created.body.data.organizationId).toBe(org.organizationId);
    expect(created.body.data.reviewedById).toBeNull();
    // Public sign-up provisions its own freelancer record. What must never
    // happen is the applicant binding their application to somebody else's,
    // so the supplied freelancerId has to be ignored rather than honoured.
    expect(created.body.data.freelancerId).not.toBe(freelancerId);
  });

  it('creates a hashed single-use onboarding token when an application is approved', async () => {
    const application = await authed(adminToken)
      .post(`${base}/freelancers/applications`)
      .send({
        fullName: 'Onboarding Artist',
        phone: '9876543213',
        email: 'onboarding.artist@example.com',
        primarySkill: 'LEAD_PHOTOGRAPHER',
      })
      .expect(201);

    const approved = await authed(adminToken)
      .post(`${base}/freelancers/applications/${application.body.data.id}/review`)
      .send({ status: 'APPROVED' })
      .expect(200);

    expect(approved.body.data.status).toBe('APPROVED');
    expect(approved.body.data.freelancerId).toBeTruthy();
    expect(approved.body.data.onboardingInvitation.expiresAt).toBeTruthy();
    const rawToken = tokenFromInvitationPath(approved.body.data.onboardingInvitation.invitationPath);
    expect(rawToken).toHaveLength(64);

    const stored = await prisma.freelancerOnboardingToken.findFirstOrThrow({
      where: { freelancerId: approved.body.data.freelancerId },
    });
    expect(stored.tokenHash).toBe(hashRefreshToken(rawToken));
    expect(stored.tokenHash).not.toBe(rawToken);
    expect(JSON.stringify(approved.body.data)).not.toContain(stored.tokenHash);

    const valid = await api()
      .get(`${base}/freelancer-portal/onboarding/${rawToken}`)
      .expect(200);
    expect(valid.body.data).toMatchObject({
      valid: true,
      status: 'valid',
      freelancer: { displayName: 'Onboarding Artist', email: 'onboarding.artist@example.com' },
    });
    expect(JSON.stringify(valid.body)).not.toContain('passwordHash');
    expect(JSON.stringify(valid.body)).not.toContain(stored.tokenHash);

    await api()
      .post(`${base}/freelancer-portal/onboarding/${rawToken}/password`)
      .send({ password: 'Freelancer1', confirmPassword: 'Freelancer1' })
      .expect(200);

    const afterUse = await prisma.freelancerOnboardingToken.findUniqueOrThrow({ where: { id: stored.id } });
    expect(afterUse.usedAt).toBeTruthy();
    const freelancer = await prisma.freelancer.findUniqueOrThrow({ where: { id: approved.body.data.freelancerId } });
    expect(freelancer.passwordHash).toBeTruthy();
    expect(freelancer.passwordHash).not.toBe('Freelancer1');

    await api()
      .post(`${base}/freelancer-portal/onboarding/${rawToken}/password`)
      .send({ password: 'Freelancer1', confirmPassword: 'Freelancer1' })
      .expect(409);

    await api()
      .post(`${base}/freelancer-portal/auth/login`)
      .send({ identifier: 'onboarding.artist@example.com', password: 'Freelancer1' })
      .expect(200);
  });

  it('rejects invalid, expired, used and revoked onboarding invitations', async () => {
    const application = await authed(adminToken)
      .post(`${base}/freelancers/applications`)
      .send({ fullName: 'Token States Artist', phone: '9876543214', email: 'token.states@example.com' })
      .expect(201);
    const approved = await authed(adminToken)
      .post(`${base}/freelancers/applications/${application.body.data.id}/review`)
      .send({ status: 'APPROVED' })
      .expect(200);
    const rawToken = tokenFromInvitationPath(approved.body.data.onboardingInvitation.invitationPath);
    const tokenRow = await prisma.freelancerOnboardingToken.findFirstOrThrow({
      where: { freelancerId: approved.body.data.freelancerId },
    });

    const invalid = await api()
      .get(`${base}/freelancer-portal/onboarding/${'x'.repeat(64)}`)
      .expect(200);
    expect(invalid.body.data).toMatchObject({ valid: false, status: 'invalid' });

    await prisma.freelancerOnboardingToken.update({
      where: { id: tokenRow.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await api()
      .get(`${base}/freelancer-portal/onboarding/${rawToken}`)
      .expect(200);
    expect(expired.body.data).toMatchObject({ valid: false, status: 'expired' });
    await api()
      .post(`${base}/freelancer-portal/onboarding/${rawToken}/password`)
      .send({ password: 'Freelancer1', confirmPassword: 'Freelancer1' })
      .expect(401);

    await prisma.freelancerOnboardingToken.update({
      where: { id: tokenRow.id },
      data: { expiresAt: new Date(Date.now() + 86_400_000), invalidatedAt: new Date() },
    });
    const revoked = await api()
      .get(`${base}/freelancer-portal/onboarding/${rawToken}`)
      .expect(200);
    expect(revoked.body.data).toMatchObject({ valid: false, status: 'revoked' });

    const regenerated = await authed(adminToken)
      .post(`${base}/freelancers/applications/${application.body.data.id}/review`)
      .send({ status: 'UNDER_REVIEW' })
      .expect(200);
    expect(regenerated.body.data.status).toBe('UNDER_REVIEW');
  });

  it('regenerating an onboarding token invalidates the previous invitation and the new one works', async () => {
    const application = await authed(adminToken)
      .post(`${base}/freelancers/applications`)
      .send({ fullName: 'Regenerated Artist', phone: '9876543215', email: 'regenerated.artist@example.com' })
      .expect(201);
    const first = await authed(adminToken)
      .post(`${base}/freelancers/applications/${application.body.data.id}/review`)
      .send({ status: 'APPROVED' })
      .expect(200);
    const firstToken = tokenFromInvitationPath(first.body.data.onboardingInvitation.invitationPath);

    await authed(adminToken)
      .post(`${base}/freelancers/applications/${application.body.data.id}/review`)
      .send({ status: 'UNDER_REVIEW' })
      .expect(200);
    const second = await authed(adminToken)
      .post(`${base}/freelancers/applications/${application.body.data.id}/review`)
      .send({ status: 'APPROVED', freelancerId: first.body.data.freelancerId })
      .expect(200);
    const secondToken = tokenFromInvitationPath(second.body.data.onboardingInvitation.invitationPath);
    expect(secondToken).not.toBe(firstToken);

    const firstValidation = await api()
      .get(`${base}/freelancer-portal/onboarding/${firstToken}`)
      .expect(200);
    expect(firstValidation.body.data).toMatchObject({ valid: false, status: 'revoked' });

    await api()
      .post(`${base}/freelancer-portal/onboarding/${secondToken}/password`)
      .send({ password: 'Freelancer1', confirmPassword: 'Freelancer1' })
      .expect(200);
  });

  it('searches only searchable freelancers with availability, specialization and safe fields', async () => {
    const searchable = await makeSearchableFreelancer({
      organizationId: org.organizationId,
      fullName: 'Marketplace Photographer',
      phone: '9876543216',
      email: 'marketplace.photo@example.com',
      primarySkill: 'LEAD_PHOTOGRAPHER',
      skills: ['candid', 'wedding'],
      city: 'Jaipur',
      availabilityDate: '2026-10-15',
    });
    await prisma.freelancer.create({
      data: {
        organizationId: org.organizationId,
        code: 'MKT-NOPE',
        fullName: 'Not Searchable',
        phone: '9876543217',
        primarySkill: 'LEAD_PHOTOGRAPHER',
        skills: ['candid'],
        city: 'Jaipur',
      },
    });
    await makeSearchableFreelancer({
      organizationId: otherOrg.organizationId,
      fullName: 'Other Org Searchable',
      phone: '9876543218',
      city: 'Jaipur',
      availabilityDate: '2026-10-15',
    });

    const response = await authed(adminToken)
      .get(`${base}/freelancers/search?q=candid&location=Jaipur&specialization=LEAD_PHOTOGRAPHER&availabilityDate=2026-10-15&pageSize=20`)
      .expect(200);

    expect(response.body.data.map((item: { id: string }) => item.id)).toEqual([searchable.id]);
    expect(JSON.stringify(response.body)).not.toContain('passwordHash');
    expect(JSON.stringify(response.body)).not.toContain('failedLoginAttempts');
    expect(JSON.stringify(response.body)).not.toContain('payout');
  });

  it('creates interested connections once and rejects non-searchable freelancers', async () => {
    const searchable = await makeSearchableFreelancer({
      organizationId: org.organizationId,
      fullName: 'Interested Artist',
      phone: '9876543219',
      availabilityDate: '2026-10-15',
    });
    const nonSearchable = await prisma.freelancer.create({
      data: { organizationId: org.organizationId, code: 'MKT-RAW', fullName: 'Raw Artist', phone: '9876543220' },
    });

    await authed(adminToken)
      .post(`${base}/freelancers/connections`)
      .send({ freelancerId: searchable.id, status: 'INTERESTED' })
      .expect(201);
    await authed(adminToken)
      .post(`${base}/freelancers/connections`)
      .send({ freelancerId: searchable.id, status: 'INTERESTED' })
      .expect(409);
    await authed(adminToken)
      .post(`${base}/freelancers/connections`)
      .send({ freelancerId: nonSearchable.id, status: 'INTERESTED' })
      .expect(409);
    await authed(memberToken)
      .post(`${base}/freelancers/connections`)
      .send({ freelancerId: searchable.id, status: 'INTERESTED' })
      .expect(403);

    const expired = await authed(adminToken)
      .patch(`${base}/freelancers/connections/${(await prisma.freelancerConnection.findFirstOrThrow({ where: { freelancerId: searchable.id } })).id}`)
      .send({ status: 'EXPIRED' })
      .expect(200);
    expect(expired.body.data.status).toBe('EXPIRED');
    await authed(adminToken)
      .patch(`${base}/freelancers/connections/${expired.body.data.id}`)
      .send({ status: 'CONTACTED' })
      .expect(409);
  });

  it('connects an interested freelancer to a project shoot using ShootAssignment validation', async () => {
    const freelancer = await makeSearchableFreelancer({
      organizationId: org.organizationId,
      fullName: 'Connect Artist',
      phone: '9876543221',
      primarySkill: 'CINEMATOGRAPHER',
      availabilityDate: '2026-12-14',
    });
    const connection = await authed(adminToken)
      .post(`${base}/freelancers/connections`)
      .send({ freelancerId: freelancer.id, status: 'INTERESTED' })
      .expect(201);

    // Connecting is a two-step consent flow: the first call only asks the
    // freelancer to approve, and books nothing.
    const requested = await authed(adminToken)
      .post(`${base}/freelancers/connections/${connection.body.data.id}/connect`)
      .send({ projectId, shootId, role: 'CINEMATOGRAPHER' })
      .expect(200);
    expect(requested.body.data.connection.status).toBe('CONTACTED');
    expect(requested.body.data.assignment).toBeNull();
    expect(await prisma.shootAssignment.count({ where: { freelancerId: freelancer.id, shootId } })).toBe(0);

    // The freelancer accepts, and only then does connecting create the booking.
    await authed(adminToken)
      .patch(`${base}/freelancers/connections/${connection.body.data.id}`)
      .send({ status: 'ACCEPTED' })
      .expect(200);

    const connected = await authed(adminToken)
      .post(`${base}/freelancers/connections/${connection.body.data.id}/connect`)
      .send({ projectId, shootId, role: 'CINEMATOGRAPHER' })
      .expect(200);

    expect(connected.body.data.connection.status).toBe('ASSIGNED');
    expect(connected.body.data.assignment.freelancerId).toBe(freelancer.id);
    expect(await prisma.shootAssignment.count({ where: { freelancerId: freelancer.id, shootId } })).toBe(1);
    await authed(adminToken)
      .post(`${base}/freelancers/connections/${connection.body.data.id}/connect`)
      .send({ projectId, shootId, role: 'CINEMATOGRAPHER' })
      .expect(409);
    expect(await prisma.shootAssignment.count({ where: { freelancerId: freelancer.id, shootId } })).toBe(1);

    const secondClient = await authed(adminToken)
      .post(`${base}/clients`)
      .send({ displayName: 'Wrong Project Couple', primaryPhone: '9812345688' })
      .expect(201);
    const secondProject = await authed(adminToken)
      .post(`${base}/projects`)
      .send({ clientId: secondClient.body.data.id, name: 'Wrong Project' })
      .expect(201);
    const another = await makeSearchableFreelancer({
      organizationId: org.organizationId,
      fullName: 'Mismatch Artist',
      phone: '9876543222',
    });
    const mismatchConnection = await authed(adminToken)
      .post(`${base}/freelancers/connections`)
      .send({ freelancerId: another.id, status: 'INTERESTED' })
      .expect(201);
    await authed(adminToken)
      .post(`${base}/freelancers/connections/${mismatchConnection.body.data.id}/connect`)
      .send({ projectId: secondProject.body.data.id, shootId, role: 'LEAD_PHOTOGRAPHER' })
      .expect(409);
  });

  /** A connection only books a shoot once the freelancer has accepted it. */
  const acceptConnection = (connectionId: string) =>
    authed(adminToken)
      .patch(`${base}/freelancers/connections/${connectionId}`)
      .send({ status: 'ACCEPTED' })
      .expect(200);

  it('allows valid assignment combinations without merging connection and assignment lifecycle', async () => {
    const sameFreelancer = await makeSearchableFreelancer({
      organizationId: org.organizationId,
      fullName: 'Multi Shoot Artist',
      phone: '9876543223',
      primarySkill: 'LEAD_PHOTOGRAPHER',
      availabilityDate: '2026-12-14',
    });
    await prisma.freelancer.update({ where: { id: sameFreelancer.id }, data: { maxShootsPerDay: 2 } });
    const secondShoot = await authed(adminToken)
      .post(`${base}/shoots`)
      .send({ projectId, title: 'Different Shoot', shootDate: '2026-12-15' })
      .expect(201);
    const firstConnection = await authed(adminToken)
      .post(`${base}/freelancers/connections`)
      .send({ freelancerId: sameFreelancer.id, projectId, shootId, status: 'INTERESTED' })
      .expect(201);
    const secondConnection = await authed(adminToken)
      .post(`${base}/freelancers/connections`)
      .send({ freelancerId: sameFreelancer.id, projectId, shootId: secondShoot.body.data.id, status: 'INTERESTED' })
      .expect(201);
    await acceptConnection(firstConnection.body.data.id);
    await authed(adminToken)
      .post(`${base}/freelancers/connections/${firstConnection.body.data.id}/connect`)
      .send({ projectId, shootId, role: 'LEAD_PHOTOGRAPHER' })
      .expect(200);
    await acceptConnection(secondConnection.body.data.id);
    await authed(adminToken)
      .post(`${base}/freelancers/connections/${secondConnection.body.data.id}/connect`)
      .send({ projectId, shootId: secondShoot.body.data.id, role: 'LEAD_PHOTOGRAPHER' })
      .expect(200);

    const otherFreelancer = await makeSearchableFreelancer({
      organizationId: org.organizationId,
      fullName: 'Same Shoot Artist',
      phone: '9876543224',
      primarySkill: 'DRONE_OPERATOR',
      availabilityDate: '2026-12-14',
    });
    const otherConnection = await authed(adminToken)
      .post(`${base}/freelancers/connections`)
      .send({ freelancerId: otherFreelancer.id, projectId, shootId, status: 'INTERESTED' })
      .expect(201);
    await acceptConnection(otherConnection.body.data.id);
    await authed(adminToken)
      .post(`${base}/freelancers/connections/${otherConnection.body.data.id}/connect`)
      .send({ projectId, shootId, role: 'DRONE_OPERATOR' })
      .expect(200);

    await authed(adminToken)
      .patch(`${base}/freelancers/connections/${otherConnection.body.data.id}`)
      .send({ status: 'EXPIRED' })
      .expect(409);
    expect(await prisma.shootAssignment.count({ where: { shootId } })).toBeGreaterThanOrEqual(2);
  });

  it('keeps marketplace connect tenant-scoped across freelancers, projects and shoots', async () => {
    const orgFreelancer = await makeSearchableFreelancer({
      organizationId: org.organizationId,
      fullName: 'Tenant A Artist',
      phone: '9876543225',
    });
    const otherFreelancer = await makeSearchableFreelancer({
      organizationId: otherOrg.organizationId,
      fullName: 'Tenant B Artist',
      phone: '9876543226',
    });
    const otherToken = await login(otherOrg.admin);
    const otherClient = await authed(otherToken)
      .post(`${base}/clients`)
      .send({ displayName: 'Other Tenant Couple', primaryPhone: '9812345690' })
      .expect(201);
    const otherProject = await authed(otherToken)
      .post(`${base}/projects`)
      .send({ clientId: otherClient.body.data.id, name: 'Other Tenant Wedding' })
      .expect(201);
    const otherShoot = await authed(otherToken)
      .post(`${base}/shoots`)
      .send({ projectId: otherProject.body.data.id, title: 'Other Tenant Shoot', shootDate: '2026-12-16' })
      .expect(201);

    await authed(adminToken)
      .post(`${base}/freelancers/connections`)
      .send({ freelancerId: otherFreelancer.id, status: 'INTERESTED' })
      .expect(404);
    const connection = await authed(adminToken)
      .post(`${base}/freelancers/connections`)
      .send({ freelancerId: orgFreelancer.id, status: 'INTERESTED' })
      .expect(201);
    await authed(adminToken)
      .post(`${base}/freelancers/connections/${connection.body.data.id}/connect`)
      .send({ projectId: otherProject.body.data.id, role: 'LEAD_PHOTOGRAPHER' })
      .expect(404);
    await authed(adminToken)
      .post(`${base}/freelancers/connections/${connection.body.data.id}/connect`)
      .send({ projectId, shootId: otherShoot.body.data.id, role: 'LEAD_PHOTOGRAPHER' })
      .expect(404);
    await authed(otherToken)
      .post(`${base}/freelancers/connections/${connection.body.data.id}/connect`)
      .send({ projectId: otherProject.body.data.id, shootId: otherShoot.body.data.id, role: 'LEAD_PHOTOGRAPHER' })
      .expect(404);
  });

  it('shows marketplace shoot assignments only to the assigned freelancer portal account', async () => {
    const freelancerA = await makeSearchableFreelancer({
      organizationId: org.organizationId,
      fullName: 'Portal Assigned Artist',
      phone: '9876543227',
      email: 'portal.assigned@example.com',
    });
    const freelancerB = await makeSearchableFreelancer({
      organizationId: org.organizationId,
      fullName: 'Portal Other Artist',
      phone: '9876543228',
      email: 'portal.other@example.com',
    });
    await prisma.freelancer.updateMany({
      where: { id: { in: [freelancerA.id, freelancerB.id] } },
      data: { passwordHash: await hashPassword('Freelancer1') },
    });
    const connection = await authed(adminToken)
      .post(`${base}/freelancers/connections`)
      .send({ freelancerId: freelancerA.id, projectId, shootId, status: 'INTERESTED' })
      .expect(201);
    await acceptConnection(connection.body.data.id);
    await authed(adminToken)
      .post(`${base}/freelancers/connections/${connection.body.data.id}/connect`)
      .send({ projectId, shootId, role: 'LEAD_PHOTOGRAPHER' })
      .expect(200);

    const loginA = await api()
      .post(`${base}/freelancer-portal/auth/login`)
      .send({ identifier: 'portal.assigned@example.com', password: 'Freelancer1' })
      .expect(200);
    const loginB = await api()
      .post(`${base}/freelancer-portal/auth/login`)
      .send({ identifier: 'portal.other@example.com', password: 'Freelancer1' })
      .expect(200);
    const meA = await api()
      .get(`${base}/freelancer-portal/me`)
      .set('Cookie', cookieHeader(loginA))
      .expect(200);
    const meB = await api()
      .get(`${base}/freelancer-portal/me`)
      .set('Cookie', cookieHeader(loginB))
      .expect(200);
    expect(meA.body.data.freelancer.assignments.some((item: { shoot?: { id: string } }) => item.shoot?.id === shootId)).toBe(true);
    expect(meB.body.data.freelancer.assignments.some((item: { shoot?: { id: string } }) => item.shoot?.id === shootId)).toBe(false);
  });

  it('enforces organization boundaries for subscriptions and connections', async () => {
    const otherFreelancer = await prisma.freelancer.create({
      data: {
        organizationId: otherOrg.organizationId,
        code: 'F-OTHER',
        fullName: 'Other Org Artist',
        phone: '9876500000',
      },
    });
    const otherPlan = await prisma.freelancerPlan.create({
      data: {
        organizationId: otherOrg.organizationId,
        name: 'Other Plan',
        slug: 'other-plan',
        price: '1000.00',
      },
    });

    await authed(adminToken)
      .post(`${base}/freelancers/${otherFreelancer.id}/subscriptions`)
      .send({ planId: otherPlan.id })
      .expect(404);

    await authed(adminToken)
      .post(`${base}/freelancers/connections`)
      .send({ freelancerId: otherFreelancer.id, projectId })
      .expect(404);
  });

  it('validates subscription status transitions', async () => {
    const plan = await authed(adminToken)
      .post(`${base}/freelancers/plans`)
      .send({ name: 'Studio Pro', slug: 'studio-pro', price: '1500.00' })
      .expect(201);

    const subscription = await authed(adminToken)
      .post(`${base}/freelancers/${freelancerId}/subscriptions`)
      .send({ planId: plan.body.data.id, status: 'ACTIVE' })
      .expect(201);

    const invalid = await authed(adminToken)
      .patch(`${base}/freelancers/${freelancerId}/subscriptions/${subscription.body.data.id}`)
      .send({ status: 'PENDING' });
    expect(invalid.status).toBe(409);
  });

  it('prevents duplicate active connections while allowing different contexts', async () => {
    const plan = await prisma.freelancerPlan.create({
      data: { organizationId: org.organizationId, name: 'Connection Plan', slug: 'connection-plan', price: '1000.00' },
    });
    await prisma.freelancerApplication.create({
      data: {
        organizationId: org.organizationId,
        freelancerId,
        fullName: 'Foundation Artist',
        phone: '9900112233',
        status: 'APPROVED',
      },
    });
    await prisma.freelancerSubscription.create({
      data: { freelancerId, planId: plan.id, status: 'ACTIVE', startedAt: new Date(), currentPeriodEnd: new Date(Date.now() + 86_400_000) },
    });

    await authed(adminToken)
      .post(`${base}/freelancers/connections`)
      .send({ freelancerId, projectId })
      .expect(201);

    await authed(adminToken)
      .post(`${base}/freelancers/connections`)
      .send({ freelancerId, projectId })
      .expect(409);

    const secondClient = await authed(adminToken)
      .post(`${base}/clients`)
      .send({ displayName: 'Second Couple', primaryPhone: '9812345679' })
      .expect(201);
    const secondProject = await authed(adminToken)
      .post(`${base}/projects`)
      .send({ clientId: secondClient.body.data.id, name: 'Second Wedding' })
      .expect(201);

    await authed(adminToken)
      .post(`${base}/freelancers/connections`)
      .send({ freelancerId, projectId: secondProject.body.data.id })
      .expect(201);
  });

  it('rejects a connection when the shoot does not belong to the selected project', async () => {
    const secondClient = await authed(adminToken)
      .post(`${base}/clients`)
      .send({ displayName: 'Mismatch Couple', primaryPhone: '9812345680' })
      .expect(201);
    const secondProject = await authed(adminToken)
      .post(`${base}/projects`)
      .send({ clientId: secondClient.body.data.id, name: 'Mismatch Wedding' })
      .expect(201);

    const response = await authed(adminToken)
      .post(`${base}/freelancers/connections`)
      .send({ freelancerId, projectId: secondProject.body.data.id, shootId });
    expect(response.status).toBe(409);
  });

  it('rejects portfolio attachment to a file from another organization', async () => {
    const otherFile = await prisma.fileObject.create({
      data: {
        organizationId: otherOrg.organizationId,
        entityType: 'FREELANCER_PORTFOLIO',
        bucket: 'test',
        objectKey: 'other-org/portfolio.jpg',
        originalName: 'portfolio.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1000n,
      },
    });

    await authed(adminToken)
      .post(`${base}/freelancers/${freelancerId}/portfolio`)
      .send({ fileObjectId: otherFile.id, title: 'Other file' })
      .expect(404);
  });

  it('rejects portal portfolio attachment to another freelancer file in the same organization', async () => {
    await prisma.freelancer.update({
      where: { id: freelancerId },
      data: { email: 'file.artist@example.com', passwordHash: await hashPassword('Freelancer1') },
    });
    const other = await prisma.freelancer.create({
      data: {
        organizationId: org.organizationId,
        code: 'F-FILE',
        fullName: 'File Owner',
        phone: '9876512222',
      },
    });
    const otherFile = await prisma.fileObject.create({
      data: {
        organizationId: org.organizationId,
        entityType: 'FREELANCER_PORTFOLIO',
        entityId: other.id,
        bucket: 'test',
        objectKey: 'same-org/other-freelancer.jpg',
        originalName: 'portfolio.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1000n,
      },
    });
    const loginResponse = await api()
      .post(`${base}/freelancer-portal/auth/login`)
      .send({ identifier: 'file.artist@example.com', password: 'Freelancer1' })
      .expect(200);

    await api()
      .post(`${base}/freelancer-portal/portfolio`)
      .set('Cookie', cookieHeader(loginResponse))
      .send({ fileObjectId: otherFile.id, title: 'Other file' })
      .expect(404);
  });

  it('validates availability time order and keeps list pagination bounded', async () => {
    const invalid = await authed(adminToken)
      .put(`${base}/freelancers/${freelancerId}/availability`)
      .send({
        date: '2026-12-14',
        status: 'PARTIALLY_AVAILABLE',
        startTime: '2026-12-14T14:00:00.000Z',
        endTime: '2026-12-14T10:00:00.000Z',
      });
    expect(invalid.status).toBe(400);

    const listed = await authed(adminToken)
      .get(`${base}/freelancers/plans?limit=100000`)
      .expect(400);
    expect(listed.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('centralizes search eligibility around approved application and active subscription', async () => {
    const plan = await prisma.freelancerPlan.create({
      data: {
        organizationId: org.organizationId,
        name: 'Searchable',
        slug: 'searchable',
        price: '1000.00',
      },
    });

    expect(await isFreelancerSearchable(org.organizationId, freelancerId)).toBe(false);

    await prisma.freelancerApplication.create({
      data: {
        organizationId: org.organizationId,
        freelancerId,
        fullName: 'Foundation Artist',
        phone: '9900112233',
        status: 'APPROVED',
        reviewedById: org.admin.id,
        reviewedAt: new Date(),
      },
    });
    await prisma.freelancerSubscription.create({
      data: {
        freelancerId,
        planId: plan.id,
        status: 'ACTIVE',
        startedAt: new Date(),
        currentPeriodEnd: new Date(Date.now() + 86_400_000),
      },
    });

    expect(await isFreelancerSearchable(org.organizationId, freelancerId)).toBe(true);
  });

  it('authenticates a freelancer with httpOnly cookies and exposes only own safe portal data', async () => {
    await prisma.freelancer.update({
      where: { id: freelancerId },
      data: { email: 'foundation.artist@example.com', passwordHash: await hashPassword('Freelancer1') },
    });
    const other = await prisma.freelancer.create({
      data: {
        organizationId: org.organizationId,
        code: 'F-SECOND',
        fullName: 'Second Artist',
        phone: '9876511111',
        passwordHash: await hashPassword('Freelancer1'),
      },
    });
    await prisma.freelancerAvailability.create({
      data: { freelancerId: other.id, date: new Date('2026-12-20T00:00:00Z'), status: 'AVAILABLE' },
    });

    await api()
      .get(`${base}/freelancer-portal/me`)
      .expect(401);

    const bad = await api()
      .post(`${base}/freelancer-portal/auth/login`)
      .send({ identifier: 'foundation.artist@example.com', password: 'WrongPass1' });
    expect(bad.status).toBe(401);

    const loginResponse = await api()
      .post(`${base}/freelancer-portal/auth/login`)
      .send({ identifier: 'foundation.artist@example.com', password: 'Freelancer1' })
      .expect(200);
    const cookies = cookieHeader(loginResponse);
    expect(cookies).toContain('yf_freelancer_access_token=');
    expect(cookies).toContain('yf_freelancer_refresh_token=');
    expect(JSON.stringify(loginResponse.body)).not.toContain('accessToken');
    expect(JSON.stringify(loginResponse.body)).not.toContain('refreshToken');
    expect(JSON.stringify(loginResponse.body)).not.toContain('passwordHash');
    expect(JSON.stringify(loginResponse.body)).not.toContain('failedLoginAttempts');
    expect(JSON.stringify(loginResponse.body)).not.toContain('lockedUntil');
    const accessCookieValue = cookieValue(cookies, 'yf_freelancer_access_token');
    expect(accessCookieValue).toBeTruthy();

    await api()
      .get(`${base}/freelancer-portal/me`)
      .set('Authorization', `Bearer ${accessCookieValue}`)
      .expect(401);

    const me = await api()
      .get(`${base}/freelancer-portal/me`)
      .set('Cookie', cookies)
      .expect(200);
    expect(me.body.data.freelancer.id).toBe(freelancerId);
    expect(me.body.data.freelancer.availability).toHaveLength(0);
    expect(JSON.stringify(me.body)).not.toContain('passwordHash');
    expect(JSON.stringify(me.body)).not.toContain('objectKey');

    await api()
      .put(`${base}/freelancer-portal/availability`)
      .set('Cookie', cookies)
      .send({ date: '2026-12-21', status: 'AVAILABLE' })
      .expect(200);

    expect(await prisma.freelancerAvailability.count({ where: { freelancerId } })).toBe(1);
    expect(await prisma.freelancerAvailability.count({ where: { freelancerId: other.id } })).toBe(1);

    const refreshed = await api()
      .post(`${base}/freelancer-portal/auth/refresh`)
      .set('Cookie', cookies)
      .expect(200);
    const refreshedCookies = cookieHeader(refreshed);
    expect(refreshedCookies).toContain('yf_freelancer_access_token=');
    expect(JSON.stringify(refreshed.body)).not.toContain('accessToken');

    await api()
      .post(`${base}/freelancer-portal/auth/refresh`)
      .set('Cookie', cookies)
      .expect(401);

    await api()
      .post(`${base}/freelancer-portal/auth/logout`)
      .set('Cookie', refreshedCookies)
      .expect(200);
    await api()
      .get(`${base}/freelancer-portal/me`)
      .set('Cookie', refreshedCookies)
      .expect(401);
  });

  it('scopes operational portal projects, shoots, tasks, payouts and client privacy to the logged-in freelancer', async () => {
    await prisma.freelancer.update({
      where: { id: freelancerId },
      data: { email: 'ops.artist@example.com', passwordHash: await hashPassword('Freelancer1') },
    });
    const otherFreelancer = await prisma.freelancer.create({
      data: { organizationId: org.organizationId, code: 'OPS-OTHER', fullName: 'Other Ops Artist', phone: '9876500001' },
    });
    const ownAssignment = await prisma.shootAssignment.create({
      data: { shootId, freelancerId, role: 'LEAD_PHOTOGRAPHER', status: 'ASSIGNED' },
    });
    const otherClient = await prisma.client.create({
      data: { organizationId: org.organizationId, clientCode: 'CLI-PRIVATE', displayName: 'Private Client', primaryPhone: '9876500002', primaryEmail: 'private@example.test' },
    });
    const otherProject = await prisma.project.create({
      data: { organizationId: org.organizationId, clientId: otherClient.id, projectNumber: 'PRJ-PRIVATE', name: 'Private Project', weddingDate: new Date('2026-12-20T00:00:00Z') },
    });
    const otherShoot = await prisma.shoot.create({
      data: { organizationId: org.organizationId, projectId: otherProject.id, title: 'Private Shoot', shootDate: new Date('2026-12-20T00:00:00Z') },
    });
    await prisma.shootAssignment.create({ data: { shootId: otherShoot.id, freelancerId: otherFreelancer.id, role: 'CINEMATOGRAPHER' } });
    const ownTask = await prisma.task.create({
      data: { organizationId: org.organizationId, projectId, shootId, title: 'Pack camera kit', description: 'Bring primes', status: 'ASSIGNED', priority: 'HIGH', dueDate: new Date('2026-12-13T00:00:00Z') },
    });
    const otherTask = await prisma.task.create({
      data: { organizationId: org.organizationId, projectId: otherProject.id, shootId: otherShoot.id, title: 'Private task', status: 'ASSIGNED' },
    });
    const expense = await prisma.expense.create({
      data: {
        organizationId: org.organizationId,
        branchId: org.branchId,
        projectId,
        shootId,
        freelancerId,
        categoryId: org.expenseCategoryId,
        amount: '5000.00',
        expenseDate: new Date('2026-12-15T00:00:00Z'),
        approvalStatus: 'APPROVED',
        approvedById: org.admin.id,
        approvedAt: new Date(),
        createdById: org.admin.id,
      },
    });
    await prisma.freelancerPayout.create({
      data: {
        organizationId: org.organizationId,
        freelancerId,
        assignmentId: ownAssignment.id,
        expenseId: expense.id,
        amount: '5000.00',
        paymentDate: new Date('2026-12-15T00:00:00Z'),
        transactionRef: 'UTR-OPS-1',
      },
    });
    await prisma.notification.create({
      data: { organizationId: org.organizationId, userId: org.admin.id, title: 'Admin only', message: 'Hidden from freelancers', entityType: 'Project', entityId: projectId },
    });

    const loginResponse = await api()
      .post(`${base}/freelancer-portal/auth/login`)
      .send({ identifier: 'ops.artist@example.com', password: 'Freelancer1' })
      .expect(200);
    const cookies = cookieHeader(loginResponse);

    const projects = await api().get(`${base}/freelancer-portal/projects`).set('Cookie', cookies).expect(200);
    expect(projects.body.data.items.map((item: { id: string }) => item.id)).toContain(projectId);
    expect(projects.body.data.items.map((item: { id: string }) => item.id)).not.toContain(otherProject.id);
    expect(JSON.stringify(projects.body)).not.toContain('private@example.test');
    expect(JSON.stringify(projects.body)).not.toContain('9876500002');

    await api().get(`${base}/freelancer-portal/projects/${otherProject.id}`).set('Cookie', cookies).expect(404);

    const shoots = await api().get(`${base}/freelancer-portal/shoots?view=all`).set('Cookie', cookies).expect(200);
    expect(shoots.body.data.items.map((item: { id: string }) => item.id)).toContain(shootId);
    expect(shoots.body.data.items.map((item: { id: string }) => item.id)).not.toContain(otherShoot.id);
    await api().get(`${base}/freelancer-portal/shoots/${otherShoot.id}`).set('Cookie', cookies).expect(404);

    const tasks = await api().get(`${base}/freelancer-portal/tasks`).set('Cookie', cookies).expect(200);
    expect(tasks.body.data.items.map((item: { id: string }) => item.id)).toContain(ownTask.id);
    expect(tasks.body.data.items.map((item: { id: string }) => item.id)).not.toContain(otherTask.id);
    await api().patch(`${base}/freelancer-portal/tasks/${otherTask.id}`).set('Cookie', cookies).send({ status: 'IN_PROGRESS' }).expect(404);
    const updated = await api().patch(`${base}/freelancer-portal/tasks/${ownTask.id}`).set('Cookie', cookies).send({ status: 'IN_PROGRESS' }).expect(200);
    expect(updated.body.data.status).toBe('IN_PROGRESS');

    const payments = await api().get(`${base}/freelancer-portal/payments`).set('Cookie', cookies).expect(200);
    expect(payments.body.data.items).toHaveLength(1);
    expect(payments.body.data.items[0].transactionRef).toBe('UTR-OPS-1');
    expect(JSON.stringify(payments.body)).not.toContain('Admin only');

    const notifications = await api().get(`${base}/freelancer-portal/notifications`).set('Cookie', cookies).expect(200);
    expect(notifications.body.data.items).toHaveLength(0);
  });
});
