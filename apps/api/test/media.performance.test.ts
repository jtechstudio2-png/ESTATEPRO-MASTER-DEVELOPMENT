import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWorker } from '../src/worker/create-worker.js';
import type { Worker } from '../src/worker/worker.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';
import { sha256Hex } from './support/media-files.js';

/**
 * Media throughput (verification report §9.3: about 1–2 s per 12-MP photo on
 * one vCPU) and gallery read latency with signed URLs. The targets here are
 * deliberately looser than the estimate so shared CI runners do not flap.
 */
const PHOTOS = 8;
const TARGET_SECONDS_PER_PHOTO = 3;
const TARGET_GALLERY_P95_MS = 500;

describe('media performance', () => {
  let t: TestApp;
  let fx: Fixtures;
  let worker: Worker;
  let closeWorker: () => Promise<void>;
  let token: string;
  let companyId: string;
  let propertyId: string;

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    ({ worker, close: closeWorker } = createWorker(t.config, { info: () => undefined, warn: () => undefined, error: () => undefined }, { scheduleEveryMs: 60_000 }));
    const company = await fx.company();
    companyId = company.companyId;
    await fx.linkIdentity(company.ownerUserId, `media-perf-${companyId}`);
    token = await t.idp.token({ sub: `media-perf-${companyId}`, amr: ['pwd', 'mfa'], authTime: Math.floor(Date.now() / 1000) });
    const type = await fx.db.selectFrom('propertyTypes').select('id').where('code', '=', 'apartment_building').where('companyId', 'is', null).executeTakeFirstOrThrow();
    propertyId = (
      await t.http
        .post('/api/v1/properties')
        .auth(token, { type: 'bearer' })
        .set('X-Company-Id', companyId)
        .send({ name: 'Perf Court', propertyTypeId: type.id, officeId: company.officeId, address: { countryCode: 'GH', addressLine1: '1 Test St', locality: 'Accra', adminArea1: 'Greater Accra' } })
        .expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await closeWorker();
    await fx.close();
    await t.close();
  });

  it(`processes 12-megapixel photos in under ${TARGET_SECONDS_PER_PHOTO} s each and lists a 60-item gallery quickly`, async () => {
    const photo = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 40 } } })
      .jpeg({ quality: 90 })
      .toBuffer();
    for (let index = 0; index < PHOTOS; index += 1) {
      // Each upload differs by one byte so checksums and objects are distinct.
      const file = Buffer.concat([photo.subarray(0, photo.length - 2), Buffer.from([index]), photo.subarray(photo.length - 2)]);
      const ticket = await t.http
        .post('/api/v1/media/uploads')
        .auth(token, { type: 'bearer' })
        .set('X-Company-Id', companyId)
        .send({ propertyId, mediaType: 'photo', fileName: `photo-${index}.jpg`, contentType: 'image/jpeg', size: file.length, sha256: sha256Hex(file) })
        .expect(201);
      await fetch(ticket.body.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: file });
      await t.http.post(`/api/v1/media/uploads/${ticket.body.id}/confirm`).auth(token, { type: 'bearer' }).set('X-Company-Id', companyId).expect(201);
    }

    const started = performance.now();
    const result = await worker.runOnce();
    const seconds = (performance.now() - started) / 1000;
    // The first pass also runs scheduled jobs (for example storage reconciliation).
    expect(result.processed).toBeGreaterThanOrEqual(PHOTOS);
    const done = await fx.db.selectFrom('propertyMedia').select('id').where('propertyId', '=', propertyId).where('processingStatus', '=', 'ready').execute();
    expect(done).toHaveLength(PHOTOS);
    const perPhoto = seconds / PHOTOS;

    // Fill the gallery to 60 items for the read measurement.
    const ready = await fx.db.selectFrom('propertyMedia').select(['derivatives', 'sizeBytes']).where('propertyId', '=', propertyId).executeTakeFirstOrThrow();
    await fx.db
      .insertInto('propertyMedia')
      .values(
        Array.from({ length: 60 - PHOTOS }, (_, index) => ({
          companyId,
          propertyId,
          mediaType: 'photo',
          storageKey: `${companyId}/media/perf-${index}/master.jpg`,
          processingStatus: 'ready',
          derivatives: JSON.stringify(ready.derivatives),
          sizeBytes: ready.sizeBytes,
          sortOrder: 100 + index,
        })),
      )
      .execute();
    const samples: number[] = [];
    for (let run = 0; run < 20; run += 1) {
      const begin = performance.now();
      const page = await t.http.get(`/api/v1/properties/${propertyId}/media?limit=60`).auth(token, { type: 'bearer' }).set('X-Company-Id', companyId).expect(200);
      samples.push(performance.now() - begin);
      expect(page.body.data).toHaveLength(60);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!;
    console.info(
      `media: ${PHOTOS} photos of ${(photo.length / 1024 / 1024).toFixed(1)} MB (12 MP) in ${seconds.toFixed(1)} s = ${perPhoto.toFixed(2)} s/photo; gallery of 60 with 240 signed URLs: median ${samples[10]!.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms`,
    );
    expect(perPhoto).toBeLessThan(TARGET_SECONDS_PER_PHOTO);
    expect(p95).toBeLessThan(TARGET_GALLERY_P95_MS);
  }, 300_000);
});
