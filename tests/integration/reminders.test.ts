import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api, authed, base, login } from '../helpers/api';
import { env } from '../../src/config/env';
import { outbox } from '../../src/services/mailer.service';
import { paymentTier, runReminders } from '../../src/services/reminders.service';
import { prisma, resetDatabase } from '../helpers/factory';
import { SalesFixture, seedSalesStudio, ymdPlus } from '../helpers/sales';

const date = (offset: number) => new Date(`${ymdPlus(offset)}T00:00:00Z`);

describe('reminders', () => {
  let f: SalesFixture;
  const mutable = env as unknown as Record<string, unknown>;
  beforeEach(async () => { await resetDatabase(); outbox.length = 0; f = await seedSalesStudio(); });
  afterEach(() => { mutable.CRON_SECRET = undefined; });

  const booking = async (dueOffset: number, over: { status?: string; milestoneStatus?: string; email?: string | null; projectStatus?: 'UPCOMING' | 'CANCELLED' } = {}) => {
    const client = await prisma.client.create({ data: { organizationId: f.org.organizationId, clientCode: `CLI-R${Math.random().toString(36).slice(2, 6)}`, displayName: 'Meera Kapoor', primaryPhone: '9811111111', primaryEmail: over.email === undefined ? 'meera@example.test' : over.email } });
    const project = await prisma.project.create({ data: { organizationId: f.org.organizationId, clientId: client.id, projectNumber: `PRJ-R${Math.random().toString(36).slice(2, 6)}`, name: 'Meera wedding', status: over.projectStatus ?? 'UPCOMING', weddingDate: date(60), managerId: f.org.admin.id } });
    const milestone = await prisma.paymentMilestone.create({ data: { organizationId: f.org.organizationId, projectId: project.id, title: 'Advance', amount: 25000, dueDate: date(dueOffset), status: over.milestoneStatus ?? 'PENDING' } });
    return { client, project, milestone };
  };
  const logs = (kind?: string) => prisma.reminderLog.count({ where: kind ? { kind } : {} });

  it('picks the right reminder tier for how close or late a payment is', () => {
    const tiers = [4, 3, 1, 0, -1, -3, -4, -7, -8, -30, -31].map((d) => [d, paymentTier(d)]);
    expect(tiers).toEqual([[4, null], [3, 'SOON'], [1, 'SOON'], [0, 'TODAY'], [-1, 'OVERDUE_1'], [-3, 'OVERDUE_1'], [-4, 'OVERDUE_2'], [-7, 'OVERDUE_2'], [-8, 'OVERDUE_3'], [-30, 'OVERDUE_3'], [-31, null]]);
  });

  it('reminds the client and the studio about an upcoming payment once, however often the job runs', async () => {
    const { project } = await booking(2);
    const first = await runReminders();
    expect(first).toMatchObject({ paymentEmails: 1, paymentNotices: 1 });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ to: 'meera@example.test', fromName: 'Test Studio' });
    expect(outbox[0].subject).toContain('Payment reminder: Advance');
    expect(outbox[0].text).toContain('₹25,000');
    expect(await prisma.notification.count({ where: { entityId: project.id, title: { contains: 'Payment due' } } })).toBe(1);

    const again = await runReminders();
    expect(again).toMatchObject({ paymentEmails: 0, paymentNotices: 0 });
    expect(outbox).toHaveLength(1);
    expect(await logs()).toBe(2);
  });

  it('chases overdue payments in steps, and stops for paid, cancelled or far-off ones', async () => {
    const late = await booking(-2);
    await runReminders();
    expect(outbox[0].subject).toContain('Payment overdue');
    // a week later, the next step
    await prisma.paymentMilestone.update({ where: { id: late.milestone.id }, data: { dueDate: date(-9) } });
    outbox.length = 0;
    await runReminders();
    expect(outbox).toHaveLength(1);
    expect(await logs('PAYMENT_OVERDUE_3')).toBeGreaterThan(0);

    await resetDatabase(); outbox.length = 0; f = await seedSalesStudio();
    await booking(-2, { milestoneStatus: 'RECEIVED' });
    await booking(-2, { projectStatus: 'CANCELLED' });
    await booking(10);
    await booking(-40);
    expect(await runReminders()).toMatchObject({ paymentEmails: 0, paymentNotices: 0 });
    expect(outbox).toHaveLength(0);
  });

  it('respects the studio’s switches and a missing e-mail address', async () => {
    await booking(2, { email: null });
    expect(await runReminders()).toMatchObject({ paymentEmails: 0, paymentNotices: 1 });
    await resetDatabase(); outbox.length = 0; f = await seedSalesStudio();
    await booking(2);
    await f.staff.put(`${base}/sales-setup/settings`).send({ remindersEmailClients: false }).expect(200);
    expect(await runReminders()).toMatchObject({ paymentEmails: 0, paymentNotices: 1 });
    await f.staff.put(`${base}/sales-setup/settings`).send({ remindersEnabled: false }).expect(200);
    await prisma.reminderLog.deleteMany();
    expect(await runReminders()).toMatchObject({ organizations: 0, paymentNotices: 0 });
  });

  it('nudges a quotation nobody opened, warns before it lapses, and expires it afterwards', async () => {
    const make = (over: Record<string, unknown>) => prisma.quotation.create({ data: {
      organizationId: f.org.organizationId, quotationNumber: `QTN-R${Math.random().toString(36).slice(2, 6)}`, issueDate: date(-6), validUntil: date(10), grandTotal: 1000, status: 'SENT', publicToken: `t${Math.random().toString(36).slice(2)}${'x'.repeat(30)}`,
      customerName: 'Quiet Customer', customerEmail: 'quiet@example.test', sentAt: new Date(Date.now() - 72 * 3_600_000), createdById: f.org.admin.id, ...over } });
    const unopened = await make({});
    const opened = await make({ firstViewedAt: new Date(), viewCount: 1 });
    const expiring = await make({ validUntil: date(1), firstViewedAt: new Date() });
    const lapsed = await make({ issueDate: date(-12), validUntil: date(-3), firstViewedAt: new Date() });

    const res = await runReminders();
    expect(res.quotesExpired).toBe(1);
    expect((await prisma.quotation.findUniqueOrThrow({ where: { id: lapsed.id } })).status).toBe('EXPIRED');
    expect(await prisma.quotationEvent.count({ where: { quotationId: lapsed.id, type: 'EXPIRED' } })).toBe(1);
    const subjects = outbox.map((m) => `${m.to}|${m.subject}`);
    expect(outbox).toHaveLength(2); // one "not opened" for the unopened quote, one "expires soon"
    expect(subjects.some((s) => s.includes('quiet@example.test'))).toBe(true);
    expect(outbox.some((m) => m.subject.includes('expires soon'))).toBe(true);
    expect(await prisma.notification.count({ where: { entityId: unopened.id, title: { contains: 'Not opened' } } })).toBe(1);
    expect(await prisma.notification.count({ where: { entityId: opened.id } })).toBe(0);
    expect(await prisma.notification.count({ where: { entityId: expiring.id, title: { contains: 'Expires' } } })).toBe(1);
    outbox.length = 0;
    await runReminders();
    expect(outbox).toHaveLength(0);
  });

  it('tells the studio about enquiry drafts that have waited for review', async () => {
    const q = await prisma.quotation.create({ data: { organizationId: f.org.organizationId, quotationNumber: 'QTN-REVIEW', issueDate: date(0), grandTotal: 500, status: 'DRAFT', needsReview: true, autoGenerated: true, customerName: 'Waiting Customer', createdAt: new Date(Date.now() - 5 * 3_600_000) } });
    expect(await runReminders()).toMatchObject({ reviewNotices: 1 });
    expect(await prisma.notification.count({ where: { entityId: q.id } })).toBeGreaterThan(0);
    expect(await runReminders()).toMatchObject({ reviewNotices: 0 });
  });

  it('exposes a today list with WhatsApp links, limiting money to people who may see it', async () => {
    await booking(-2);
    const today = await f.staff.get(`${base}/quotations/today`).expect(200);
    expect(today.body.data.payments).toHaveLength(1);
    expect(today.body.data.payments[0]).toMatchObject({ client: 'Meera Kapoor', amount: 25000, overdue: true });
    expect(today.body.data.payments[0].whatsappUrl).toContain('https://wa.me/919811111111?text=');
    expect(decodeURIComponent(today.body.data.payments[0].whatsappUrl)).toContain('₹25,000');
    expect((await authed(await login(f.org.member)).get(`${base}/quotations/today`)).status).toBe(403);
    expect((await api().get(`${base}/quotations/today`)).status).toBe(401);
  });

  it('runs from the scheduled-job endpoint only with the shared secret', async () => {
    expect((await api().get(`${base}/internal/cron/reminders`)).status).toBe(404); // not configured: the endpoint does not exist
    mutable.CRON_SECRET = 'a-long-enough-cron-secret';
    expect((await api().get(`${base}/internal/cron/reminders`)).status).toBe(403);
    expect((await api().get(`${base}/internal/cron/reminders`).set('Authorization', 'Bearer wrong-secret-value-here')).status).toBe(403);
    await booking(2);
    const ok = await api().get(`${base}/internal/cron/reminders`).set('Authorization', 'Bearer a-long-enough-cron-secret').expect(200);
    expect(ok.body.data).toMatchObject({ paymentEmails: 1 });
    expect((await api().post(`${base}/internal/cron/reminders`).set('Authorization', 'Bearer a-long-enough-cron-secret')).status).toBe(200);
  });
});
