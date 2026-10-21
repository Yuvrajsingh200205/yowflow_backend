import { api, authed, base, login } from './api';
import { seedTestOrganization, TestOrg } from './factory';
import { outbox } from '../../src/services/mailer.service';

export const PORTAL_PASSWORD = 'Portal#Pass2026x';

export interface PortalFixture {
  org: TestOrg;
  staff: ReturnType<typeof authed>;
  clientId: string;
  projectId: string;
  inviteEmail: string;
}

export const tokenFromMail = (m: { text: string }) => decodeURIComponent(/token=([^\s&]+)/.exec(m.text)![1]);

/** A studio with one client and one project, ready to invite a couple. */
export async function seedPortalStudio(email = 'couple@portal.test'): Promise<PortalFixture> {
  const org = await seedTestOrganization();
  const staff = authed(await login(org.admin));
  const client = await staff.post(`${base}/clients`).send({ displayName: 'Aarav & Diya', primaryPhone: '9812345678', primaryEmail: email }).expect(201);
  const project = await staff.post(`${base}/projects`).send({
    clientId: client.body.data.id, name: 'Aarav & Diya — Wedding', type: 'WEDDING', weddingDate: '2026-12-14', totalQuotation: '450000.00',
    events: [{ name: 'Wedding Ceremony', eventDate: '2026-12-14', venueName: 'Fairmont' }],
  }).expect(201);
  return { org, staff, clientId: client.body.data.id, projectId: project.body.data.id, inviteEmail: email };
}

/** Invites the couple, accepts the invite through the e-mailed link, and returns a signed-in agent. */
export async function signedInCouple(f: PortalFixture, fullName = 'Aarav Sharma') {
  outbox.length = 0;
  await f.staff.post(`${base}/clients/${f.clientId}/portal-access`).send({ email: f.inviteEmail, fullName }).expect(201);
  const token = tokenFromMail(outbox[outbox.length - 1]);
  const agent = (await import('supertest')).default.agent((await import('./api')).app);
  const res = await agent.post(`${base}/portal/auth/invite/${token}/accept`).send({ password: PORTAL_PASSWORD }).expect(200);
  return { agent, me: res.body.data };
}

export { api };
