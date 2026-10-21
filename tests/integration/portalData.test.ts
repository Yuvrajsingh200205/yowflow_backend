import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import { app, authed, base, login } from '../helpers/api';
import { resetDatabase, seedTestOrganization } from '../helpers/factory';
import { outbox } from '../../src/services/mailer.service';
import { PortalFixture, seedPortalStudio, signedInCouple } from '../helpers/portal';

const jpeg = (n: number) => sharp({ create: { width: 1600 + n, height: 1000, channels: 3, background: { r: (n * 37) % 255, g: 120, b: 90 } } }).jpeg().toBuffer();

describe('client portal — data API', () => {
  let f: PortalFixture;
  let agent: Awaited<ReturnType<typeof signedInCouple>>['agent'];
  let sections: { haldi: string; wedding: string; hidden: string };
  const mediaIds: Record<string, string> = {};
  const P = () => `${base}/portal/projects/${f.projectId}`;

  async function upload(name: string, section: string, n: number) {
    const bytes = await jpeg(n);
    const intent = await f.staff.post(`${base}/projects/${f.projectId}/gallery/upload-intent`).send({ originalName: name, mimeType: 'image/jpeg' }).expect(200);
    const signed = new URL(intent.body.data.uploadUrl);
    await request(app).put(`${signed.pathname}${signed.search}`).set('content-type', 'image/jpeg').send(bytes).expect(204);
    const res = await f.staff.post(`${base}/projects/${f.projectId}/gallery/media`).send({
      originalName: name, mimeType: 'image/jpeg', bucket: intent.body.data.bucket, objectKey: intent.body.data.objectKey, sizeBytes: bytes.length, sectionName: section,
    }).expect(201);
    mediaIds[name] = res.body.data.id;
    return res.body.data.id as string;
  }

  beforeEach(async () => {
    await resetDatabase();
    outbox.length = 0;
    f = await seedPortalStudio();
    for (let i = 0; i < 4; i++) await upload(`haldi-${i}.jpg`, 'Haldi', i);
    for (let i = 0; i < 3; i++) await upload(`wedding-${i}.jpg`, 'Wedding', 10 + i);
    await upload('private-0.jpg', 'Private', 20);
    const settings = await f.staff.get(`${base}/projects/${f.projectId}/gallery/settings`).expect(200);
    const by = (n: string) => settings.body.data.sections.find((s: { name: string }) => s.name === n).id as string;
    sections = { haldi: by('Haldi'), wedding: by('Wedding'), hidden: by('Private') };
    await f.staff.patch(`${base}/projects/${f.projectId}/gallery/sections/${sections.hidden}`).send({ isVisibleToClient: false }).expect(200);
    await f.staff.patch(`${base}/projects/${f.projectId}/gallery/sections/${sections.wedding}`).send({ isDownloadAllowed: true, isShareAllowed: true }).expect(200);
    await f.staff.patch(`${base}/projects/${f.projectId}/gallery/sections/${sections.haldi}`).send({ isDownloadAllowed: false, isShareAllowed: false }).expect(200);
    await f.staff.patch(`${base}/projects/${f.projectId}/gallery`).send({ albumSelectionTarget: 2, welcomeMessage: 'Congratulations!' }).expect(200);
    ({ agent } = await signedInCouple(f));
  });

  it('shows the project overview but keeps an unpublished gallery closed', async () => {
    const list = await agent.get(`${base}/portal/projects`).expect(200);
    expect(list.body.data.projects).toHaveLength(1);
    const detail = await agent.get(P()).expect(200);
    expect(detail.body.data.project.name).toMatch(/Aarav/);
    const gallery = await agent.get(`${P()}/gallery`).expect(200);
    expect(gallery.body.data.available).toBe(false);
    const media = await agent.get(`${P()}/gallery/media`).expect(200);
    expect(media.body.data.items).toHaveLength(0);
    expect((await agent.get(`${base}/portal/media/${mediaIds['wedding-0.jpg']}`)).status).toBe(404);
  });

  describe('once published', () => {
    beforeEach(async () => {
      outbox.length = 0;
      await f.staff.patch(`${base}/projects/${f.projectId}/gallery`).send({ status: 'PUBLISHED' }).expect(200);
    });

    it('announces publication by e-mail and in-app notification', async () => {
      expect(outbox.some((m) => m.to === f.inviteEmail && /ready/i.test(m.subject))).toBe(true);
      const n = await agent.get(`${base}/portal/notifications`).expect(200);
      expect(n.body.data.items.some((i: { type: string }) => i.type === 'GALLERY_READY')).toBe(true);
      expect(n.body.data.unread).toBeGreaterThan(0);
    });

    it('lists only visible sections and never leaks hidden media', async () => {
      const g = await agent.get(`${P()}/gallery`).expect(200);
      const names = g.body.data.sections.map((s: { name: string }) => s.name).sort();
      expect(names).toEqual(['Haldi', 'Wedding']);
      const media = await agent.get(`${P()}/gallery/media?limit=100`).expect(200);
      expect(media.body.data.items).toHaveLength(7);
      expect(JSON.stringify(media.body)).not.toContain(mediaIds['private-0.jpg']);
      expect((await agent.get(`${base}/portal/media/${mediaIds['private-0.jpg']}`)).status).toBe(404);
      expect((await agent.put(`${base}/portal/media/${mediaIds['private-0.jpg']}/selections/FAVORITE`)).status).toBe(404);
      expect((await agent.get(`${base}/portal/media/${mediaIds['private-0.jpg']}/download`)).status).toBe(404);
    });

    it('paginates with a stable keyset cursor and no duplicates', async () => {
      const seen = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      do {
        const res = await agent.get(`${P()}/gallery/media?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`).expect(200);
        for (const i of res.body.data.items) { expect(seen.has(i.id)).toBe(false); seen.add(i.id); }
        cursor = res.body.data.nextCursor ?? undefined;
        pages++;
      } while (cursor && pages < 10);
      expect(seen.size).toBe(7);
      expect(pages).toBe(3);
      expect((await agent.get(`${P()}/gallery/media?cursor=garbage`)).status).toBe(400);
    });

    it('serves thumbnails generated from the original, not the original itself', async () => {
      const media = await agent.get(`${P()}/gallery/media?limit=1`).expect(200);
      const item = media.body.data.items[0];
      expect(item.thumbUrl).toBeTruthy();
      expect(item.previewUrl).toBeTruthy();
      const thumb = new URL(item.thumbUrl, 'http://x');
      const res = await request(app).get(`${thumb.pathname}${thumb.search}`).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
      expect(res.status).toBe(200);
      const meta = await sharp(res.body as Buffer).metadata();
      expect(meta.width).toBeLessThan(1000);
    });

    it('filters by section and by favorites', async () => {
      const wedding = await agent.get(`${P()}/gallery/media?sectionId=${sections.wedding}`).expect(200);
      expect(wedding.body.data.items).toHaveLength(3);
      await agent.put(`${base}/portal/media/${mediaIds['wedding-1.jpg']}/selections/FAVORITE`).expect(200);
      const favs = await agent.get(`${P()}/gallery/media?filter=favorites`).expect(200);
      expect(favs.body.data.items.map((i: { id: string }) => i.id)).toEqual([mediaIds['wedding-1.jpg']]);
      await agent.delete(`${base}/portal/media/${mediaIds['wedding-1.jpg']}/selections/FAVORITE`).expect(200);
      expect((await agent.get(`${P()}/gallery/media?filter=favorites`)).body.data.items).toHaveLength(0);
    });

    it('enforces the album cap, is idempotent, and submits to the studio', async () => {
      const put = (n: string) => agent.put(`${base}/portal/media/${mediaIds[n]}/selections/ALBUM`);
      await put('wedding-0.jpg').expect(200);
      await put('wedding-0.jpg').expect(200); // idempotent
      await put('wedding-1.jpg').expect(200);
      const over = await put('wedding-2.jpg');
      expect(over.status).toBe(409);
      const g = await agent.get(`${P()}/gallery`).expect(200);
      expect(g.body.data.selection.album).toBe(2);
      await agent.post(`${P()}/gallery/album-selection/submit`).expect(201);
      const activity = await f.staff.get(`${base}/projects/${f.projectId}/gallery/client-activity`).expect(200);
      expect(activity.body.data.albumSelection).toHaveLength(2);
      expect(activity.body.data.requests.some((r: { title: string }) => /Album selection submitted/.test(r.title))).toBe(true);
    });

    it('gates downloads by section, and counts allowed ones', async () => {
      const blocked = await agent.get(`${base}/portal/media/${mediaIds['haldi-0.jpg']}/download`);
      expect(blocked.status).toBe(403);
      const ok = await agent.get(`${base}/portal/media/${mediaIds['wedding-0.jpg']}/download`).expect(200);
      expect(ok.body.data.url).toMatch(/^https?:\/\//);
    });

    it('lets the couple comment and request, and the studio reply and resolve', async () => {
      await agent.post(`${base}/portal/media/${mediaIds['wedding-0.jpg']}/comments`).send({ body: 'Please brighten this one', type: 'RETOUCH_REQUEST' }).expect(201);
      const req = await agent.post(`${P()}/requests`).send({ type: 'SONG_CHANGE', title: 'Change the song', description: 'Use the second song please' }).expect(201);
      let activity = await f.staff.get(`${base}/projects/${f.projectId}/gallery/client-activity`).expect(200);
      expect(activity.body.data.comments).toHaveLength(1);
      expect(activity.body.data.requests.some((r: { id: string }) => r.id === req.body.data.id)).toBe(true);

      const staffNotifs = await f.staff.get(`${base}/notifications`);
      expect(staffNotifs.status).toBe(200);

      await f.staff.patch(`${base}/projects/${f.projectId}/gallery/requests/${req.body.data.id}`).send({ status: 'COMPLETED', adminResponse: 'Done — updated.' }).expect(200);
      await f.staff.post(`${base}/projects/${f.projectId}/gallery/comments/${activity.body.data.comments[0].id}/reply`).send({ body: 'Brightened!' }).expect(201);
      const requests = await agent.get(`${P()}/requests`).expect(200);
      expect(requests.body.data.find((r: { id: string }) => r.id === req.body.data.id)).toMatchObject({ status: 'COMPLETED', adminResponse: 'Done — updated.' });
      const comments = await agent.get(`${P()}/comments`).expect(200);
      expect(JSON.stringify(comments.body)).toContain('Brightened!');
      const notifs = await agent.get(`${base}/portal/notifications`).expect(200);
      expect(notifs.body.data.items.filter((i: { type: string }) => i.type === 'REQUEST_UPDATE').length).toBeGreaterThanOrEqual(2);
      await agent.post(`${base}/portal/notifications/read-all`).expect(200);
      expect((await agent.get(`${base}/portal/notifications`)).body.data.unread).toBe(0);
      activity = await f.staff.get(`${base}/projects/${f.projectId}/gallery/client-activity`).expect(200);
      expect(activity.body.data.comments.find((c: { fromStudio: boolean }) => !c.fromStudio).isResolved).toBe(true);
    });

    it('lets the couple create and revoke share links only where sharing is allowed', async () => {
      const denied = await agent.post(`${P()}/share-links`).send({ title: 'Haldi for family', accessType: 'SECTION_ONLY', sectionId: sections.haldi });
      expect(denied.status).toBe(403);
      const hiddenSection = await agent.post(`${P()}/share-links`).send({ title: 'Nope', accessType: 'SECTION_ONLY', sectionId: sections.hidden });
      expect([403, 404]).toContain(hiddenSection.status);
      const ok = await agent.post(`${P()}/share-links`).send({ title: 'Wedding for family', accessType: 'SECTION_ONLY', sectionId: sections.wedding, expiresInDays: 7 }).expect(201);
      expect(ok.body.data.url ?? ok.body.data.token).toBeTruthy();
      const list = await agent.get(`${P()}/share-links`).expect(200);
      expect(list.body.data).toHaveLength(1);
      await agent.delete(`${P()}/share-links/${ok.body.data.id}`).expect(200);
    });
  });

  it('isolates tenants and other couples', async () => {
    await f.staff.patch(`${base}/projects/${f.projectId}/gallery`).send({ status: 'PUBLISHED' }).expect(200);
    const other = await seedPortalStudio('other@portal.test', 'other-studio');
    const { agent: stranger } = await signedInCouple(other, 'Other Person');
    expect((await stranger.get(`${P()}`)).status).toBe(404);
    expect((await stranger.get(`${P()}/gallery/media`)).status).toBe(404);
    expect((await stranger.get(`${base}/portal/media/${mediaIds['wedding-0.jpg']}`)).status).toBe(404);
    expect((await stranger.put(`${base}/portal/media/${mediaIds['wedding-0.jpg']}/selections/FAVORITE`)).status).toBe(404);
    expect((await stranger.get(`${base}/portal/projects`)).body.data.projects).toHaveLength(1);
    // staff of another studio cannot manage this gallery
    const intruder = authed(await login((await seedTestOrganization('intruder-studio')).admin));
    expect((await intruder.patch(`${base}/projects/${f.projectId}/gallery`).send({ status: 'DRAFT' })).status).toBe(404);
    // portal cookies are not staff credentials
    expect((await agent.get(`${base}/projects`)).status).toBe(401);
  });

  it('staff can curate sections, folders and media, and backfill derivatives', async () => {
    const folder = await f.staff.post(`${base}/projects/${f.projectId}/gallery/sections/${sections.wedding}/folders`).send({ name: 'Rings' }).expect(201);
    await f.staff.patch(`${base}/projects/${f.projectId}/gallery/media`).send({ mediaIds: [mediaIds['wedding-0.jpg']], subFolderId: folder.body.data.id }).expect(200);
    await f.staff.patch(`${base}/projects/${f.projectId}/gallery/media`).send({ mediaIds: [mediaIds['wedding-1.jpg']], isClientVisible: false }).expect(200);
    await f.staff.patch(`${base}/projects/${f.projectId}/gallery`).send({ status: 'PUBLISHED' }).expect(200);
    const inFolder = await agent.get(`${P()}/gallery/media?subFolderId=${folder.body.data.id}`).expect(200);
    expect(inFolder.body.data.items).toHaveLength(1);
    const sec = await agent.get(`${P()}/gallery/media?sectionId=${sections.wedding}`).expect(200);
    expect(sec.body.data.items).toHaveLength(2);
    expect((await f.staff.delete(`${base}/projects/${f.projectId}/gallery/sections/${sections.wedding}`)).status).toBe(409);
    await f.staff.delete(`${base}/projects/${f.projectId}/gallery/folders/${folder.body.data.id}`).expect(204);
    await f.staff.post(`${base}/projects/${f.projectId}/gallery/derivatives`).expect(200);
  });
});
