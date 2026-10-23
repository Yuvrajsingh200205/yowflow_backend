import crypto from 'crypto';
import http from 'http';
import { AddressInfo } from 'net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { base } from '../helpers/api';
import { env } from '../../src/config/env';
import { resetDatabase } from '../helpers/factory';
import { PortalFixture, seedPortalStudio } from '../helpers/portal';

const ACCESS = 'AKIATESTKEY123456789';
const SECRET = 'test-secret-access-key-for-multipart';

/** Re-computes an AWS SigV4 query signature from scratch, independently of the code under test. */
function signatureFor(method: string, url: URL): string {
  const q = new URLSearchParams(url.search);
  const given = q.get('X-Amz-Signature');
  q.delete('X-Amz-Signature');
  const enc = (v: string) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const canonicalQuery = [...q.entries()].map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const amzDate = q.get('X-Amz-Date')!;
  const region = env.STORAGE_REGION || 'auto';
  const scope = `${amzDate.slice(0, 8)}/${region}/s3/aws4_request`;
  const canonical = [method, url.pathname, canonicalQuery, `host:${url.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
  const h = (k: Buffer | string, v: string) => crypto.createHmac('sha256', k).update(v).digest();
  const key = h(h(h(h(`AWS4${SECRET}`, amzDate.slice(0, 8)), region), 's3'), 'aws4_request');
  const expected = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return expected === given ? 'ok' : `bad (${given} != ${expected})`;
}

describe('multipart uploads for large films (S3-compatible storage)', () => {
  const mutable = env as unknown as Record<string, unknown>;
  const original = { provider: env.STORAGE_PROVIDER, endpoint: env.STORAGE_ENDPOINT, key: env.STORAGE_ACCESS_KEY_ID, secret: env.STORAGE_SECRET_ACCESS_KEY };
  let server: http.Server; let calls: Array<{ method: string; path: string; query: string; sig: string; body: string }> = [];
  let f: PortalFixture;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        calls.push({ method: req.method!, path: url.pathname, query: url.search, sig: signatureFor(req.method!, url), body: Buffer.concat(chunks).toString().slice(0, 500) });
        if (req.method === 'POST' && url.searchParams.has('uploads')) { res.end('<InitiateMultipartUploadResult><UploadId>UP-123</UploadId></InitiateMultipartUploadResult>'); return; }
        if (req.method === 'PUT' && url.searchParams.has('partNumber')) { res.setHeader('ETag', `"etag-${url.searchParams.get('partNumber')}"`); res.end(); return; }
        if (req.method === 'POST' && url.searchParams.has('uploadId')) { res.end('<CompleteMultipartUploadResult><Key>k</Key></CompleteMultipartUploadResult>'); return; }
        if (req.method === 'DELETE') { res.statusCode = 204; res.end(); return; }
        res.statusCode = 400; res.end('<Error/>');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    mutable.STORAGE_PROVIDER = 'R2';
    mutable.STORAGE_ENDPOINT = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    mutable.STORAGE_ACCESS_KEY_ID = ACCESS;
    mutable.STORAGE_SECRET_ACCESS_KEY = SECRET;
  });
  afterAll(async () => {
    mutable.STORAGE_PROVIDER = original.provider; mutable.STORAGE_ENDPOINT = original.endpoint; mutable.STORAGE_ACCESS_KEY_ID = original.key; mutable.STORAGE_SECRET_ACCESS_KEY = original.secret;
    await new Promise((r) => server.close(r));
  });
  beforeEach(async () => { await resetDatabase(); calls = []; f = await seedPortalStudio(); });

  const init = (size: number, mimeType = 'video/mp4') => f.staff.post(`${base}/projects/${f.projectId}/gallery/multipart/init`).send({ originalName: 'highlight film.mp4', mimeType, sizeBytes: size });

  it('starts an upload, signs every part, and finishes with the parts in order', async () => {
    const size = 100 * 1024 * 1024 + 5; // 7 parts of 16 MiB
    const res = await init(size).expect(200);
    const d = res.body.data;
    expect(d.uploadId).toBe('UP-123');
    expect(d.partSize).toBe(16 * 1024 * 1024);
    expect(d.parts).toHaveLength(7);
    expect(d.objectKey).toContain('/gallery_media/');

    // each part URL is a correctly signed PUT carrying its own part number and the upload id
    for (const p of d.parts) {
      const put = await fetch(p.url, { method: 'PUT', body: 'x' });
      expect(put.status).toBe(200);
      expect(put.headers.get('etag')).toBe(`"etag-${p.partNumber}"`);
    }
    const etags = d.parts.map((p: { partNumber: number }) => ({ partNumber: p.partNumber, etag: `"etag-${p.partNumber}"` })).reverse(); // out of order on purpose
    await f.staff.post(`${base}/projects/${f.projectId}/gallery/multipart/complete`).send({ objectKey: d.objectKey, uploadId: d.uploadId, parts: etags }).expect(200);

    expect(calls.map((c) => c.sig).filter((x) => x !== 'ok')).toEqual([]);
    const completeCall = calls.find((c) => c.method === 'POST' && c.query.includes('uploadId'))!;
    expect(completeCall.body.indexOf('<PartNumber>1<')).toBeLessThan(completeCall.body.indexOf('<PartNumber>2<'));

    // the finished object can then be registered as gallery media (size beyond the old 50 MB single-PUT limit)
    const media = await f.staff.post(`${base}/projects/${f.projectId}/gallery/media`).send({ originalName: 'highlight film.mp4', mimeType: 'video/mp4', bucket: d.bucket, objectKey: d.objectKey, sizeBytes: size, sectionName: 'Films' });
    expect(media.status).toBe(201);
  });

  it('grows the part size so even a 5 GB film stays under the part limit, and rejects larger files and other types', async () => {
    const big = (await init(5 * 1024 * 1024 * 1024).expect(200)).body.data;
    expect(big.parts.length).toBeLessThanOrEqual(9000);
    expect((await init(6 * 1024 * 1024 * 1024)).status).toBe(400);
    expect((await init(1000, 'application/pdf')).status).toBe(400);
  });

  it('cannot finish or cancel another studio’s upload, and aborting reaches the provider', async () => {
    const d = (await init(40 * 1024 * 1024).expect(200)).body.data;
    const foreign = `someone-else/gallery_media/2026-01-01/${'a'.repeat(8)}-x.mp4`;
    expect((await f.staff.post(`${base}/projects/${f.projectId}/gallery/multipart/complete`).send({ objectKey: foreign, uploadId: 'u', parts: [{ partNumber: 1, etag: '"a"' }] })).status).toBe(400);
    expect((await f.staff.post(`${base}/projects/${f.projectId}/gallery/multipart/abort`).send({ objectKey: foreign, uploadId: 'u' })).status).toBe(400);
    await f.staff.post(`${base}/projects/${f.projectId}/gallery/multipart/abort`).send({ objectKey: d.objectKey, uploadId: d.uploadId }).expect(200);
    expect(calls.some((c) => c.method === 'DELETE' && c.sig === 'ok')).toBe(true);
  });

  it('says plainly when the deployment has no cloud storage', async () => {
    mutable.STORAGE_PROVIDER = 'LOCAL';
    try {
      const res = await init(80 * 1024 * 1024);
      expect(res.status).toBe(503);
      expect(res.body.error.message).toMatch(/cloud storage/i);
    } finally { mutable.STORAGE_PROVIDER = 'R2'; }
  });
});
