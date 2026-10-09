import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { api, app, authed, base, login } from '../helpers/api';
import { prisma, resetDatabase, seedTestOrganization, TestOrg } from '../helpers/factory';

/**
 * Studio uploads for a wedding gallery. The point of these tests is that a
 * gallery belongs to exactly one project: uploading for one couple must never
 * put photographs in another couple's portal.
 */
describe('project gallery media', () => {
  let org: TestOrg;
  let token: string;

  beforeEach(async () => {
    await resetDatabase();
    org = await seedTestOrganization();
    token = await login(org.admin);
  });

  const makeProject = async (name: string, phone: string) => {
    const client = await authed(token)
      .post(`${base}/clients`)
      .send({ displayName: name, primaryPhone: phone })
      .expect(201);
    const project = await authed(token)
      .post(`${base}/projects`)
      .send({ clientId: client.body.data.id, name: `${name} Wedding`, weddingDate: '2026-12-14' })
      .expect(201);
    return project.body.data.id as string;
  };

  /** Runs the real three-step upload: intent, signed PUT, then register. */
  const uploadPhoto = async (
    projectId: string,
    fileName: string,
    bytes: Buffer,
    sectionName?: string,
    mimeType = 'image/jpeg',
  ) => {
    const intent = await authed(token)
      .post(`${base}/projects/${projectId}/gallery/upload-intent`)
      .send({ originalName: fileName, mimeType })
      .expect(200);

    // The signed URL is absolute; supertest binds its own port, so the path and
    // query are what matter.
    const signed = new URL(intent.body.data.uploadUrl);
    await request(app)
      .put(`${signed.pathname}${signed.search}`)
      .set('content-type', mimeType)
      .send(bytes)
      .expect(204);

    return authed(token)
      .post(`${base}/projects/${projectId}/gallery/media`)
      .send({
        originalName: fileName,
        mimeType,
        bucket: intent.body.data.bucket,
        objectKey: intent.body.data.objectKey,
        sizeBytes: bytes.length,
        ...(sectionName ? { sectionName } : {}),
      })
      .expect(201);
  };

  it('keeps every wedding gallery to its own project', async () => {
    const firstProject = await makeProject('Aarav & Diya', '9812345670');
    const secondProject = await makeProject('Rohan & Ananya', '9812345671');

    await uploadPhoto(firstProject, 'haldi-01.jpg', Buffer.from('first-couple-photo'));
    await uploadPhoto(secondProject, 'sangeet-01.jpg', Buffer.from('second-couple-photo'));

    const first = await authed(token).get(`${base}/projects/${firstProject}/gallery`).expect(200);
    const second = await authed(token).get(`${base}/projects/${secondProject}/gallery`).expect(200);

    expect(first.body.data.media).toHaveLength(1);
    expect(second.body.data.media).toHaveLength(1);
    expect(first.body.data.media[0].title).toBe('haldi-01.jpg');
    expect(second.body.data.media[0].title).toBe('sangeet-01.jpg');
    // The galleries are distinct records, not one shared pool.
    expect(first.body.data.gallery.id).not.toBe(second.body.data.gallery.id);
  });

  it('creates the gallery and section on the first upload and serves the bytes back', async () => {
    const projectId = await makeProject('Kabir & Meera', '9812345672');
    const bytes = Buffer.from('a-real-photograph');

    const created = await uploadPhoto(projectId, 'pheras.jpg', bytes, 'Wedding Day');

    expect(created.body.data.sectionName).toBe('Wedding Day');
    expect(created.body.data.mediaType).toBe('IMAGE');
    expect(created.body.data.category).toBe('PHOTOS');

    const gallery = await authed(token).get(`${base}/projects/${projectId}/gallery`).expect(200);
    expect(gallery.body.data.sections).toHaveLength(1);
    // An uploaded section is meant to be seen, so the couple is not gated out.
    expect(gallery.body.data.sections[0].isVisibleToClient).toBe(true);

    // The signed URL actually returns what was uploaded.
    const url = new URL(gallery.body.data.media[0].url);
    const served = await request(app).get(`${url.pathname}${url.search}`).expect(200);
    expect(Buffer.from(served.body).toString()).toBe('a-real-photograph');
  });

  it('groups uploads into the sections the studio names', async () => {
    const projectId = await makeProject('Vikram & Sana', '9812345673');

    await uploadPhoto(projectId, 'h1.jpg', Buffer.from('h1'), 'Haldi');
    await uploadPhoto(projectId, 'h2.jpg', Buffer.from('h2'), 'Haldi');
    await uploadPhoto(projectId, 'r1.jpg', Buffer.from('r1'), 'Reception');

    const gallery = await authed(token).get(`${base}/projects/${projectId}/gallery`).expect(200);

    expect(gallery.body.data.sections.map((s: { name: string }) => s.name)).toEqual(['Haldi', 'Reception']);
    expect(gallery.body.data.media).toHaveLength(3);
    expect(gallery.body.data.media.filter((m: { sectionName: string }) => m.sectionName === 'Haldi')).toHaveLength(2);
  });

  it('files films and photographs as separate kinds', async () => {
    // The Photos tab and the Films tab read the same gallery, so a film must be
    // stored as a film rather than landing among the photographs.
    const projectId = await makeProject('Film & Photo', '9812345677');

    await uploadPhoto(projectId, 'portrait.jpg', Buffer.from('a-photo'));
    const film = await uploadPhoto(projectId, 'teaser.mp4', Buffer.from('a-film'), undefined, 'video/mp4');

    expect(film.body.data.mediaType).toBe('VIDEO');
    expect(film.body.data.category).toBe('VIDEOS');

    const gallery = await authed(token).get(`${base}/projects/${projectId}/gallery`).expect(200);
    const photos = gallery.body.data.media.filter((m: { mediaType: string }) => m.mediaType === 'IMAGE');
    const films = gallery.body.data.media.filter((m: { mediaType: string }) => m.mediaType === 'VIDEO');

    expect(photos.map((m: { title: string }) => m.title)).toEqual(['portrait.jpg']);
    expect(films.map((m: { title: string }) => m.title)).toEqual(['teaser.mp4']);
    expect(photos[0].category).toBe('PHOTOS');

    // Both rows point at their own stored file.
    expect(films[0].mimeType).toBe('video/mp4');
    expect(photos[0].mimeType).toBe('image/jpeg');
  });

  it('removes a photograph and its stored file', async () => {
    const projectId = await makeProject('Arjun & Riya', '9812345674');
    const created = await uploadPhoto(projectId, 'remove-me.jpg', Buffer.from('bytes'));

    await authed(token)
      .delete(`${base}/projects/${projectId}/gallery/media/${created.body.data.id}`)
      .expect(200);

    const gallery = await authed(token).get(`${base}/projects/${projectId}/gallery`).expect(200);
    expect(gallery.body.data.media).toHaveLength(0);
    // The FileObject goes with it rather than being orphaned in the bucket.
    expect(await prisma.fileObject.count({ where: { projectId, entityType: 'GALLERY_MEDIA' } })).toBe(0);
  });

  it('returns an empty gallery rather than inventing one before any upload', async () => {
    const projectId = await makeProject('Neha & Sameer', '9812345675');

    const gallery = await authed(token).get(`${base}/projects/${projectId}/gallery`).expect(200);

    expect(gallery.body.data.gallery).toBeNull();
    expect(gallery.body.data.media).toEqual([]);
  });

  it('refuses gallery access to a signed-out caller', async () => {
    const projectId = await makeProject('Ishan & Tara', '9812345676');
    await api().get(`${base}/projects/${projectId}/gallery`).expect(401);
  });
});
