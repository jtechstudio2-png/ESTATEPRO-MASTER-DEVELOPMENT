import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWorker } from '../src/worker/create-worker.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;

let phoneCounter = 7000;
const nextPhone = () => `024${String(9700000 + phoneCounter++).padStart(7, '0')}`;

describe('exports and landlord visibility preview (Phase 5 milestone C4; CA-15, CA-16)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let company: Company;
  let other: Company;
  let kumasiOfficeId: string;
  const tokens: Record<string, string> = {};
  const members: Record<string, string> = {};
  const types: Record<string, string> = {};

  const req = (who: string) => {
    const companyId = who === 'otherOwner' ? other.companyId : company.companyId;
    return {
      get: (path: string) => t.http.get(path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', companyId),
      post: (path: string, body: object = {}) => t.http.post(path).auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', companyId).send(body),
    };
  };

  async function contact(who: string, overrides: Record<string, unknown> = {}) {
    const res = await req(who).post('/api/v1/contacts', { contactType: 'person', displayName: `Export ${randomUUID().slice(0, 6)}`, primaryPhone: nextPhone(), ...overrides });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; version: number; reference: string };
  }

  async function fetchCsv(who: string, exportId: string): Promise<string> {
    const link = await req(who).post(`/api/v1/exports/${exportId}/download`).expect(200);
    expect(link.headers['cache-control']).toBe('no-store');
    const file = await fetch(link.body.url);
    expect(file.status).toBe(200);
    const bytes = Buffer.from(await file.arrayBuffer());
    // UTF-8 byte-order mark, so spreadsheets read Arabic names correctly.
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    return bytes.subarray(3).toString('utf8');
  }

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    company = await fx.company();
    other = await fx.company();
    kumasiOfficeId = (await fx.office(company.companyId, 'KSI')).id;
    for (const row of await fx.db.selectFrom('propertyTypes').select(['id', 'code']).where('companyId', 'is', null).execute()) types[row.code] = row.id;
    const people = {
      owner: { userId: company.ownerUserId, membershipId: company.ownerMembershipId, companyId: company.companyId },
      admin: { ...(await fx.member(company.companyId, { roleKey: 'office_admin' })), companyId: company.companyId },
      sales: { ...(await fx.member(company.companyId, { roleKey: 'sales_manager', officeIds: [company.officeId] })), companyId: company.companyId },
      salesKsi: { ...(await fx.member(company.companyId, { roleKey: 'sales_manager', officeIds: [kumasiOfficeId] })), companyId: company.companyId },
      pm: { ...(await fx.member(company.companyId, { roleKey: 'property_manager', officeIds: [company.officeId] })), companyId: company.companyId },
      agent: { ...(await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] })), companyId: company.companyId },
      accountant: { ...(await fx.member(company.companyId, { roleKey: 'accountant' })), companyId: company.companyId },
      otherOwner: { userId: other.ownerUserId, membershipId: other.ownerMembershipId, companyId: other.companyId },
    };
    const now = Math.floor(Date.now() / 1000);
    for (const [name, member] of Object.entries(people)) {
      members[name] = member.membershipId;
      await fx.linkIdentity(member.userId, `exp-${name}-${member.companyId}`);
      tokens[name] = await t.idp.token({ sub: `exp-${name}-${member.companyId}`, amr: ['pwd', 'mfa'], authTime: now });
    }
  });

  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  describe('contact exports', () => {
    it('exports contacts in scope as CSV without protected details, guarding against spreadsheet formulas', async () => {
      const hq = await contact('owner', {
        displayName: '=HYPERLINK("http://evil.test")',
        displayNameLocal: 'أحمد الكواري',
        officeId: company.officeId,
        dateOfBirth: '1980-01-02',
        taxNumber: 'P0099112233',
        primaryEmail: 'ahmed@example.test',
        relationships: ['landlord'],
        notes: 'Secret staff note',
        consents: [{ purpose: 'marketing', channel: 'email', status: 'withdrawn', capturedVia: 'web_form' }],
      });
      const ksi = await contact('owner', { displayName: 'Kumasi Client', officeId: kumasiOfficeId, relationships: ['landlord'] });
      const res = await req('sales').post('/api/v1/contacts/exports', { purpose: 'Landlord newsletter list', relationships: ['landlord'] }).expect(201);
      expect(res.headers['location']).toBe(`/api/v1/exports/${res.body.id}`);
      expect(res.body).toMatchObject({
        exportType: 'contacts',
        format: 'csv',
        status: 'completed',
        rowCount: 1,
        fileName: expect.stringMatching(/^contacts-\d{12}\.csv$/),
        requestedBy: { id: members['sales'] },
        downloadCount: 0,
        canDownload: true,
        parameters: { purpose: 'Landlord newsletter list', relationships: ['landlord'] },
      });
      const csv = await fetchCsv('sales', res.body.id);
      const lines = csv.trim().split('\r\n');
      expect(lines[0]).toBe('reference,contact_type,display_name,display_name_local,roles,primary_phone,primary_email,preferred_channel,preferred_locale,office,owner,source,marketing_consent,created_at,updated_at');
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain(`"'=HYPERLINK(""http://evil.test"")"`);
      expect(lines[1]).toContain('أحمد الكواري');
      expect(lines[1]).toContain(hq.reference);
      expect(lines[1]).toContain('email:withdrawn');
      expect(lines[1]).toContain("'+233");
      expect(csv).not.toContain('P0099112233');
      expect(csv).not.toContain('1980-01-02');
      expect(csv).not.toContain('Secret staff note');
      expect(csv).not.toContain(ksi.reference);
      const audit = await fx.db.selectFrom('auditLogs').select(['action', 'metadata']).where('entityId', '=', res.body.id).orderBy('occurredAt').execute();
      expect(audit.map((row) => row.action)).toEqual(['contact.exported', 'export.downloaded']);
      expect(audit[0]!.metadata).toMatchObject({ rows: 1, purpose: 'Landlord newsletter list', filters: { relationships: ['landlord'] } });
      expect((await req('sales').get(`/api/v1/exports/${res.body.id}`).expect(200)).body.downloadCount).toBe(1);
    });

    it('filters by office, type and marketing consent, and requires a purpose and the export permission', async () => {
      const granted = await contact('owner', { officeId: company.officeId, consents: [{ purpose: 'marketing', channel: 'sms', status: 'granted', lawfulBasis: 'consent', capturedVia: 'verbal' }] });
      const owner = await req('owner').post('/api/v1/contacts/exports', { purpose: 'Consent-safe SMS list', excludeMarketingWithdrawn: true, officeId: company.officeId, contactType: 'person' }).expect(201);
      const csv = await fetchCsv('owner', owner.body.id);
      expect(csv).toContain(granted.reference);
      expect(csv.trim().split('\r\n')).toHaveLength(owner.body.rowCount + 1);
      await req('owner').post('/api/v1/contacts/exports', {}).expect(422);
      await req('owner').post('/api/v1/contacts/exports', { purpose: 'x' }).expect(422);
      await req('sales').post('/api/v1/contacts/exports', { purpose: 'Other office list', officeId: kumasiOfficeId }).expect(422);
      await req('agent').post('/api/v1/contacts/exports', { purpose: 'My own list please' }).expect(403);
      await req('accountant').post('/api/v1/contacts/exports', { purpose: 'Accounts list' }).expect(403);
    });
  });

  describe('lead exports', () => {
    it('exports leads in scope without enquiry messages', async () => {
      const person = await contact('owner', { officeId: company.officeId });
      const created = await req('owner').post('/api/v1/leads', { contactId: person.id, leadType: 'rent', sourceCode: 'walk_in', message: 'Private enquiry text', officeId: company.officeId }).expect(201);
      const ksiPerson = await contact('owner', { officeId: kumasiOfficeId });
      const ksiLead = await req('owner').post('/api/v1/leads', { contactId: ksiPerson.id, leadType: 'buy', sourceCode: 'phone', officeId: kumasiOfficeId }).expect(201);
      const res = await req('sales').post('/api/v1/leads/exports', { purpose: 'Weekly lead review', statuses: ['new'], leadTypes: ['rent'], receivedFrom: new Date(Date.now() - 86_400_000).toISOString() }).expect(201);
      const csv = await fetchCsv('sales', res.body.id);
      expect(csv).toContain(created.body.reference);
      expect(csv).not.toContain(ksiLead.body.reference);
      expect(csv).not.toContain('Private enquiry text');
      expect(csv.split('\r\n')[0]).toContain('first_response_at');
      const audit = await fx.db.selectFrom('auditLogs').select('action').where('entityId', '=', res.body.id).where('action', '=', 'lead.exported').execute();
      expect(audit).toHaveLength(1);
      const none = await req('sales').post('/api/v1/leads/exports', { purpose: 'Empty window', receivedTo: '2000-01-01T00:00:00Z' }).expect(201);
      expect(none.body.rowCount).toBe(0);
      await req('sales').post('/api/v1/leads/exports', { purpose: 'Bad date', receivedFrom: 'yesterday' }).expect(422);
      await req('pm').post('/api/v1/leads/exports', { purpose: 'Not allowed' }).expect(403);
    });
  });

  describe('downloads and expiry', () => {
    it('lets only the requester download, shows admins the list, and deletes expired files', async () => {
      const job = (await req('sales').post('/api/v1/contacts/exports', { purpose: 'Expiry test export' }).expect(201)).body;
      expect((await req('admin').get('/api/v1/exports').expect(200)).body.map((row: { id: string }) => row.id)).toContain(job.id);
      expect((await req('admin').get(`/api/v1/exports/${job.id}`).expect(200)).body.canDownload).toBe(false);
      await req('admin').post(`/api/v1/exports/${job.id}/download`).expect(403);
      expect((await req('owner').get('/api/v1/exports').expect(200)).body.map((row: { id: string }) => row.id)).toContain(job.id);
      expect((await req('pm').get('/api/v1/exports').expect(200)).body.map((row: { id: string }) => row.id)).not.toContain(job.id);
      await req('pm').get(`/api/v1/exports/${job.id}`).expect(404);
      await req('agent').get('/api/v1/exports').expect(403);
      await req('otherOwner').get(`/api/v1/exports/${job.id}`).expect(404);
      const link = await req('sales').post(`/api/v1/exports/${job.id}/download`).expect(200);

      await fx.db.updateTable('exportJobs').set({ expiresAt: new Date(Date.now() - 1000) }).where('id', '=', job.id).execute();
      const expired = await req('sales').post(`/api/v1/exports/${job.id}/download`).expect(422);
      expect(expired.body.detail).toContain('expired');
      expect((await req('sales').get(`/api/v1/exports/${job.id}`).expect(200)).body).toMatchObject({ status: 'expired', canDownload: false });
      expect((await fetch(link.body.url)).status).toBe(404);
      const audit = await fx.db.selectFrom('auditLogs').select('action').where('entityId', '=', job.id).orderBy('occurredAt').execute();
      expect(audit.map((row) => row.action)).toEqual(['contact.exported', 'export.downloaded', 'export.expired']);
      await req('sales').post(`/api/v1/exports/${randomUUID()}/download`).expect(404);
    });

    it('has the background worker delete expired export files without anyone opening them', async () => {
      const job = (await req('owner').post('/api/v1/contacts/exports', { purpose: 'Worker expiry test' }).expect(201)).body;
      const link = await req('owner').post(`/api/v1/exports/${job.id}/download`).expect(200);
      await fx.db.updateTable('exportJobs').set({ expiresAt: new Date(Date.now() - 1000) }).where('id', '=', job.id).execute();
      const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
      const { worker, close } = createWorker(t.config, silent, { scheduleEveryMs: 0 });
      try {
        await worker.runOnce();
      } finally {
        await close();
      }
      const row = await fx.db.selectFrom('exportJobs').select('status').where('id', '=', job.id).executeTakeFirstOrThrow();
      expect(row.status).toBe('expired');
      expect((await fetch(link.body.url)).status).toBe(404);
      const audit = await fx.db.selectFrom('auditLogs').select(['action', 'actorType']).where('entityId', '=', job.id).where('action', '=', 'export.expired').executeTakeFirstOrThrow();
      expect(audit.actorType).toBe('system');
    });
  });

  describe('landlord visibility preview (#12)', () => {
    it('shows each landlord only what they own or we manage for them, judged in the property time zone', async () => {
      const property = await req('owner')
        .post('/api/v1/properties', {
          name: 'Preview Court',
          propertyTypeId: types['apartment_building'],
          officeId: company.officeId,
          address: { countryCode: 'GH', addressLine1: '1 Preview Road', locality: 'Accra', adminArea1: 'Greater Accra' },
        })
        .expect(201);
      const unitA = (await req('owner').post(`/api/v1/properties/${property.body.id}/units`, { unitLabel: 'Flat A', bedrooms: 2 }).expect(201)).body.id as string;
      const unitB = (await req('owner').post(`/api/v1/properties/${property.body.id}/units`, { unitLabel: 'Flat B', bedrooms: 3 }).expect(201)).body.id as string;
      const listingA = (await fx.listing(company.companyId, unitA, members['owner']!, company.officeId)).id;
      const listingB = (await fx.listing(company.companyId, unitB, members['owner']!, company.officeId)).id;
      const wholeOwner = await contact('owner', { relationships: ['landlord'] });
      const unitOwner = await contact('owner', { relationships: ['landlord'] });
      const former = await contact('owner');
      const managed = await contact('owner', { relationships: ['landlord'] });
      const today = (await sql<{ d: string }>`select (now() at time zone 'Africa/Accra')::date::text as d`.execute(fx.db)).rows[0]!.d;
      await fx.db
        .insertInto('propertyOwnerships')
        .values([
          { companyId: company.companyId, propertyId: property.body.id, ownerContactId: wholeOwner.id, effectiveFrom: '2020-01-01' },
          { companyId: company.companyId, propertyId: property.body.id, unitId: unitB, ownerContactId: unitOwner.id, effectiveFrom: '2021-01-01', sharePercent: '50' },
          { companyId: company.companyId, propertyId: property.body.id, unitId: unitA, ownerContactId: former.id, effectiveFrom: '2019-01-01', effectiveTo: '2020-12-31' },
        ])
        .execute();
      await fx.db
        .insertInto('managementAgreements')
        .values({
          companyId: company.companyId,
          reference: `MGT-P-${randomUUID().slice(0, 6)}`,
          landlordContactId: managed.id,
          propertyId: property.body.id,
          unitId: unitA,
          serviceLevel: 'fully_managed',
          status: 'active',
          currencyCode: 'GHS',
          feeBasis: 'percent_of_rent_collected',
          feePercent: '10',
          startDate: today,
        })
        .execute();

      const whole = await req('owner').get(`/api/v1/contacts/${wholeOwner.id}/portal-visibility-preview`).expect(200);
      expect(whole.headers['cache-control']).toBe('no-store');
      expect(whole.body).toMatchObject({ portal: 'landlord', hasLandlordRole: true, limitedToYourAccess: false });
      expect(whole.body.properties).toHaveLength(1);
      expect(whole.body.properties[0]).toMatchObject({ id: property.body.id, timezone: 'Africa/Accra', basis: [expect.objectContaining({ type: 'ownership', unitId: null })] });
      expect(whole.body.properties[0].units.map((u: { id: string }) => u.id).sort()).toEqual([unitA, unitB].sort());
      expect(whole.body.properties[0].listings.map((l: { id: string }) => l.id).sort()).toEqual([listingA, listingB].sort());
      expect(whole.body.notVisible).toContain('Protected details (identity, tax and bank numbers)');

      const unit = await req('owner').get(`/api/v1/contacts/${unitOwner.id}/portal-visibility-preview`).expect(200);
      expect(unit.body.properties[0].units.map((u: { id: string }) => u.id)).toEqual([unitB]);
      expect(unit.body.properties[0].listings.map((l: { id: string }) => l.id)).toEqual([listingB]);
      expect(unit.body.properties[0].basis[0]).toMatchObject({ sharePercent: '50.0000', kind: 'legal_owner' });

      expect((await req('owner').get(`/api/v1/contacts/${former.id}/portal-visibility-preview`).expect(200)).body).toMatchObject({ properties: [], hasLandlordRole: false });
      const agreement = await req('owner').get(`/api/v1/contacts/${managed.id}/portal-visibility-preview`).expect(200);
      expect(agreement.body.properties[0]).toMatchObject({ basis: [expect.objectContaining({ type: 'management_agreement', kind: 'fully_managed' })], listings: [expect.objectContaining({ id: listingA })] });

      // Staff see the preview only for properties they may view.
      const ksiView = await req('salesKsi').get(`/api/v1/contacts/${wholeOwner.id}/portal-visibility-preview`);
      expect(ksiView.status).toBe(404); // the Kumasi manager cannot see this Osu contact at all
      const accountant = await req('accountant').get(`/api/v1/contacts/${wholeOwner.id}/portal-visibility-preview`).expect(200);
      expect(accountant.body.properties).toHaveLength(1);
      await req('otherOwner').get(`/api/v1/contacts/${wholeOwner.id}/portal-visibility-preview`).expect(404);
      const audit = await fx.db.selectFrom('auditLogs').select('metadata').where('entityId', '=', wholeOwner.id).where('action', '=', 'contact.portal_preview').execute();
      expect(audit[0]!.metadata).toEqual({ portal: 'landlord', properties: 1, units: 2, listings: 2 });
    });

    it('limits the preview to the properties the staff member may view', async () => {
      const ksiProperty = await req('owner')
        .post('/api/v1/properties', {
          name: 'Kumasi Block',
          propertyTypeId: types['house_detached'],
          officeId: kumasiOfficeId,
          createWholePropertyUnit: true,
          address: { countryCode: 'GH', addressLine1: '2 Adum Road', locality: 'Kumasi', adminArea1: 'Ashanti' },
        })
        .expect(201);
      const landlord = await contact('sales', { relationships: ['landlord'], officeId: company.officeId });
      await fx.db.insertInto('propertyOwnerships').values({ companyId: company.companyId, propertyId: ksiProperty.body.id, ownerContactId: landlord.id, effectiveFrom: '2020-01-01' }).execute();
      const sales = await req('sales').get(`/api/v1/contacts/${landlord.id}/portal-visibility-preview`).expect(200);
      expect(sales.body).toMatchObject({ properties: [], limitedToYourAccess: true });
      const owner = await req('owner').get(`/api/v1/contacts/${landlord.id}/portal-visibility-preview`).expect(200);
      expect(owner.body.properties).toHaveLength(1);
    });
  });
});
