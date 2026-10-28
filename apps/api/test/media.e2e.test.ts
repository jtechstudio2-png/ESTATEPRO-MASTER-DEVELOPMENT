import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { sql } from 'kysely';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { ScannerUnavailableError } from '../src/media/scanner.js';
import { createWorker } from '../src/worker/create-worker.js';
import type { Worker } from '../src/worker/worker.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';
import { corruptJpeg, EICAR, pdf, photoWithGps, png, pngBomb, sha256Hex, webp } from './support/media-files.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;
type Member = Awaited<ReturnType<Fixtures['member']>>;

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('media gallery, uploads and worker (Phase 4 M4)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let s3: S3Client;
  let worker: Worker;
  let closeWorker: () => Promise<void>;
  let company: Company;
  let other: Company;
  let agentA: Member;
  let manager: Member;
  let kumasiOfficeId: string;
  const tokens: Record<string, string> = {};
  const types: Record<string, string> = {};
  let property: { id: string };
  let unitId: string;
  let kumasiProperty: { id: string };
  const bucket = inject('testServices').storageBucket;

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    const services = inject('testServices');
    s3 = new S3Client({
      endpoint: services.storageEndpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: services.storageAccessKeyId, secretAccessKey: services.storageSecretAccessKey },
    });
    ({ worker, close: closeWorker } = createWorker(t.config, silent, { scheduleEveryMs: 0 }));

    company = await fx.company();
    other = await fx.company();
    kumasiOfficeId = (await fx.office(company.companyId, 'KSI')).id;
    agentA = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] });
    manager = await fx.member(company.companyId, { roleKey: 'sales_manager', officeIds: [company.officeId] });
    for (const [name, userId] of Object.entries({ owner: company.ownerUserId, agentA: agentA.userId, manager: manager.userId, otherOwner: other.ownerUserId })) {
      await fx.linkIdentity(userId, `media-${name}-${company.companyId}`);
      tokens[name] = await t.idp.token({ sub: `media-${name}-${company.companyId}`, amr: ['pwd', 'mfa'], authTime: Math.floor(Date.now() / 1000) });
    }
    for (const row of await fx.db.selectFrom('propertyTypes').select(['id', 'code']).where('companyId', 'is', null).execute()) types[row.code] = row.id;
    const address = { countryCode: 'GH', addressLine1: '1 Cantonments Road', locality: 'Accra', adminArea1: 'Greater Accra' };
    property = (await as('owner').post('/api/v1/properties', { name: 'Labone Heights', propertyTypeId: types['apartment_building'], officeId: company.officeId, address }).expect(201)).body;
    unitId = (await as('owner').post(`/api/v1/properties/${property.id}/units`, { unitLabel: 'Flat 1', bedrooms: 2 }).expect(201)).body.id;
    kumasiProperty = (
      await as('owner').post('/api/v1/properties', { name: 'Adum Court', propertyTypeId: types['apartment_building'], officeId: kumasiOfficeId, address: { ...address, locality: 'Kumasi', adminArea1: 'Ashanti' } }).expect(201)
    ).body;
  });

  afterAll(async () => {
    await closeWorker();
    s3.destroy();
    await fx.close();
    await t.close();
  });

  const as = (who: string) => {
    const cid = who === 'otherOwner' ? other.companyId : company.companyId;
    const auth = <R extends { auth: (token: string, options: { type: 'bearer' }) => R; set: (name: string, value: string) => R }>(req: R) =>
      req.auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', cid);
    return {
      get: (path: string) => auth(t.http.get(path)),
      post: (path: string, body?: object) => auth(t.http.post(path)).send(body ?? {}),
      patch: (path: string, body: object, version?: number) => {
        const req = auth(t.http.patch(path)).send(body);
        return version === undefined ? req : req.set('If-Match', `"${version}"`);
      },
      put: (path: string, body: object, version?: number) => {
        const req = auth(t.http.put(path)).send(body);
        return version === undefined ? req : req.set('If-Match', `"${version}"`);
      },
      action: (path: string, version: number, body?: object) => auth(t.http.post(path)).set('If-Match', `"${version}"`).send(body ?? {}),
    };
  };

  interface UploadOptions {
    who?: string;
    propertyId?: string;
    unitId?: string;
    listingId?: string;
    mediaType?: string;
    contentType?: string;
    fileName?: string;
    declaredSha?: string;
  }

  function requestUpload(file: Buffer, options: UploadOptions = {}) {
    return as(options.who ?? 'owner').post('/api/v1/media/uploads', {
      propertyId: options.propertyId ?? property.id,
      ...(options.unitId ? { unitId: options.unitId } : {}),
      ...(options.listingId ? { listingId: options.listingId } : {}),
      mediaType: options.mediaType ?? 'photo',
      fileName: options.fileName ?? 'living-room.jpg',
      contentType: options.contentType ?? 'image/jpeg',
      size: file.length,
      sha256: options.declaredSha ?? sha256Hex(file),
    });
  }

  /** Request, PUT to the signed URL, confirm. Returns the pending media. */
  async function upload(file: Buffer, options: UploadOptions = {}) {
    const ticket = await requestUpload(file, options).expect(201);
    const put = await fetch(ticket.body.uploadUrl, { method: 'PUT', headers: { 'Content-Type': ticket.body.headers['Content-Type'] }, body: file });
    expect(put.status).toBe(200);
    const confirmed = await as(options.who ?? 'owner').post(`/api/v1/media/uploads/${ticket.body.id}/confirm`).expect(201);
    return confirmed.body as { id: string; version: number; processingStatus: string };
  }

  async function processed(id: string) {
    await worker.runOnce();
    return (await as('owner').get(`/api/v1/media/${id}`).expect(200)).body;
  }

  async function objectExists(key: string): Promise<boolean> {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async function readObject(key: string): Promise<Buffer> {
    const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return Buffer.from(await result.Body!.transformToByteArray());
  }

  /** Reserved bytes the database says are outstanding: open sessions plus confirmed uploads still processing. */
  async function outstandingReservations(companyId = company.companyId): Promise<number> {
    const row = await sql<{ bytes: string }>`
      select coalesce(sum(s.declared_size), 0)::text as bytes
        from upload_sessions s left join property_media m on m.id = s.media_id
       where s.company_id = ${companyId}::uuid
         and (s.status = 'pending' or (s.status = 'confirmed' and m.processing_status = 'pending'))`.execute(fx.db);
    return Number(row.rows[0]!.bytes);
  }

  async function usage() {
    return (await as('owner').get('/api/v1/settings/storage').expect(200)).body as { planCode: string; limitBytes: number; usedBytes: number; reservedBytes: number };
  }

  // ------------------------------------------------------------------ happy path

  describe('photos', () => {
    it('uploads, scans and processes a photo: sizes, metadata-free master, no raw upload kept', async () => {
      const before = await usage();
      expect(before).toMatchObject({ planCode: 'starter', limitBytes: 25 * 1024 ** 3 });
      const file = await photoWithGps();
      const ticket = await requestUpload(file, { unitId }).expect(201);
      expect(ticket.body).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(file.length) } });
      expect((await usage()).reservedBytes).toBe(before.reservedBytes + file.length);
      await fetch(ticket.body.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: file });
      const pending = (await as('owner').post(`/api/v1/media/uploads/${ticket.body.id}/confirm`).expect(201)).body;
      expect(pending).toMatchObject({ processingStatus: 'pending', mediaType: 'photo', unitId, originalFilename: 'living-room.jpg', urls: {} });
      const again = await as('owner').post(`/api/v1/media/uploads/${ticket.body.id}/confirm`).expect(201);
      expect(again.body.id).toBe(pending.id);

      const ready = await processed(pending.id);
      // EXIF orientation 6 rotates 3000×2000 to 2000×3000; the master is capped at 4096.
      expect(ready).toMatchObject({ processingStatus: 'ready', mimeType: 'image/jpeg', width: 2000, height: 3000, pageCount: null });
      expect(Object.keys(ready.urls).sort()).toEqual(['large', 'medium', 'small', 'thumb']);
      const large = await fetch(ready.urls.large);
      expect(large.status).toBe(200);
      const largeBytes = Buffer.from(await large.arrayBuffer());
      const largeMeta = await sharp(largeBytes).metadata();
      expect(largeMeta).toMatchObject({ format: 'webp', height: 1920, width: 1280 });
      expect(largeMeta.exif).toBeUndefined();

      const row = await fx.db.selectFrom('propertyMedia').selectAll().where('id', '=', pending.id).executeTakeFirstOrThrow();
      const derivatives = row.derivatives as { master: { key: string }; variants: Record<string, { key: string; bytes: number }> };
      const master = await sharp(await readObject(derivatives.master.key)).metadata();
      expect(master).toMatchObject({ format: 'jpeg', width: 2000, height: 3000 });
      expect(master.exif).toBeUndefined();
      expect(master.xmp).toBeUndefined();
      expect(await objectExists(`quarantine/${company.companyId}/${ticket.body.id}`)).toBe(false);
      expect(derivatives.master.key.startsWith(`${company.companyId}/media/${pending.id}/`)).toBe(true);

      const after = await usage();
      expect(after.reservedBytes).toBe(before.reservedBytes);
      expect(after.usedBytes).toBe(before.usedBytes + Number(row.sizeBytes));
      expect(ready.storedBytes).toBe(Number(row.sizeBytes));
      const audit = await fx.db.selectFrom('auditLogs').select(['action', 'actorType']).where('entityId', '=', pending.id).orderBy('occurredAt').execute();
      expect(audit).toEqual([
        { action: 'media.uploaded', actorType: 'user' },
        { action: 'media.processed', actorType: 'system' },
      ]);
    });

    it('accepts PNG and WebP photos and keeps the gallery order', async () => {
      const first = await upload(await png(1600, 1200, '#e0e0e0'), { contentType: 'image/png', fileName: 'kitchen.png' });
      const second = await upload(await webp(1200, 900), { contentType: 'image/webp', fileName: 'garden.webp' });
      expect((await processed(first.id)).processingStatus).toBe('ready');
      expect((await processed(second.id)).processingStatus).toBe('ready');
      const list = await as('owner').get(`/api/v1/properties/${property.id}/media?filter[mediaType]=photo&filter[processingStatus]=ready`).expect(200);
      const ids = list.body.data.map((item: { id: string }) => item.id);
      expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));
      const paged = await as('owner').get(`/api/v1/properties/${property.id}/media?limit=1&sort=-createdAt`).expect(200);
      expect(paged.body.page.nextCursor).not.toBeNull();
      await as('owner').get(`/api/v1/properties/${property.id}/media?limit=1&cursor=${paged.body.page.nextCursor}&sort=-createdAt`).expect(200);
      await as('owner').get(`/api/v1/properties/${property.id}/media?filter[unitId]=${unitId}&filter[archived]=all`).expect(200);
    });
  });

  // ------------------------------------------------------------------ request validation

  describe('upload requests', () => {
    it('validates type, size, target and permissions before signing', async () => {
      const file = await photoWithGps(800, 600);
      const gif = await requestUpload(file, { contentType: 'image/gif' }).expect(422);
      expect(gif.body.errors[0]).toMatchObject({ field: 'contentType', code: 'unsupported' });
      await requestUpload(file, { contentType: 'image/heic' }).expect(422);
      await requestUpload(file, { contentType: 'image/svg+xml', mediaType: 'floor_plan' }).expect(422);
      await requestUpload(file, { mediaType: 'brochure' }).expect(422);
      await as('owner')
        .post('/api/v1/media/uploads', { propertyId: property.id, mediaType: 'photo', fileName: 'x.jpg', contentType: 'image/jpeg', size: 26 * 1024 * 1024, sha256: sha256Hex(file) })
        .expect(422)
        .then((res) => expect(res.body.errors[0]).toMatchObject({ field: 'size', code: 'too-large' }));
      await as('owner')
        .post('/api/v1/media/uploads', { propertyId: property.id, mediaType: 'brochure', fileName: 'x.pdf', contentType: 'application/pdf', size: 21 * 1024 * 1024, sha256: sha256Hex(file) })
        .expect(422);
      await requestUpload(file, { declaredSha: 'XYZ' }).expect(422);
      const otherUnit = (await as('owner').post(`/api/v1/properties/${kumasiProperty.id}/units`, { unitLabel: 'Shop 1' }).expect(201)).body.id;
      await requestUpload(file, { unitId: otherUnit }).expect(422);
      await requestUpload(file, { propertyId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' }).expect(422);

      // Agents edit only properties they created (M2 scope) and cannot see other offices' properties.
      await requestUpload(file, { who: 'agentA' }).expect(403);
      await requestUpload(file, { who: 'agentA', propertyId: kumasiProperty.id }).expect(404);
      await requestUpload(file, { who: 'otherOwner' }).expect(422);
    });

    it('enforces the plan storage quota, and refuses uploads without an active plan', async () => {
      const file = await photoWithGps(800, 600);
      const current = await usage();
      await fx.db.updateTable('storageUsage').set({ bytesUsed: current.limitBytes - file.length + 1 }).where('companyId', '=', company.companyId).execute();
      try {
        const full = await requestUpload(file).expect(403);
        expect(full.body.type).toBe('urn:estatepro:problem:quota-exceeded');
        expect(full.body.detail).toContain('25 GB');
      } finally {
        await fx.db.updateTable('storageUsage').set({ bytesUsed: current.usedBytes }).where('companyId', '=', company.companyId).execute();
      }
      await fx.db.updateTable('subscriptions').set({ status: 'cancelled' }).where('companyId', '=', company.companyId).execute();
      try {
        const none = await requestUpload(file).expect(403);
        expect(none.body.detail).toContain('no active plan');
        expect((await usage()).planCode).toBeNull();
      } finally {
        await fx.db.updateTable('subscriptions').set({ status: 'trialing' }).where('companyId', '=', company.companyId).execute();
      }
    });

    it('confirms only uploaded files of the declared size, by the uploader, before expiry', async () => {
      const file = await photoWithGps(800, 600);
      const notUploaded = await requestUpload(file).expect(201);
      await as('owner').post(`/api/v1/media/uploads/${notUploaded.body.id}/confirm`).expect(422);
      await as('manager').post(`/api/v1/media/uploads/${notUploaded.body.id}/confirm`).expect(403);
      await as('otherOwner').post(`/api/v1/media/uploads/${notUploaded.body.id}/confirm`).expect(404);
      await as('owner').post('/api/v1/media/uploads/not-a-uuid/confirm').expect(404);

      const reserved = (await usage()).reservedBytes;
      const wrongSize = await requestUpload(file).expect(201);
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `quarantine/${company.companyId}/${wrongSize.body.id}`, Body: Buffer.concat([file, Buffer.from('extra')]) }));
      const mismatch = await as('owner').post(`/api/v1/media/uploads/${wrongSize.body.id}/confirm`).expect(422);
      expect(mismatch.body.detail).toContain('size');
      expect((await usage()).reservedBytes).toBe(reserved);
      expect(await objectExists(`quarantine/${company.companyId}/${wrongSize.body.id}`)).toBe(false);
      await as('owner').post(`/api/v1/media/uploads/${wrongSize.body.id}/confirm`).expect(422);

      const late = await requestUpload(file).expect(201);
      await fx.db.updateTable('uploadSessions').set({ expiresAt: new Date(Date.now() - 1000) }).where('id', '=', late.body.id).execute();
      await as('owner').post(`/api/v1/media/uploads/${late.body.id}/confirm`).expect(422);
    });

    it('replays an idempotent upload request', async () => {
      const file = await photoWithGps(640, 480);
      const key = `upload-${fx.uniqueSuffix()}`;
      const first = await requestUpload(file).set('Idempotency-Key', key).expect(201);
      const second = await requestUpload(file).set('Idempotency-Key', key).expect(201);
      expect(second.body.id).toBe(first.body.id);
    });
  });

  // ------------------------------------------------------------------ worker rejections

  describe('processing safety', () => {
    async function rejected(file: Buffer, options: UploadOptions = {}) {
      const media = await upload(file, options);
      const result = await processed(media.id);
      expect(result.processingStatus).toBe('rejected');
      expect(result.urls).toEqual({});
      // The rejected upload no longer holds quota.
      expect((await usage()).reservedBytes).toBe(await outstandingReservations());
      const audit = await fx.db.selectFrom('auditLogs').select(['metadata', 'actorType']).where('entityId', '=', media.id).where('action', '=', 'media.rejected').executeTakeFirstOrThrow();
      expect(audit.actorType).toBe('system');
      return { result, metadata: audit.metadata as Record<string, unknown>, id: media.id };
    }

    it('blocks malware found by clamd and deletes the file', async () => {
      const { result, metadata, id } = await rejected(EICAR, { fileName: 'invoice.jpg' });
      expect(result.rejectionReason).toBe('This file was blocked by the security scan.');
      expect(metadata).toMatchObject({ code: 'malware' });
      expect(String(metadata['signature'])).toMatch(/EICAR/i);
      const row = await fx.db.selectFrom('propertyMedia').select('storageKey').where('id', '=', id).executeTakeFirstOrThrow();
      expect(await objectExists(row.storageKey!)).toBe(false);
    });

    it('rejects files whose content does not match the declared type, checksum or image rules', async () => {
      expect((await rejected(await png(800, 600), { contentType: 'image/jpeg' })).metadata).toMatchObject({ code: 'type-mismatch' });
      const photo = await photoWithGps(800, 600);
      expect((await rejected(photo, { declaredSha: sha256Hex(Buffer.from('something else')) })).metadata).toMatchObject({ code: 'checksum-mismatch' });
      expect((await rejected(corruptJpeg())).metadata).toMatchObject({ code: 'invalid-image' });
      expect((await rejected(pngBomb(), { contentType: 'image/png' })).metadata).toMatchObject({ code: 'too-large' });
      expect((await rejected(await png(500, 400), { contentType: 'image/png', mediaType: 'floor_plan' })).metadata).toMatchObject({ code: 'too-small' });
      expect((await rejected(pdf(), { contentType: 'image/jpeg', fileName: 'photo.jpg' })).metadata).toMatchObject({ code: 'type-mismatch' });
      await requestUpload(pdf(), { contentType: 'application/pdf', mediaType: 'photo' }).expect(422);
    });

    it('rejects unsafe, encrypted and oversized PDFs', async () => {
      const options = { contentType: 'application/pdf', mediaType: 'floor_plan', fileName: 'plan.pdf' };
      expect((await rejected(pdf({ catalogExtra: '/OpenAction << /S /JavaScript /JS (app.alert(1)) >>' }), options)).metadata).toMatchObject({ code: 'unsafe-pdf' });
      expect((await rejected(pdf({ hiddenInStream: '<< /S /Launch /F (cmd.exe) >>' }), options)).metadata).toMatchObject({ code: 'unsafe-pdf' });
      expect((await rejected(pdf({ trailerExtra: '/Encrypt 99 0 R' }), options)).metadata).toMatchObject({ code: 'encrypted-pdf' });
      expect((await rejected(pdf({ pages: 51 }), options)).metadata).toMatchObject({ code: 'too-many-pages' });
    });

    it('keeps files pending while the scanner is down, then fails them after the last retry', async () => {
      const down = createWorker(t.config, silent, {
        scanner: { scan: () => Promise.reject(new ScannerUnavailableError('clamd unavailable')) },
        scheduleEveryMs: 60_000,
      });
      try {
        const media = await upload(await photoWithGps(640, 480));
        await down.worker.runOnce();
        const job = await fx.db.selectFrom('scheduledJobs').selectAll().where('entityId', '=', media.id).executeTakeFirstOrThrow();
        expect(job).toMatchObject({ status: 'pending', attempts: 1, lastError: 'clamd unavailable' });
        expect(job.runAt.getTime()).toBeGreaterThan(Date.now());
        expect((await as('owner').get(`/api/v1/media/${media.id}`).expect(200)).body.processingStatus).toBe('pending');

        await fx.db.updateTable('scheduledJobs').set({ runAt: new Date(), maxAttempts: 2 }).where('id', '=', job.id).execute();
        const reserved = (await usage()).reservedBytes;
        await down.worker.runOnce();
        expect((await fx.db.selectFrom('scheduledJobs').select('status').where('id', '=', job.id).executeTakeFirstOrThrow()).status).toBe('failed');
        const failed = (await as('owner').get(`/api/v1/media/${media.id}`).expect(200)).body;
        expect(failed).toMatchObject({ processingStatus: 'failed' });
        expect((await usage()).reservedBytes).toBeLessThan(reserved);
      } finally {
        await down.close();
      }
    });
  });

  // ------------------------------------------------------------------ floor plans and links

  describe('floor plans and external links', () => {
    it('renders a PDF floor plan preview and serves the PDF only as a download', async () => {
      const media = await upload(pdf({ pages: 2 }), { contentType: 'application/pdf', mediaType: 'floor_plan', fileName: 'Plan – ground floor.pdf' });
      const ready = await processed(media.id);
      expect(ready).toMatchObject({ processingStatus: 'ready', mimeType: 'application/pdf', pageCount: 2 });
      expect(ready.width).toBeGreaterThanOrEqual(1200);
      expect(Object.keys(ready.urls).sort()).toEqual(['download', 'large', 'medium', 'small', 'thumb']);
      const download = await fetch(ready.urls.download);
      expect(download.status).toBe(200);
      expect(download.headers.get('content-disposition')).toContain('attachment');
      expect(download.headers.get('content-disposition')).toContain("filename*=UTF-8''Plan%20%E2%80%93%20ground%20floor.pdf");
      const preview = await sharp(Buffer.from(await (await fetch(ready.urls.thumb)).arrayBuffer())).metadata();
      expect(preview.format).toBe('webp');
    });

    it('processes an image floor plan losslessly', async () => {
      const media = await upload(await png(1600, 1200), { contentType: 'image/png', mediaType: 'floor_plan', fileName: 'plan.png' });
      const ready = await processed(media.id);
      expect(ready).toMatchObject({ processingStatus: 'ready', mimeType: 'image/png', width: 1600, height: 1200 });
      const row = await fx.db.selectFrom('propertyMedia').select('derivatives').where('id', '=', media.id).executeTakeFirstOrThrow();
      expect((row.derivatives as { master: { key: string } }).master.key).toMatch(/master\.png$/);
    });

    it('accepts YouTube, Vimeo and Matterport links only, stored in canonical form', async () => {
      const link = (mediaType: string, url: string) => as('owner').post(`/api/v1/properties/${property.id}/media/links`, { mediaType, url, caption: 'Walkthrough' });
      const youtube = await link('video', 'https://youtu.be/dQw4w9WgXcQ').expect(201);
      expect(youtube.body).toMatchObject({ externalProvider: 'youtube', processingStatus: 'ready', urls: { external: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } });
      await link('video', 'https://www.youtube.com/embed/dQw4w9WgXcQ').expect(201);
      const vimeo = await link('video', 'https://player.vimeo.com/video/123456789').expect(201);
      expect(vimeo.body.urls.external).toBe('https://vimeo.com/123456789');
      const tour = await link('virtual_tour', 'https://my.matterport.com/show/?m=SxQL3iGyoDo').expect(201);
      expect(tour.body).toMatchObject({ externalProvider: 'matterport', urls: { external: 'https://my.matterport.com/show/?m=SxQL3iGyoDo' } });
      for (const [type, url] of [
        ['video', 'http://youtu.be/dQw4w9WgXcQ'],
        ['video', 'https://evil.example/watch?v=dQw4w9WgXcQ'],
        ['video', 'https://my.matterport.com/show/?m=SxQL3iGyoDo'],
        ['virtual_tour', 'https://youtu.be/dQw4w9WgXcQ'],
        ['video', 'not a url'],
      ] as const) {
        await link(type, url).expect(422);
      }
      await as('agentA').post(`/api/v1/properties/${property.id}/media/links`, { mediaType: 'video', url: 'https://youtu.be/dQw4w9WgXcQ' }).expect(403);
    });
  });

  // ------------------------------------------------------------------ edits, archive, erasure, legal hold

  describe('editing and retention', () => {
    it('edits captions and alt text with If-Match and records changes', async () => {
      const media = await processed((await upload(await photoWithGps(800, 600))).id);
      const path = `/api/v1/media/${media.id}`;
      await as('owner').patch(path, { altText: 'Bright living room' }).expect(428);
      await as('owner').patch(path, { altText: 'Bright living room' }, 99).expect(412);
      const edited = await as('owner').patch(path, { altText: 'Bright living room', caption: 'Living room', roomLabel: 'Living', sortOrder: 0 }, media.version).expect(200);
      expect(edited.body).toMatchObject({ altText: 'Bright living room', caption: 'Living room', roomLabel: 'Living', version: media.version + 1 });
      const same = await as('owner').patch(path, { altText: 'Bright living room' }, edited.body.version).expect(200);
      expect(same.body.version).toBe(edited.body.version);
      await as('owner').patch(path, { sortOrder: null }, edited.body.version).expect(422);
      await as('agentA').patch(path, { caption: 'x' }, edited.body.version).expect(403);
    });

    it('archives (removing from listings), restores, and erases only archived, unheld media with a company-wide grant', async () => {
      const listing = (await as('owner').post('/api/v1/listings', { unitId, listingType: 'sale', price: { amount: '900000.00', currency: 'GHS' }, title: 'Flat for sale' }).expect(201)).body;
      const media = await processed((await upload(await photoWithGps(800, 600))).id);
      const gallery = await as('owner').put(`/api/v1/listings/${listing.id}/media`, { items: [{ mediaId: media.id }] }, listing.version).expect(200);
      expect(gallery.body.data[0]).toMatchObject({ id: media.id, isCover: true, position: 0 });
      // G-3: the listings that show the item, and who uploaded it.
      const detail = await as('owner').get(`/api/v1/media/${media.id}`).expect(200);
      expect(detail.body.usedIn).toEqual([{ listingId: listing.id, reference: listing.reference, isCover: true }]);
      expect(detail.body.uploadedByName).toEqual(expect.any(String));

      const path = `/api/v1/media/${media.id}`;
      await as('owner').post(`${path}/purge`, { reason: 'Owner asked' }).expect(422);
      const archived = await as('owner').action(`${path}/archive`, media.version, { reason: 'Old photo' }).expect(200);
      expect(archived.body.archivedAt).not.toBeNull();
      expect(new Date(archived.body.purgeAfter).getTime() - new Date(archived.body.archivedAt).getTime()).toBe(90 * 86_400_000);
      const afterArchive = await as('owner').get(`/api/v1/listings/${listing.id}/media`).expect(200);
      expect(afterArchive.body.data).toEqual([]);
      expect(afterArchive.body.listingVersion).toBe(gallery.body.listingVersion + 1);
      await as('owner').patch(path, { caption: 'x' }, archived.body.version).expect(422);
      await as('owner').action(`${path}/archive`, archived.body.version, { reason: 'Again' }).expect(422);

      const restored = await as('owner').action(`${path}/restore`, archived.body.version).expect(200);
      expect(restored.body.archivedAt).toBeNull();
      await as('owner').action(`${path}/restore`, restored.body.version).expect(422);
      const again = await as('owner').action(`${path}/archive`, restored.body.version, { reason: 'Old photo' }).expect(200);

      const held = await as('owner').post(`${path}/legal-hold`, { hold: true, reason: 'Deposit dispute' }).expect(200);
      expect(held.body).toMatchObject({ legalHold: true, purgeAfter: null });
      await as('manager').post(`${path}/legal-hold`, { hold: false, reason: 'x x x' }).expect(403);
      await as('owner').post(`${path}/legal-hold`, { hold: true, reason: 'Still disputed' }).expect(200);
      await as('owner').post(`${path}/purge`, { reason: 'Erasure request' }).expect(422);
      await as('owner').post(`${path}/legal-hold`, { hold: false, reason: 'Dispute settled' }).expect(200);
      await as('manager').post(`${path}/purge`, { reason: 'Erasure request' }).expect(403);

      const row = await fx.db.selectFrom('propertyMedia').select(['derivatives', 'sizeBytes']).where('id', '=', media.id).executeTakeFirstOrThrow();
      const keys = [(row.derivatives as { master: { key: string } }).master.key];
      const used = (await usage()).usedBytes;
      await as('owner').post(`${path}/purge`, { reason: 'Erasure request from the person in the photo' }).expect(204);
      await as('owner').get(path).expect(404);
      expect(await objectExists(keys[0]!)).toBe(false);
      expect((await usage()).usedBytes).toBe(used - Number(row.sizeBytes));
      const audit = await fx.db.selectFrom('auditLogs').select(['action', 'metadata']).where('entityId', '=', media.id).orderBy('occurredAt').execute();
      expect(audit.map((entry) => entry.action)).toEqual(
        expect.arrayContaining(['media.archived', 'media.restored', 'media.legal_hold_set', 'media.legal_hold_released', 'media.purged']),
      );
      expect(audit.find((entry) => entry.action === 'media.purged')!.metadata).toMatchObject({ reason: 'Erasure request from the person in the photo' });
      expect(again.body.archivedAt).not.toBeNull();
    });
  });

  // ------------------------------------------------------------------ listing galleries

  describe('listing galleries (M-D5)', () => {
    it('lets an agent add media to their own listing, chooses a cover, validates and reorders', async () => {
      const listing = (
        await as('manager')
          .post('/api/v1/listings', { unitId, listingType: 'rent', price: { amount: '5000.00', currency: 'GHS' }, rentFrequency: 'monthly', title: 'Flat to let', agentMembershipId: agentA.membershipId })
          .expect(201)
      ).body;
      const first = await upload(await photoWithGps(900, 600), { who: 'agentA', listingId: listing.id });
      const plan = await upload(await png(1200, 900), { who: 'agentA', listingId: listing.id, contentType: 'image/png', mediaType: 'floor_plan', fileName: 'plan.png' });
      await worker.runOnce();
      const gallery = await as('agentA').get(`/api/v1/listings/${listing.id}/media`).expect(200);
      expect(gallery.body.data.map((item: { id: string; isCover: boolean }) => [item.id, item.isCover])).toEqual([
        [first.id, true],
        [plan.id, false],
      ]);
      const detail = await as('agentA').get(`/api/v1/listings/${listing.id}`).expect(200);
      expect(detail.body.media).toEqual({ photoCount: 1, floorPlanCount: 1, coverMediaId: first.id });

      const second = await processed((await upload(await photoWithGps(900, 600))).id);
      const version = detail.body.version;
      const reordered = await as('agentA')
        .put(`/api/v1/listings/${listing.id}/media`, { items: [{ mediaId: second.id, isCover: true }, { mediaId: first.id }, { mediaId: plan.id }] }, version)
        .expect(200);
      expect(reordered.body.listingVersion).toBe(version + 1);
      expect(reordered.body.data.map((item: { id: string }) => item.id)).toEqual([second.id, first.id, plan.id]);
      const unchanged = await as('agentA')
        .put(`/api/v1/listings/${listing.id}/media`, { items: [{ mediaId: second.id, isCover: true }, { mediaId: first.id }, { mediaId: plan.id }] }, version + 1)
        .expect(200);
      expect(unchanged.body.listingVersion).toBe(version + 1);
      await as('agentA').put(`/api/v1/listings/${listing.id}/media`, { items: [] }, version).expect(412);

      const kumasiMedia = await processed((await upload(await photoWithGps(800, 600), { propertyId: kumasiProperty.id })).id);
      const pending = await upload(await photoWithGps(800, 600));
      const errors = await as('agentA')
        .put(`/api/v1/listings/${listing.id}/media`, { items: [{ mediaId: kumasiMedia.id }, { mediaId: pending.id }, { mediaId: plan.id, isCover: true }, { mediaId: first.id, isCover: true }] }, version + 1)
        .expect(422);
      expect(errors.body.errors.map((error: { code: string }) => error.code)).toEqual(['not-found', 'not-ready', 'invalid-cover', 'one-cover']);
      await as('agentA').put(`/api/v1/listings/${listing.id}/media`, { items: [{ mediaId: first.id }, { mediaId: first.id }] }, version + 1).expect(422);
      await worker.runOnce();

      const otherUnit = (await as('owner').post(`/api/v1/properties/${property.id}/units`, { unitLabel: 'Flat 2' }).expect(201)).body.id;
      const someoneElse = (await as('owner').post('/api/v1/listings', { unitId: otherUnit, listingType: 'sale', price: { amount: '1.00', currency: 'GHS' }, title: 'Other sale' }).expect(201)).body;
      await as('agentA').put(`/api/v1/listings/${someoneElse.id}/media`, { items: [] }, someoneElse.version).expect(403);
      await requestUpload(await photoWithGps(640, 480), { who: 'agentA', listingId: someoneElse.id }).expect(403);
      await requestUpload(await photoWithGps(640, 480), { listingId: someoneElse.id, propertyId: kumasiProperty.id }).expect(422);
      await as('otherOwner').get(`/api/v1/listings/${listing.id}/media`).expect(404);
      await as('otherOwner').put(`/api/v1/listings/${listing.id}/media`, { items: [] }, version + 1).expect(404);
    });

    it('limits photos per listing, enforces publishing checks and carries the gallery over on relist', async () => {
      const unit = (await as('owner').post(`/api/v1/properties/${property.id}/units`, { unitLabel: 'Flat 9' }).expect(201)).body.id;
      const listing = (await as('owner').post('/api/v1/listings', { unitId: unit, listingType: 'sale', price: { amount: '500000.00', currency: 'GHS' }, title: 'Flat 9 for sale' }).expect(201)).body;

      // 61 ready photos, inserted directly (processing is covered above).
      const many = await fx.db
        .insertInto('propertyMedia')
        .values(Array.from({ length: 61 }, (_, index) => ({ companyId: company.companyId, propertyId: property.id, mediaType: 'photo', storageKey: `${company.companyId}/media/bulk-${index}`, processingStatus: 'ready', sortOrder: 1000 + index })))
        .returning('id')
        .execute();
      const tooMany = await as('owner').put(`/api/v1/listings/${listing.id}/media`, { items: many.map((row) => ({ mediaId: row.id })) }, listing.version).expect(422);
      expect(tooMany.body.errors[0]).toMatchObject({ code: 'limit' });

      await as('owner').put('/api/v1/settings/listings', { priceReductionApprovalPercent: null, requireSellerKyc: false, minPhotosToPublish: 2, requireFloorPlanToPublish: true }).expect(200);
      try {
        const settings = await as('owner').get('/api/v1/settings/listings').expect(200);
        expect(settings.body).toMatchObject({ minPhotosToPublish: 2, requireFloorPlanToPublish: true });
        const blocked = await as('owner').action(`/api/v1/listings/${listing.id}/publish`, listing.version).expect(422);
        expect(blocked.body.errors.map((error: { code: string }) => error.code).sort()).toEqual(['floor-plan', 'photos']);
        // Omitted settings fields keep their values.
        await as('owner').put('/api/v1/settings/listings', { priceReductionApprovalPercent: null, requireSellerKyc: false }).expect(200);
        expect((await as('owner').get('/api/v1/settings/listings').expect(200)).body.minPhotosToPublish).toBe(2);

        const planId = (await processed((await upload(await png(1200, 900), { contentType: 'image/png', mediaType: 'floor_plan', fileName: 'p.png' })).id)).id;
        const items = [{ mediaId: many[0]!.id }, { mediaId: many[1]!.id }, { mediaId: planId }];
        const set = await as('owner').put(`/api/v1/listings/${listing.id}/media`, { items }, listing.version).expect(200);
        const published = await as('owner').action(`/api/v1/listings/${listing.id}/publish`, set.body.listingVersion).expect(200);

        await as('owner').action(`/api/v1/listings/${listing.id}/status-transitions`, published.body.version, { toStatus: 'withdrawn', reason: 'Seller paused' }).expect(200);
        const relisted = await as('owner').post(`/api/v1/listings/${listing.id}/relist`).expect(201);
        const copied = await as('owner').get(`/api/v1/listings/${relisted.body.id}/media`).expect(200);
        expect(copied.body.data.map((item: { id: string }) => item.id)).toEqual(items.map((item) => item.mediaId));
        expect(relisted.body.media).toEqual({ photoCount: 2, floorPlanCount: 1, coverMediaId: many[0]!.id });
        await as('owner').put(`/api/v1/listings/${listing.id}/media`, { items: [] }, published.body.version + 1).expect(422);
      } finally {
        await as('owner').put('/api/v1/settings/listings', { priceReductionApprovalPercent: null, requireSellerKyc: false, minPhotosToPublish: null, requireFloorPlanToPublish: false }).expect(200);
      }
    });
  });

  // ------------------------------------------------------------------ worker jobs

  describe('scheduled worker jobs', () => {
    it('expires listings after the mandate ends in the property time zone, as the system', async () => {
      const unit = (await as('owner').post(`/api/v1/properties/${property.id}/units`, { unitLabel: 'Flat 10' }).expect(201)).body.id;
      const make = async (type: 'sale' | 'rent', mandateExpiresOn: string) => {
        const created = (
          await as('owner')
            .post('/api/v1/listings', { unitId: unit, listingType: type, price: { amount: '1000.00', currency: 'GHS' }, title: `Flat 10 ${type}`, ...(type === 'rent' ? { rentFrequency: 'monthly' } : {}), mandateExpiresOn })
            .expect(201)
        ).body;
        return (await as('owner').action(`/api/v1/listings/${created.id}/publish`, created.version).expect(200)).body;
      };
      const yesterday = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
      const later = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
      const ended = await make('sale', later);
      const running = await make('rent', later);
      // The mandate ends while the listing is live (publishing would refuse an expired mandate).
      await fx.db.updateTable('listings').set({ mandateExpiresOn: yesterday }).where('id', '=', ended.id).execute();
      await worker.runOnce();
      const expired = (await as('owner').get(`/api/v1/listings/${ended.id}`).expect(200)).body;
      expect(expired).toMatchObject({ status: 'expired', isPublished: false });
      expect((await as('owner').get(`/api/v1/listings/${running.id}`).expect(200)).body.status).toBe('available');
      const history = await fx.db.selectFrom('listingStatusHistory').selectAll().where('listingId', '=', ended.id).where('toStatus', '=', 'expired').executeTakeFirstOrThrow();
      expect(history).toMatchObject({ changedBy: null, reason: 'Mandate expired' });
      const audit = await fx.db.selectFrom('auditLogs').select(['actorType', 'actorUserId']).where('entityId', '=', ended.id).where('action', '=', 'listing.status_changed').executeTakeFirstOrThrow();
      expect(audit).toEqual({ actorType: 'system', actorUserId: null });
      // A second pass in the same hour is idempotent.
      await worker.runOnce();
    });

    it('purges media archived over 90 days ago, except under legal hold', async () => {
      const keep = await processed((await upload(await photoWithGps(640, 480))).id);
      const drop = await processed((await upload(await photoWithGps(640, 480))).id);
      const recent = await processed((await upload(await photoWithGps(640, 480))).id);
      for (const media of [keep, drop, recent]) await as('owner').action(`/api/v1/media/${media.id}/archive`, media.version, { reason: 'Old' }).expect(200);
      await as('owner').post(`/api/v1/media/${keep.id}/legal-hold`, { hold: true, reason: 'Evidence' }).expect(200);
      const old = new Date(Date.now() - 91 * 86_400_000);
      await fx.db.updateTable('propertyMedia').set({ archivedAt: old }).where('id', 'in', [keep.id, drop.id]).execute();
      const dropRow = await fx.db.selectFrom('propertyMedia').select('derivatives').where('id', '=', drop.id).executeTakeFirstOrThrow();

      await worker.runOnce();
      await as('owner').get(`/api/v1/media/${drop.id}`).expect(404);
      await as('owner').get(`/api/v1/media/${keep.id}`).expect(200);
      await as('owner').get(`/api/v1/media/${recent.id}`).expect(200);
      expect(await objectExists((dropRow.derivatives as { master: { key: string } }).master.key)).toBe(false);
      const purged = await fx.db.selectFrom('auditLogs').select(['actorType', 'metadata']).where('entityId', '=', drop.id).where('action', '=', 'media.purged').executeTakeFirstOrThrow();
      expect(purged).toMatchObject({ actorType: 'system', metadata: { reason: 'Archived for more than 90 days' } });
    });

    it('expires abandoned uploads, fails stuck processing and reconciles storage usage', async () => {
      const file = await photoWithGps(640, 480);
      const before = await usage();
      const abandoned = await requestUpload(file).expect(201);
      await fetch(abandoned.body.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: file });
      await fx.db.updateTable('uploadSessions').set({ expiresAt: new Date(Date.now() - 60_000) }).where('id', '=', abandoned.body.id).execute();

      const stuck = await upload(file);
      await fx.db.updateTable('scheduledJobs').set({ status: 'failed' }).where('entityId', '=', stuck.id).execute();
      await fx.db.updateTable('propertyMedia').set({ createdAt: new Date(Date.now() - 31 * 60_000) }).where('id', '=', stuck.id).execute();

      await fx.db.updateTable('storageUsage').set({ bytesUsed: 1 }).where('companyId', '=', company.companyId).execute();
      // Reconciliation runs once a day: this worker's clock is a day ahead of the earlier passes.
      const tomorrow = createWorker(t.config, silent, { scheduleEveryMs: 0, now: () => new Date(Date.now() + 86_400_000) });
      try {
        await tomorrow.worker.runOnce();
      } finally {
        await tomorrow.close();
      }

      const session = await fx.db.selectFrom('uploadSessions').select('status').where('id', '=', abandoned.body.id).executeTakeFirstOrThrow();
      expect(session.status).toBe('expired');
      expect(await objectExists(`quarantine/${company.companyId}/${abandoned.body.id}`)).toBe(false);
      expect((await as('owner').get(`/api/v1/media/${stuck.id}`).expect(200)).body).toMatchObject({ processingStatus: 'failed' });
      const after = await usage();
      expect(after.usedBytes).toBe(before.usedBytes);
      // Tomorrow every open session has expired: nothing is reserved any more.
      expect(after.reservedBytes).toBe(await outstandingReservations());
      expect(after.reservedBytes).toBe(0);
      const reconciled = await fx.db.selectFrom('auditLogs').select('actorType').where('companyId', '=', company.companyId).where('action', '=', 'storage.reconciled').execute();
      expect(reconciled.length).toBeGreaterThan(0);
    });

    it('runs as a loop until stopped', async () => {
      const loop = createWorker(t.config, silent, { scheduleEveryMs: 60_000 });
      try {
        const running = loop.worker.start(10);
        await new Promise((resolve) => setTimeout(resolve, 50));
        loop.worker.stop();
        await running;
      } finally {
        await loop.close();
      }
    });
  });

  // ------------------------------------------------------------------ isolation

  it('keeps media private to the company', async () => {
    const media = await processed((await upload(await photoWithGps(640, 480))).id);
    await as('otherOwner').get(`/api/v1/media/${media.id}`).expect(404);
    await as('otherOwner').get(`/api/v1/properties/${property.id}/media`).expect(404);
    await as('otherOwner').patch(`/api/v1/media/${media.id}`, { caption: 'x' }, media.version).expect(404);
    await as('otherOwner').action(`/api/v1/media/${media.id}/archive`, media.version, { reason: 'Not mine' }).expect(404);
    const count = await sql<{ n: number }>`select count(*)::int as n from property_media where company_id = ${other.companyId}::uuid`.execute(fx.db);
    expect(count.rows[0]!.n).toBe(0);
    expect((await as('otherOwner').get('/api/v1/settings/storage').expect(200)).body.usedBytes).toBe(0);
  });
});
