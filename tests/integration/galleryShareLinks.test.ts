import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { api, app, authed, base, login } from '../helpers/api';
import { resetDatabase, seedTestOrganization, TestOrg } from '../helpers/factory';

/**
 * Share links are the only credential protecting a wedding gallery handed to
 * family, so these cover what the token must and must not open.
 */
describe('gallery share links', () => {
  let org: TestOrg;
  let token: string;
  let projectId: string;

  const upload = async (name: string, sectionName?: string) => {
    const intent = await authed(token)
      .post(`${base}/projects/${projectId}/gallery/upload-intent`)
      .send({ originalName: name, mimeType: 'image/jpeg' })
      .expect(200);
    const signed = new URL(intent.body.data.uploadUrl);
    await request(app).put(`${signed.pathname}${signed.search}`).set('content-type', 'image/jpeg').send(Buffer.from(name)).expect(204);
    return authed(token)
      .post(`${base}/projects/${projectId}/gallery/media`)
      .send({
        originalName: name, mimeType: 'image/jpeg',
        bucket: intent.body.data.bucket, objectKey: intent.body.data.objectKey,
        sizeBytes: name.length, ...(sectionName ? { sectionName } : {}),
      })
      .expect(201);
  };

  beforeEach(async () => {
    await resetDatabase();
    org = await seedTestOrganization();
    token = await login(org.admin);
    const client = await authed(token).post(`${base}/clients`).send({ displayName: 'Share Couple', primaryPhone: '9812345690' }).expect(201);
    const project = await authed(token).post(`${base}/projects`).send({ clientId: client.body.data.id, name: 'Share Wedding', weddingDate: '2026-12-14' }).expect(201);
    projectId = project.body.data.id;
  });

  it('issues an unguessable token and opens the gallery for anyone holding it', async () => {
    await upload('haldi.jpg');

    const link = await authed(token)
      .post(`${base}/projects/${projectId}/gallery/share-links`)
      .send({ title: 'For the family', accessType: 'VIEW_DOWNLOAD' })
      .expect(201);

    // Not derived from the title — that was guessable.
    expect(link.body.data.token).not.toContain('family');
    expect(link.body.data.token.length).toBeGreaterThanOrEqual(20);

    const shared = await api().get(`${base}/shared-galleries/${link.body.data.token}`).expect(200);
    expect(shared.body.data.media).toHaveLength(1);
    expect(shared.body.data.downloadAllowed).toBe(true);
    expect(shared.body.data.projectName).toBe('Share Wedding');
  });

  it('shares only the chosen photographs when the link is SELECTED_ONLY', async () => {
    const first = await upload('one.jpg');
    await upload('two.jpg');
    await upload('three.jpg');

    const link = await authed(token)
      .post(`${base}/projects/${projectId}/gallery/share-links`)
      .send({ title: 'Just one', accessType: 'SELECTED_ONLY', mediaIds: [first.body.data.id] })
      .expect(201);

    const shared = await api().get(`${base}/shared-galleries/${link.body.data.token}`).expect(200);
    expect(shared.body.data.media).toHaveLength(1);
    expect(shared.body.data.media[0].title).toBe('one.jpg');
  });

  it('limits a SECTION_ONLY link to that ceremony', async () => {
    await upload('h1.jpg', 'Haldi');
    await upload('r1.jpg', 'Reception');
    const gallery = await authed(token).get(`${base}/projects/${projectId}/gallery`).expect(200);
    const haldi = gallery.body.data.sections.find((s: { name: string }) => s.name === 'Haldi');

    const link = await authed(token)
      .post(`${base}/projects/${projectId}/gallery/share-links`)
      .send({ title: 'Haldi only', accessType: 'SECTION_ONLY', sectionId: haldi.id })
      .expect(201);

    const shared = await api().get(`${base}/shared-galleries/${link.body.data.token}`).expect(200);
    expect(shared.body.data.media.map((m: { title: string }) => m.title)).toEqual(['h1.jpg']);
  });

  it('demands the password before showing anything, and never returns the hash', async () => {
    await upload('private.jpg');
    const link = await authed(token)
      .post(`${base}/projects/${projectId}/gallery/share-links`)
      .send({ title: 'Private', accessType: 'VIEW_ONLY', password: 'wedding2026' })
      .expect(201);

    expect(link.body.data.passwordProtected).toBe(true);
    expect(JSON.stringify(link.body)).not.toContain('passwordHash');

    await api().get(`${base}/shared-galleries/${link.body.data.token}`).expect(401);
    await api().get(`${base}/shared-galleries/${link.body.data.token}?password=wrong`).expect(401);
    await api().get(`${base}/shared-galleries/${link.body.data.token}?password=wedding2026`).expect(200);
  });

  it('stops working once revoked', async () => {
    await upload('revoke.jpg');
    const link = await authed(token)
      .post(`${base}/projects/${projectId}/gallery/share-links`)
      .send({ title: 'Temporary', accessType: 'VIEW_ONLY' })
      .expect(201);
    await api().get(`${base}/shared-galleries/${link.body.data.token}`).expect(200);

    await authed(token).delete(`${base}/projects/${projectId}/gallery/share-links/${link.body.data.id}`).expect(200);

    await api().get(`${base}/shared-galleries/${link.body.data.token}`).expect(403);
  });

  it('refuses an expired link', async () => {
    await upload('expired.jpg');
    const link = await authed(token)
      .post(`${base}/projects/${projectId}/gallery/share-links`)
      .send({ title: 'Lapsed', accessType: 'VIEW_ONLY', expiresAt: new Date(Date.now() + 1500).toISOString() })
      .expect(201);

    await new Promise((resolve) => setTimeout(resolve, 1700));
    await api().get(`${base}/shared-galleries/${link.body.data.token}`).expect(403);
  });

  it('counts views and lists links for the studio', async () => {
    await upload('counted.jpg');
    const link = await authed(token)
      .post(`${base}/projects/${projectId}/gallery/share-links`)
      .send({ title: 'Counted', accessType: 'VIEW_ONLY' })
      .expect(201);

    await api().get(`${base}/shared-galleries/${link.body.data.token}`).expect(200);
    await api().get(`${base}/shared-galleries/${link.body.data.token}`).expect(200);

    const list = await authed(token).get(`${base}/projects/${projectId}/gallery/share-links`).expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].viewsCount).toBe(2);
  });

  it('rejects an unknown token', async () => {
    await api().get(`${base}/shared-galleries/not-a-real-token`).expect(404);
  });
});
