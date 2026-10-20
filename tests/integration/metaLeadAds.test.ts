import crypto from 'crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.META_APP_SECRET = process.env.META_APP_SECRET ?? 'test-meta-secret';
  process.env.META_PAGE_ID = process.env.META_PAGE_ID ?? 'page_123';
  process.env.META_PAGE_ACCESS_TOKEN = process.env.META_PAGE_ACCESS_TOKEN ?? 'page-token';
  process.env.META_WEBHOOK_VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN ?? 'verify-token';
});

import { createApp } from '../../src/app';
import { env } from '../../src/config/env';
import { prisma, resetDatabase, seedTestOrganization, TestOrg } from '../helpers/factory';

const app = createApp();
const base = env.API_BASE_PATH;

function signedPayload(payload: unknown) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${crypto.createHmac('sha256', process.env.META_APP_SECRET as string).update(body).digest('hex')}`;
  return { body, signature };
}

function postSigned(payload: unknown) {
  const { body, signature } = signedPayload(payload);
  return request(app)
    .post(`${base}/integrations/meta/webhook`)
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signature)
    .send(body);
}

function leadgenPayload(leadgenId: string, overrides: Record<string, unknown> = {}) {
  return {
    object: 'page',
    entry: [{
      id: process.env.META_PAGE_ID,
      changes: [{
        field: 'leadgen',
        value: {
          leadgen_id: leadgenId,
          page_id: process.env.META_PAGE_ID,
          form_id: 'form_123',
          ad_id: 'ad_123',
          ...overrides,
        },
      }],
    }],
  };
}

describe('Meta Lead Ads webhook', () => {
  let org: TestOrg;

  beforeEach(async () => {
    await resetDatabase();
    org = await seedTestOrganization('meta-test-studio');
    await prisma.metaLeadIntegration.create({
      data: {
        organizationId: org.organizationId,
        pageId: process.env.META_PAGE_ID as string,
        pageName: 'Demo Studio Page',
      },
    });
    vi.restoreAllMocks();
  });

  it('verifies the webhook challenge with the configured token', async () => {
    await request(app)
      .get(`${base}/integrations/meta/webhook`)
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': process.env.META_WEBHOOK_VERIFY_TOKEN, 'hub.challenge': 'abc123' })
      .expect(200, 'abc123');
  });

  it('rejects webhook verification with the wrong token or mode', async () => {
    await request(app)
      .get(`${base}/integrations/meta/webhook`)
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong-token', 'hub.challenge': 'abc123' })
      .expect(403);

    await request(app)
      .get(`${base}/integrations/meta/webhook`)
      .query({ 'hub.mode': 'unsubscribe', 'hub.verify_token': process.env.META_WEBHOOK_VERIFY_TOKEN, 'hub.challenge': 'abc123' })
      .expect(403);
  });

  it('rejects webhook posts with an invalid Meta signature', async () => {
    await request(app)
      .post(`${base}/integrations/meta/webhook`)
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', 'sha256=bad')
      .send({ object: 'page', entry: [] })
      .expect(401);
  });

  it('rejects malformed JSON before processing a webhook event', async () => {
    const body = '{"object":"page"';
    const signature = `sha256=${crypto.createHmac('sha256', process.env.META_APP_SECRET as string).update(body).digest('hex')}`;

    await request(app)
      .post(`${base}/integrations/meta/webhook`)
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signature)
      .send(body)
      .expect(400);
  });

  it('accepts non-leadgen Page events without creating a CRM lead', async () => {
    const response = await postSigned({
      object: 'page',
      entry: [{ id: process.env.META_PAGE_ID, changes: [{ field: 'feed', value: { page_id: process.env.META_PAGE_ID } }] }],
    }).expect(200);

    expect(response.body.data).toMatchObject({ accepted: 0, imported: 0, ignored: 0 });
    await expect(prisma.lead.count({ where: { externalProvider: 'META' } })).resolves.toBe(0);
  });

  it('retrieves a Meta lead and stores it in the existing CRM leads table', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      id: 'lead_123',
      created_time: '2026-09-28T10:00:00+0000',
      form_id: 'form_123',
      ad_id: 'ad_123',
      field_data: [
        { name: 'full_name', values: ['Riya Sharma'] },
        { name: 'phone_number', values: ['9876543210'] },
        { name: 'email', values: ['riya@example.com'] },
        { name: 'city', values: ['Delhi'] },
      ],
    }), { status: 200 })));

    await postSigned(leadgenPayload('lead_123')).expect(200);

    const lead = await prisma.lead.findFirstOrThrow({ where: { externalProvider: 'META', externalId: 'lead_123' } });
    expect(lead.organizationId).toBe(org.organizationId);
    expect(lead.name).toBe('Riya Sharma');
    expect(lead.phone).toBe('9876543210');
    expect(lead.email).toBe('riya@example.com');
    expect(lead.venueCity).toBe('Delhi');
  });

  it('keeps duplicate webhook deliveries idempotent by Meta lead id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      id: 'lead_dup',
      field_data: [
        { name: 'full_name', values: ['Duplicate Lead'] },
        { name: 'phone_number', values: ['9999999999'] },
      ],
    }), { status: 200 })));

    await postSigned(leadgenPayload('lead_dup')).expect(200);
    await postSigned(leadgenPayload('lead_dup')).expect(200);

    await expect(prisma.lead.count({ where: { externalProvider: 'META', externalId: 'lead_dup' } })).resolves.toBe(1);
  });

  it('keeps concurrent duplicate webhook deliveries idempotent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      id: 'lead_concurrent',
      field_data: [
        { name: 'full_name', values: ['Concurrent Lead'] },
        { name: 'phone_number', values: ['8888888888'] },
      ],
    }), { status: 200 })));

    await Promise.all([
      postSigned(leadgenPayload('lead_concurrent')).expect(200),
      postSigned(leadgenPayload('lead_concurrent')).expect(200),
    ]);

    await expect(prisma.lead.count({ where: { externalProvider: 'META', externalId: 'lead_concurrent' } })).resolves.toBe(1);
  });

  it('ignores leadgen events from an unexpected Page ID', async () => {
    const response = await postSigned(leadgenPayload('lead_bad_page', { page_id: 'unexpected_page' })).expect(200);

    expect(response.body.data).toMatchObject({ accepted: 1, imported: 0, ignored: 1 });
    await expect(prisma.lead.count({ where: { externalId: 'lead_bad_page' } })).resolves.toBe(0);
  });

  it('ignores configured Page events when no organization mapping exists', async () => {
    await prisma.metaLeadIntegration.deleteMany({ where: { pageId: process.env.META_PAGE_ID } });

    const response = await postSigned(leadgenPayload('lead_unmapped')).expect(200);

    expect(response.body.data).toMatchObject({ accepted: 1, imported: 0, ignored: 1 });
    await expect(prisma.lead.count({ where: { externalId: 'lead_unmapped' } })).resolves.toBe(0);
  });

  it('returns a controlled error when Meta rejects the Page access token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 190 } }), { status: 401 })));

    await postSigned(leadgenPayload('lead_invalid_token')).expect(401);
  });

  it('returns a controlled error when Meta lead details are malformed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'lead_malformed' }), { status: 200 })));

    await postSigned(leadgenPayload('lead_malformed')).expect(400);
  });

  it('preserves custom Meta form fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      id: 'lead_custom',
      field_data: [
        { name: 'full_name', values: ['Custom Lead'] },
        { name: 'phone_number', values: ['7777777777'] },
        { name: 'wedding_package_interest', values: ['Cinematic + Album'] },
      ],
    }), { status: 200 })));

    await postSigned(leadgenPayload('lead_custom')).expect(200);

    const lead = await prisma.lead.findFirstOrThrow({ where: { externalId: 'lead_custom' } });
    expect(lead.customFields).toMatchObject({ wedding_package_interest: 'Cinematic + Album' });
  });

  it('handles missing optional phone and email without dropping the lead', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      id: 'lead_missing_contact',
      field_data: [{ name: 'full_name', values: ['No Phone Lead'] }],
    }), { status: 200 })));

    await postSigned(leadgenPayload('lead_missing_contact')).expect(200);

    const lead = await prisma.lead.findFirstOrThrow({ where: { externalId: 'lead_missing_contact' } });
    expect(lead.name).toBe('No Phone Lead');
    expect(lead.phone).toBe('UNKNOWN');
    expect(lead.email).toBeNull();
  });

  it('returns a controlled timeout error when Meta does not respond', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      signal?.addEventListener('abort', () => {
        const error = new Error('Aborted');
        error.name = 'AbortError';
        reject(error);
      });
    })));

    await postSigned(leadgenPayload('lead_timeout')).expect(503);
  }, 20_000);
});
