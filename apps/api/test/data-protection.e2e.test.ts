import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';

import { systemContext } from '../src/common/request-context.js';
import { CompanyKeysService } from '../src/crypto/company-keys.service.js';
import { encryptField, keyVersionOf } from '../src/crypto/field-cipher.js';
import { KEY_PROVIDER, KeyUnavailableError, type KeyProvider } from '../src/crypto/key-provider.js';
import { KeyRotationService, RotationError } from '../src/crypto/key-rotation.service.js';
import { SensitiveDataService } from '../src/crypto/sensitive-data.service.js';
import { createKysely, type Db, TenantDb } from '../src/database/database.module.js';
import { ErasureLedger, LedgerError } from '../src/privacy/erasure-ledger.js';
import { ErasureError, ErasureService } from '../src/privacy/erasure.service.js';
import { createWorker } from '../src/worker/create-worker.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;

let counter = 0;
const nextPhone = () => `024${String(8100000 + counter++).padStart(7, '0')}`;
const nextCard = () => `GHA-${String(710000000 + counter++)}-${counter % 10}`;
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const DAY = 86_400_000;

/**
 * ADR-007 stages E5 (key rotation) and E6 (erasure, crypto-shredding, ledger
 * replay after a restore). Rotation and shredding run as the platform role;
 * erasure runs in the company's tenant transaction.
 */
describe('key rotation, erasure and restore replay (ADR-007 E5–E6)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let platform: Db;
  let tenantDb: TenantDb;
  let sensitive: SensitiveDataService;
  let provider: KeyProvider;
  let rotation: KeyRotationService;
  let ledger: ErasureLedger;
  let erasure: ErasureService;
  let company: Company;
  const tokens: Record<string, string> = {};

  const as = (who: string, companyId = company.companyId) => {
    const auth = <T extends { auth: (token: string, options: { type: 'bearer' }) => T; set: (name: string, value: string) => T }>(req: T) =>
      req.auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', companyId);
    return {
      get: (path: string) => auth(t.http.get(path)),
      post: (path: string, body: object = {}) => auth(t.http.post(path)).send(body),
      action: (path: string, version: number, body: object = {}) => auth(t.http.post(path)).set('If-Match', `"${version}"`).send(body),
    };
  };

  async function contact(overrides: Record<string, unknown> = {}) {
    const res = await as('owner').post('/api/v1/contacts', { contactType: 'person', displayName: `DP ${randomUUID().slice(0, 6)}`, primaryPhone: nextPhone(), ...overrides });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; version: number; reference: string; displayName: string };
  }

  async function document(contactId: string, number = nextCard()) {
    const res = await as('owner').post(`/api/v1/contacts/${contactId}/identity-documents`, { documentTypeCode: 'ghana_card', issuingCountryCode: 'GH', documentNumber: number, issuedOn: '2021-03-01', expiresOn: '2031-03-01' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string };
  }

  const reveal = async (companyId: string, contactId: string, field: string) =>
    tenantDb.run({ companyId, userId: '' }, async (tx) => {
      const row = await tx.selectFrom('contacts').select(['dateOfBirthEncrypted', 'taxNumberEncrypted']).where('id', '=', contactId).executeTakeFirstOrThrow();
      const column = field === 'dateOfBirth' ? 'date_of_birth_encrypted' : 'tax_number_encrypted';
      const value = field === 'dateOfBirth' ? row.dateOfBirthEncrypted : row.taxNumberEncrypted;
      return sensitive.open(tx, systemContext(companyId, 'test'), { table: 'contacts', column, rowId: contactId }, value!);
    });

  const keyRows = (companyId: string) =>
    fx.db.selectFrom('companyDataKeys').select(['purpose', 'version', 'status', 'wrappedKey']).where('companyId', '=', companyId).orderBy('purpose').orderBy('version').execute();

  const auditActions = async (companyId: string, actions: string[]) =>
    (await fx.db.selectFrom('auditLogs').select(['action', 'metadata']).where('companyId', '=', companyId).where('action', 'in', actions).orderBy('occurredAt').execute()).map((row) => row.action);

  /** Runs statements as the database owner with triggers off, as a restore (pg_restore) does. */
  async function asAdmin(work: (admin: pg.Client) => Promise<void>) {
    const admin = new pg.Client({ connectionString: inject('databaseUrls').admin });
    await admin.connect();
    try {
      await admin.query('begin');
      await admin.query("set local session_replication_role = 'replica'");
      await work(admin);
      await admin.query('commit');
    } finally {
      await admin.end();
    }
  }

  /** Runs a rotation to completion, moving the clock past each settle period. */
  async function complete(id: string) {
    let clock = Date.now();
    for (let i = 0; i < 10; i += 1) {
      const state = await rotation.step(id, { now: () => new Date(clock) });
      if (state.status === 'completed') return state;
      clock += t.config.KEY_ROTATION_SETTLE_SECONDS * 1000 + 1000;
    }
    throw new Error('rotation did not complete');
  }

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    platform = createKysely(inject('databaseUrls').platform, 2, 'estatepro-tests-dp');
    tenantDb = t.app.get(TenantDb);
    sensitive = t.app.get(SensitiveDataService);
    provider = t.app.get<KeyProvider>(KEY_PROVIDER);
    rotation = new KeyRotationService(platform, provider, t.config);
    ledger = ErasureLedger.fromConfig(t.config);
    erasure = new ErasureService(tenantDb, platform, ledger);
    company = await fx.company();
    await fx.linkIdentity(company.ownerUserId, `dp-owner-${company.companyId}`);
    tokens['owner'] = await t.idp.token({ sub: `dp-owner-${company.companyId}`, amr: ['pwd', 'mfa'], authTime: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    rotation.close();
    ledger.destroy();
    await platform.destroy();
    await fx.close();
    await t.close();
  });

  describe('field-key rotation (E5)', () => {
    it('moves every protected value onto a new key, keeps them readable, and destroys the old key', async () => {
      const person = await contact({ dateOfBirth: '1980-02-03', taxNumber: 'P0099887766' });
      const passport = await document(person.id);
      await fx.db.updateTable('identityDocuments').set({ verifiedAt: new Date(), verifiedBy: company.ownerMembershipId }).where('id', '=', passport.id).execute();
      const before = await fx.db.selectFrom('contacts').select(['version', 'updatedAt', 'taxNumberHash']).where('id', '=', person.id).executeTakeFirstOrThrow();

      const started = await rotation.start({ companyId: company.companyId, purpose: 'field', trigger: 'request', reason: 'Test rotation', requestedBy: 'test operator' });
      expect(started).toMatchObject({ fromVersion: 1, toVersion: 2, status: 'rewriting' });
      expect((await keyRows(company.companyId)).filter((key) => key.purpose === 'field').map((key) => [key.version, key.status])).toEqual([
        [1, 'decrypt_only'],
        [2, 'active'],
      ]);
      await expect(rotation.start({ companyId: company.companyId, purpose: 'field', trigger: 'request', reason: 'Again', requestedBy: 'x' })).rejects.toThrow(RotationError);

      // New writes use the new key at once.
      const during = await contact({ dateOfBirth: '1991-04-05' });
      const duringRow = await fx.db.selectFrom('contacts').select('dateOfBirthEncrypted').where('id', '=', during.id).executeTakeFirstOrThrow();
      expect(keyVersionOf(duringRow.dateOfBirthEncrypted!)).toBe(2);

      // Rewrite, then a value written with the old key by a request that read it before the switch.
      let state = await rotation.step(started.id, { now: () => new Date() });
      expect(state.status).toBe('settling');
      const late = await contact();
      const oldKey = await tenantDb.run({ companyId: company.companyId, userId: '' }, (tx) =>
        new CompanyKeysService(provider, t.config).version(tx, systemContext(company.companyId, 'test'), 'field', 1),
      );
      await fx.db
        .updateTable('contacts')
        .set({ dateOfBirthEncrypted: encryptField(oldKey, 1, { companyId: company.companyId, table: 'contacts', column: 'date_of_birth_encrypted', rowId: late.id }, '1970-01-01') })
        .where('id', '=', late.id)
        .execute();
      expect(await rotation.valuesOnOlderKeys(platform, company.companyId, 2)).toBe(1);
      state = await rotation.step(started.id, { now: () => new Date() });
      expect(state.status).toBe('settling'); // still waiting: nothing destroyed yet
      expect((await keyRows(company.companyId)).find((key) => key.purpose === 'field' && key.version === 1)?.status).toBe('decrypt_only');

      state = await complete(started.id);
      expect(state.status).toBe('completed');
      expect(await rotation.valuesOnOlderKeys(platform, company.companyId, 2)).toBe(0);
      const field = (await keyRows(company.companyId)).filter((key) => key.purpose === 'field');
      expect(field.map((key) => [key.version, key.status, key.wrappedKey === null])).toEqual([
        [1, 'destroyed', true],
        [2, 'active', false],
      ]);

      expect(await reveal(company.companyId, person.id, 'dateOfBirth')).toBe('1980-02-03');
      expect(await reveal(company.companyId, person.id, 'taxNumber')).toBe('P0099887766');
      expect(await reveal(company.companyId, late.id, 'dateOfBirth')).toBe('1970-01-01');
      const document_ = await fx.db.selectFrom('identityDocuments').select(['numberEncrypted', 'verifiedAt']).where('id', '=', passport.id).executeTakeFirstOrThrow();
      expect(keyVersionOf(document_.numberEncrypted!)).toBe(2);
      expect(document_.verifiedAt).not.toBeNull();
      // Re-encryption is not an edit: version, update time and lookup hash are unchanged.
      const after = await fx.db.selectFrom('contacts').select(['version', 'updatedAt', 'taxNumberHash']).where('id', '=', person.id).executeTakeFirstOrThrow();
      expect(after.version).toBe(before.version);
      expect(after.updatedAt).toEqual(before.updatedAt);
      expect(after.taxNumberHash!.equals(before.taxNumberHash!)).toBe(true);
      expect((await auditActions(company.companyId, ['key.rotation_started', 'key.destroyed', 'key.rotation_completed'])).sort()).toEqual([
        'key.destroyed',
        'key.rotation_completed',
        'key.rotation_started',
      ]);
      const audits = await fx.db.selectFrom('auditLogs').select(['metadata', 'actorType']).where('companyId', '=', company.companyId).where('action', 'like', 'key.%').execute();
      expect(audits.every((row) => row.actorType === 'system')).toBe(true);
      expect(JSON.stringify(audits)).not.toMatch(/1980-02-03|P0099887766|wrapped/i);
    });

    it('rotates a lookup key only on compromise, keeps duplicate detection working and re-hashes in two passes', async () => {
      await expect(rotation.start({ companyId: company.companyId, purpose: 'lookup', trigger: 'scheduled', reason: 'Yearly', requestedBy: 'worker' })).rejects.toThrow(/compromise/);
      const card = nextCard();
      const holder = await contact();
      await document(holder.id, card);
      const started = await rotation.start({ companyId: company.companyId, purpose: 'lookup', trigger: 'compromise', reason: 'Suspected leak of hashes', requestedBy: 'security' });
      const state = await complete(started.id);
      expect(state).toMatchObject({ status: 'completed', pass: 2 });
      expect((await keyRows(company.companyId)).filter((key) => key.purpose === 'lookup').map((key) => [key.version, key.status])).toEqual([
        [1, 'destroyed'],
        [2, 'active'],
      ]);
      // The same number on another contact is still recognised as a duplicate.
      const second = await contact();
      const duplicate = await as('owner').post(`/api/v1/contacts/${second.id}/identity-documents`, { documentTypeCode: 'ghana_card', issuingCountryCode: 'GH', documentNumber: card });
      expect(duplicate.status, JSON.stringify(duplicate.body)).toBe(409);
    });

    it('refuses rotations that cannot be done and validates the reason', async () => {
      const empty = await fx.company();
      await expect(rotation.start({ companyId: empty.companyId, purpose: 'field', trigger: 'request', reason: 'Nothing here', requestedBy: 'x' })).rejects.toThrow(/no active field key/);
      await expect(rotation.start({ companyId: company.companyId, purpose: 'field', trigger: 'request', reason: 'x', requestedBy: 'x' })).rejects.toThrow(/reason/);
      await expect(rotation.state(randomUUID())).rejects.toThrow(RotationError);
    });

    it('rotates a field key yearly through the worker', async () => {
      const yearly = await fx.company();
      await fx.linkIdentity(yearly.ownerUserId, `dp-yearly-${yearly.companyId}`);
      tokens['yearly'] = await t.idp.token({ sub: `dp-yearly-${yearly.companyId}`, amr: ['pwd', 'mfa'], authTime: Math.floor(Date.now() / 1000) });
      const res = await as('yearly', yearly.companyId).post('/api/v1/contacts', { contactType: 'person', displayName: 'Yearly person', primaryPhone: nextPhone(), dateOfBirth: '1975-06-07' });
      expect(res.status).toBe(201);
      // Age the key as if it had been made 400 days ago (its creation time is otherwise unchangeable).
      await asAdmin(async (admin) => {
        await admin.query("update company_data_keys set created_at = now() - interval '400 days' where company_id = $1", [yearly.companyId]);
      });
      expect(await rotation.startScheduledIfDue(yearly.companyId, new Date(Date.now() - 100 * DAY))).toBeNull();

      let clock = Date.now();
      const { worker, close } = createWorker(t.config, silent, { scheduleEveryMs: 0, now: () => new Date(clock) });
      try {
        await worker.runOnce();
        const open = await rotation.open(yearly.companyId);
        expect(open).toHaveLength(1);
        expect(open[0]).toMatchObject({ purpose: 'field', status: 'settling', rowsRewritten: 1 });
        clock += (t.config.KEY_ROTATION_SETTLE_SECONDS + 60) * 1000;
        await worker.runOnce();
        expect(await rotation.open(yearly.companyId)).toEqual([]);
        // Not due again for another year.
        expect(await rotation.startScheduledIfDue(yearly.companyId, new Date(clock))).toBeNull();
      } finally {
        await close();
      }
      expect(await reveal(yearly.companyId, res.body.id, 'dateOfBirth')).toBe('1975-06-07');
      const rotations = await fx.db.selectFrom('keyRotations').select(['triggerType', 'requestedBy', 'status']).where('companyId', '=', yearly.companyId).execute();
      expect(rotations).toEqual([{ triggerType: 'scheduled', requestedBy: 'worker', status: 'completed' }]);
    });
  });

  describe('erasure (E6)', () => {
    it('anonymises a person everywhere, records the erasure in the ledger and audit log, and is idempotent', async () => {
      const name = `Erasable ${randomUUID().slice(0, 6)}`;
      const person = await contact({ displayName: name, givenName: 'Efua', familyName: 'Erasable', primaryEmail: `efua-${counter}@example.test`, dateOfBirth: '1988-08-08', notes: 'Lives near the school' });
      const passport = await document(person.id);
      const lead = await as('owner').post('/api/v1/leads', { contactId: person.id, leadType: 'buy', sourceCode: 'phone', message: 'Efua called about the flat' });
      expect(lead.status).toBe(201);
      await as('owner').post('/api/v1/activities', { activityType: 'note', body: 'Efua prefers mornings', links: [{ entityType: 'contact', entityId: person.id }] }).expect(201);
      await as('owner').post('/api/v1/tasks', { title: 'Call Efua', dueAt: new Date(Date.now() + DAY).toISOString(), about: { entityType: 'contact', entityId: person.id } }).expect(201);

      await expect(erasure.eraseContact(company.companyId, person.id, { requestReference: 'Efua Erasable', requestedBy: 'dpo' })).rejects.toThrow(ErasureError);
      const result = await erasure.eraseContact(company.companyId, person.id, { requestReference: 'DSR-2026-0042', requestedBy: 'Data protection officer' });
      expect(result).toMatchObject({ alreadyErased: false, erasedContactIds: [person.id] });
      expect(result.counts).toMatchObject({ contacts: 1, identity_documents: 1, leads: 1, activities: expect.any(Number), tasks: 1 });
      expect(result.ledgerKey).toMatch(/^erasure-ledger\/\d{4}-\d{2}\/.*contact_erasure/);

      const record = await as('owner').get(`/api/v1/contacts/${person.id}`).expect(200);
      expect(record.body).toMatchObject({ displayName: 'Erased contact', isAnonymised: true, primaryEmail: null, primaryPhone: null });
      expect(JSON.stringify(record.body)).not.toMatch(/Efua|Erasable|school/);
      const search = await as('owner').get(`/api/v1/contacts?q=${encodeURIComponent(name)}`).expect(200);
      expect(search.body.data).toEqual([]);
      const timeline = await as('owner').get(`/api/v1/contacts/${person.id}/activities`).expect(200);
      expect(JSON.stringify(timeline.body)).not.toMatch(/Efua|mornings/);
      const documents = await as('owner').get(`/api/v1/contacts/${person.id}/identity-documents`).expect(200);
      expect(documents.body[0]).toMatchObject({ id: passport.id, numberLast4: null });
      expect((await as('owner').post(`/api/v1/contacts/${person.id}/sensitive/dateOfBirth/reveal`, { reason: 'Checking after erasure' })).status).toBe(404);

      const stored = await fx.db.selectFrom('auditLogs').select(['action', 'changes', 'metadata']).where('companyId', '=', company.companyId).where('entityId', '=', person.id).execute();
      expect(JSON.stringify(stored.filter((row) => row.action !== 'contact.erased'))).not.toMatch(/Efua|Erasable|school/);
      const erased = stored.find((row) => row.action === 'contact.erased');
      expect(erased?.metadata).toMatchObject({ requestReference: 'DSR-2026-0042', requestedBy: 'Data protection officer', erasedContactIds: [person.id] });

      const entries = await ledger.entries();
      const entry = entries.find((item) => item.type === 'contact_erasure' && item.contactIds.includes(person.id));
      expect(entry).toMatchObject({ companyId: company.companyId, requestReference: 'DSR-2026-0042' });
      expect(JSON.stringify(entries)).not.toMatch(/Efua|Erasable/);

      expect(await erasure.eraseContact(company.companyId, person.id, { requestReference: 'DSR-2026-0042', requestedBy: 'dpo' })).toMatchObject({ alreadyErased: true, ledgerKey: null });
    });

    it('erases records merged into the person, and refuses merged records, organisations, unknown contacts and parties to financial records', async () => {
      const keep = await contact({ givenName: 'Kojo' });
      const away = await contact({ givenName: 'Kojo duplicate', confirmNotDuplicate: true });
      const merged = await as('owner').action(`/api/v1/contacts/${keep.id}/merge`, keep.version, { mergeContactId: away.id, mergeVersion: away.version, fields: {} });
      expect(merged.status, JSON.stringify(merged.body)).toBe(200);
      await expect(erasure.eraseContact(company.companyId, away.id, { requestReference: 'DSR-1', requestedBy: 'dpo' })).rejects.toMatchObject({ code: 'merged' });
      const result = await erasure.eraseContact(company.companyId, keep.id, { requestReference: 'DSR-1', requestedBy: 'dpo' });
      expect([...result.erasedContactIds].sort()).toEqual([keep.id, away.id].sort());
      const awayRow = await fx.db.selectFrom('contacts').select(['isAnonymised', 'givenName']).where('id', '=', away.id).executeTakeFirstOrThrow();
      expect(awayRow).toEqual({ isAnonymised: true, givenName: null });

      const organisation = await contact({ contactType: 'organisation', organisationName: 'Erase Me Ltd', displayName: 'Erase Me Ltd' });
      await expect(erasure.eraseContact(company.companyId, organisation.id, { requestReference: 'DSR-2', requestedBy: 'dpo' })).rejects.toMatchObject({ code: 'blocked', blockers: ['organisation'] });
      await expect(erasure.eraseContact(company.companyId, randomUUID(), { requestReference: 'DSR-3', requestedBy: 'dpo' })).rejects.toMatchObject({ code: 'not_found' });

      // A person with a payment account (financial records are kept by law) cannot be erased.
      const payees = await fx.company();
      const payee = await fx.db
        .insertInto('contacts')
        .values({ companyId: payees.companyId, contactType: 'person', displayName: 'Payee person' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await fx.db
        .insertInto('contactPaymentAccounts')
        .values({
          companyId: payees.companyId,
          contactId: payee.id,
          accountType: 'bank',
          accountName: 'Payee person',
          providerName: 'Test Bank',
          countryCode: 'GH',
          currencyCode: 'GHS',
          accountNumberEncrypted: Buffer.from('not-used'),
          last4: '1234',
        })
        .execute();
      await expect(erasure.eraseContact(payees.companyId, payee.id, { requestReference: 'DSR-4', requestedBy: 'dpo' })).rejects.toMatchObject({
        code: 'blocked',
        blockers: ['contact_payment_accounts'],
      });
      // Another company's contact is not visible from this company.
      const stranger = await fx.company();
      await expect(erasure.eraseContact(stranger.companyId, keep.id, { requestReference: 'DSR-5', requestedBy: 'dpo' })).rejects.toMatchObject({ code: 'not_found' });
    });

    it('erases nothing when the ledger cannot be written', async () => {
      const person = await contact({ givenName: 'Ledgerless' });
      const broken = new ErasureService(tenantDb, platform, ErasureLedger.fromConfig({ ...t.config, STORAGE_ENDPOINT: 'http://127.0.0.1:9' }));
      await expect(broken.eraseContact(company.companyId, person.id, { requestReference: 'DSR-6', requestedBy: 'dpo' })).rejects.toThrow();
      const row = await fx.db.selectFrom('contacts').select(['isAnonymised', 'givenName']).where('id', '=', person.id).executeTakeFirstOrThrow();
      expect(row).toEqual({ isAnonymised: false, givenName: 'Ledgerless' });
      expect(() => ErasureLedger.fromConfig({ ...t.config, ERASURE_LEDGER_BUCKET: undefined })).toThrow(LedgerError);
    });
  });

  describe('company crypto-shredding and restore replay (E6)', () => {
    it('destroys every key of a cancelled company so its protected values cannot be read', async () => {
      const closing = await fx.company();
      await fx.linkIdentity(closing.ownerUserId, `dp-closing-${closing.companyId}`);
      tokens['closing'] = await t.idp.token({ sub: `dp-closing-${closing.companyId}`, amr: ['pwd', 'mfa'], authTime: Math.floor(Date.now() / 1000) });
      const person = await as('closing', closing.companyId).post('/api/v1/contacts', { contactType: 'person', displayName: 'Closing person', primaryPhone: nextPhone(), taxNumber: 'P0011223344' });
      expect(person.status).toBe(201);
      const slug = (await fx.db.selectFrom('companies').select('slug').where('id', '=', closing.companyId).executeTakeFirstOrThrow()).slug;

      const request = { requestReference: 'CLOSE-77', requestedBy: 'platform operator' };
      await expect(erasure.shredCompany(closing.companyId, slug, request)).rejects.toMatchObject({ code: 'company_not_closed' });
      await fx.db.updateTable('companies').set({ status: 'cancelled' }).where('id', '=', closing.companyId).execute();
      await expect(erasure.shredCompany(closing.companyId, 'wrong-slug', request)).rejects.toMatchObject({ code: 'invalid_request' });
      const result = await erasure.shredCompany(closing.companyId, slug, request);
      expect(result.keysDestroyed).toBe(2);
      expect((await keyRows(closing.companyId)).every((key) => key.status === 'destroyed' && key.wrappedKey === null)).toBe(true);

      // A fresh process (no cached keys) can neither read nor write protected values.
      const fresh = new SensitiveDataService(new CompanyKeysService(provider, t.config));
      const ctx = systemContext(closing.companyId, 'test');
      const row = await fx.db.selectFrom('contacts').select('taxNumberEncrypted').where('id', '=', person.body.id).executeTakeFirstOrThrow();
      await expect(tenantDb.run(ctx, (tx) => fresh.open(tx, ctx, { table: 'contacts', column: 'tax_number_encrypted', rowId: person.body.id }, row.taxNumberEncrypted!))).rejects.toMatchObject({ status: 503, code: 'encryption-unavailable' });
      await expect(tenantDb.run(ctx, (tx) => fresh.seal(tx, ctx, { table: 'contacts', column: 'date_of_birth_encrypted', rowId: person.body.id }, '2000-01-01'))).rejects.toMatchObject({ status: 503 });
      await expect(tenantDb.run(ctx, (tx) => new CompanyKeysService(provider, t.config).active(tx, ctx, 'field'))).rejects.toThrow(KeyUnavailableError);
      expect(await auditActions(closing.companyId, ['company.keys_destroyed'])).toEqual(['company.keys_destroyed']);
    });

    it('restore drill: after restoring a backup taken before an erasure and a shred, replaying the ledger erases them again', async () => {
      const admin = new pg.Client({ connectionString: inject('databaseUrls').admin });
      await admin.connect();
      try {
        // "Backup": the rows as they are before the erasure and the shred.
        const person = await contact({ givenName: 'Restored', dateOfBirth: '1966-06-06', primaryEmail: `restored-${counter}@example.test` });
        const backupContact = (await admin.query('select * from contacts where id = $1', [person.id])).rows[0] as Record<string, unknown>;
        const shredded = await fx.company();
        await tenantDb.run({ companyId: shredded.companyId, userId: '' }, (tx) => new CompanyKeysService(provider, t.config).active(tx, systemContext(shredded.companyId, 'test'), 'field'));
        const backupKeys = (await admin.query('select * from company_data_keys where company_id = $1', [shredded.companyId])).rows as Record<string, unknown>[];

        await erasure.eraseContact(company.companyId, person.id, { requestReference: 'DSR-DRILL', requestedBy: 'drill' });
        await fx.db.updateTable('companies').set({ status: 'cancelled' }).where('id', '=', shredded.companyId).execute();
        const slug = (await fx.db.selectFrom('companies').select('slug').where('id', '=', shredded.companyId).executeTakeFirstOrThrow()).slug;
        await erasure.shredCompany(shredded.companyId, slug, { requestReference: 'CLOSE-DRILL', requestedBy: 'drill' });

        // "Restore": put the backed-up rows back as a restore would (triggers off, as pg_restore loads data).
        await admin.query('begin');
        await admin.query("set local session_replication_role = 'replica'");
        const columns = Object.keys(backupContact).filter((column) => column !== 'search_vector');
        await admin.query(
          `update contacts set (${columns.join(', ')}) = (select ${columns.join(', ')} from json_populate_record(null::contacts, $1)) where id = $2`,
          [JSON.stringify(backupContact), person.id],
        );
        for (const key of backupKeys) {
          await admin.query('update company_data_keys set status = $1, wrapped_key = $2, destroyed_at = null, retired_at = $3 where company_id = $4 and purpose = $5 and version = $6', [
            key['status'],
            key['wrapped_key'],
            key['retired_at'],
            key['company_id'],
            key['purpose'],
            key['version'],
          ]);
        }
        await admin.query('commit');
        expect((await fx.db.selectFrom('contacts').select(['isAnonymised', 'givenName']).where('id', '=', person.id).executeTakeFirstOrThrow()).givenName).toBe('Restored');
        expect((await keyRows(shredded.companyId)).every((key) => key.status === 'active')).toBe(true);

        // The dry run reports and changes nothing.
        const dry = await erasure.replay({ dryRun: true });
        expect(dry.failures).toEqual([]);
        expect((await fx.db.selectFrom('contacts').select('givenName').where('id', '=', person.id).executeTakeFirstOrThrow()).givenName).toBe('Restored');

        const summary = await erasure.replay();
        expect(summary.failures).toEqual([]);
        expect(summary.contactsErased).toBeGreaterThanOrEqual(1);
        expect(summary.keysDestroyed).toBeGreaterThanOrEqual(1);
        expect(await fx.db.selectFrom('contacts').select(['isAnonymised', 'givenName', 'primaryEmail', 'dateOfBirthEncrypted']).where('id', '=', person.id).executeTakeFirstOrThrow()).toEqual({
          isAnonymised: true,
          givenName: null,
          primaryEmail: null,
          dateOfBirthEncrypted: null,
        });
        expect((await keyRows(shredded.companyId)).every((key) => key.status === 'destroyed' && key.wrappedKey === null)).toBe(true);
        expect(await auditActions(company.companyId, ['contact.erasure_replayed'])).toContain('contact.erasure_replayed');

        // Replaying again changes nothing.
        const again = await erasure.replay();
        expect(again).toMatchObject({ contactsErased: 0, keysDestroyed: 0, failures: [] });
        expect(again.contactsAlreadyErased).toBeGreaterThanOrEqual(1);
      } finally {
        await admin.end();
      }
    });

    it('reports a ledger entry it cannot apply and keeps going', async () => {
      const stray = { type: 'contact_erasure' as const, id: randomUUID(), at: new Date().toISOString(), companyId: randomUUID(), contactIds: [randomUUID()], requestReference: 'DSR-STRAY', requestedBy: 'test' };
      await ledger.append(stray);
      const summary = await erasure.replay({ dryRun: true });
      expect(summary.contactsMissing).toBeGreaterThanOrEqual(1);
      await expect(ledger.append({ ...stray, requestReference: 'has a space' })).rejects.toThrow(LedgerError);
      await expect(ledger.append({ ...stray, contactIds: [] })).rejects.toThrow(LedgerError);
    });
  });
});
