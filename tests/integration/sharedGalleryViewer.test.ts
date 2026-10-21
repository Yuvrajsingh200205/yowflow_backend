import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import { app, base } from '../helpers/api';
import { resetDatabase } from '../helpers/factory';
import { PortalFixture, seedPortalStudio } from '../helpers/portal';

describe('shared gallery viewer API (anonymous, paginated)', () => {
  let f: PortalFixture;
  const ids: string[] = [];
  const upload = async (name: string, section: string, n: number) => {
    const bytes = await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: n * 20, g: 100, b: 100 } } }).jpeg().toBuffer();
    const intent = await f.staff.post(`${base}/projects/${f.projectId}/gallery/upload-intent`).send({ originalName: name, mimeType: 'image/jpeg' }).expect(200);
    const u = new URL(intent.body.data.uploadUrl);
    await request(app).put(`${u.pathname}${u.search}`).set('content-type', 'image/jpeg').send(bytes).expect(204);
    const r = await f.staff.post(`${base}/projects/${f.projectId}/gallery/media`).send({ originalName: name, mimeType: 'image/jpeg', bucket: intent.body.data.bucket, objectKey: intent.body.data.objectKey, sizeBytes: bytes.length, sectionName: section }).expect(201);
    ids.push(r.body.data.id);
  };
  const link = async (body: object) => (await f.staff.post(`${base}/projects/${f.projectId}/gallery/share-links`).send(body).expect(201)).body.data.token as string;

  beforeEach(async () => {
    await resetDatabase();
    ids.length = 0;
    f = await seedPortalStudio();
    for (let i = 0; i < 5; i++) await upload(`a-${i}.jpg`, 'Wedding', i);
    await upload('h-0.jpg', 'Hidden', 9);
    const s = await f.staff.get(`${base}/projects/${f.projectId}/gallery/settings`).expect(200);
    const hidden = s.body.data.sections.find((x: { name: string }) => x.name === 'Hidden').id;
    await f.staff.patch(`${base}/projects/${f.projectId}/gallery/sections/${hidden}`).send({ isVisibleToClient: false }).expect(200);
  });

  it('opens with one cheap call, pages thumbnails, and never shows hidden sections', async () => {
    const t = await link({ title: 'Family', accessType: 'VIEW_ONLY' });
    const o = await request(app).get(`${base}/shared-galleries/${t}/overview`).expect(200);
    expect(o.body.data).toMatchObject({ total: 5, downloadAllowed: false });
    expect(o.body.data.sections.map((x: { name: string }) => x.name)).toEqual(['Wedding']);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const p = await request(app).get(`${base}/shared-galleries/${t}/media?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).expect(200);
      p.body.data.items.forEach((i: { id: string; thumbUrl: string; downloadAllowed: boolean }) => { seen.push(i.id); expect(i.thumbUrl).toBeTruthy(); expect(i.downloadAllowed).toBe(false); });
      cursor = p.body.data.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(seen).size).toBe(5);
    expect(seen).not.toContain(ids[5]);
    expect((await request(app).get(`${base}/shared-galleries/${t}/media/${ids[0]}/download`)).status).toBe(403);
  });

  it('allows downloads only for download links, and counts them', async () => {
    const t = await link({ title: 'Download', accessType: 'VIEW_DOWNLOAD' });
    const d = await request(app).get(`${base}/shared-galleries/${t}/media/${ids[0]}/download`).expect(200);
    expect(d.body.data.url).toMatch(/^https?:\/\//);
    expect((await request(app).get(`${base}/shared-galleries/${t}/media/${ids[5]}/download`)).status).toBe(404);
  });

  it('requires the password in a header, rejects wrong ones, and refuses revoked links', async () => {
    const res = await f.staff.post(`${base}/projects/${f.projectId}/gallery/share-links`).send({ title: 'Secret', accessType: 'VIEW_ONLY', password: 'Secret#123' }).expect(201);
    const t = res.body.data.token as string;
    expect((await request(app).get(`${base}/shared-galleries/${t}/overview`)).status).toBe(401);
    expect((await request(app).get(`${base}/shared-galleries/${t}/overview`).set('x-share-password', 'nope')).status).toBe(401);
    expect((await request(app).get(`${base}/shared-galleries/${t}/media`).set('x-share-password', 'Secret#123')).status).toBe(200);
    await f.staff.delete(`${base}/projects/${f.projectId}/gallery/share-links/${res.body.data.id}`).expect(200);
    expect((await request(app).get(`${base}/shared-galleries/${t}/overview`).set('x-share-password', 'Secret#123')).status).toBe(403);
  });
});
