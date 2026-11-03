import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

type Company = Awaited<ReturnType<Fixtures['company']>>;

let phoneCounter = 6000;
const nextPhone = () => `024${String(8000000 + phoneCounter++).padStart(7, '0')}`;
let cardCounter = 100000;
const nextCard = () => `GHA-${String(712000000 + cardCounter++)}-3`;

describe('identity documents and KYC checks (Phase 5 milestone C2, CRM-09)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let company: Company;
  let other: Company;
  let kumasiOfficeId: string;
  const tokens: Record<string, string> = {};
  const members: Record<string, string> = {};

  const as = (who: string, companyId = who === 'otherOwner' ? other.companyId : company.companyId) => {
    const auth = <T extends { auth: (token: string, options: { type: 'bearer' }) => T; set: (name: string, value: string) => T }>(req: T) =>
      req.auth(tokens[who]!, { type: 'bearer' }).set('X-Company-Id', companyId);
    return {
      get: (path: string) => auth(t.http.get(path)),
      post: (path: string, body: object = {}) => auth(t.http.post(path)).send(body),
      patch: (path: string, body: object, version?: number) => {
        const req = auth(t.http.patch(path)).send(body);
        return version === undefined ? req : req.set('If-Match', `"${version}"`);
      },
      action: (path: string, version: number, body: object = {}) => auth(t.http.post(path)).set('If-Match', `"${version}"`).send(body),
    };
  };

  async function contact(who: string, overrides: Record<string, unknown> = {}) {
    const res = await as(who).post('/api/v1/contacts', { contactType: 'person', displayName: `Seller ${randomUUID().slice(0, 6)}`, primaryPhone: nextPhone(), ...overrides });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; version: number };
  }

  async function document(who: string, contactId: string, overrides: Record<string, unknown> = {}) {
    const res = await as(who).post(`/api/v1/contacts/${contactId}/identity-documents`, {
      documentTypeCode: 'ghana_card',
      issuingCountryCode: 'GH',
      documentNumber: nextCard(),
      issuedOn: '2021-03-01',
      expiresOn: '2031-03-01',
      ...overrides,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; version: number; numberLast4: string; [key: string]: unknown };
  }

  async function check(who: string, contactId: string, body: Record<string, unknown> = {}) {
    const res = await as(who).post(`/api/v1/contacts/${contactId}/kyc-checks`, { checkType: 'identity', ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; version: number; status: string; [key: string]: unknown };
  }

  const audits = (contactId: string, action: string) =>
    fx.db.selectFrom('auditLogs').selectAll().where('entityId', '=', contactId).where('action', '=', action).orderBy('occurredAt').execute();

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    company = await fx.company();
    other = await fx.company();
    kumasiOfficeId = (await fx.office(company.companyId, 'KSI')).id;
    const people = {
      owner: { userId: company.ownerUserId, membershipId: company.ownerMembershipId, companyId: company.companyId },
      admin: { ...(await fx.member(company.companyId, { roleKey: 'office_admin' })), companyId: company.companyId },
      sales: { ...(await fx.member(company.companyId, { roleKey: 'sales_manager', officeIds: [company.officeId] })), companyId: company.companyId },
      salesKsi: { ...(await fx.member(company.companyId, { roleKey: 'sales_manager', officeIds: [kumasiOfficeId] })), companyId: company.companyId },
      agent: { ...(await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] })), companyId: company.companyId },
      agent2: { ...(await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] })), companyId: company.companyId },
      accountant: { ...(await fx.member(company.companyId, { roleKey: 'accountant' })), companyId: company.companyId },
      technician: { ...(await fx.member(company.companyId, { roleKey: 'maintenance_staff' })), companyId: company.companyId },
      otherOwner: { userId: other.ownerUserId, membershipId: other.ownerMembershipId, companyId: other.companyId },
    };
    const now = Math.floor(Date.now() / 1000);
    for (const [name, member] of Object.entries(people)) {
      members[name] = member.membershipId;
      await fx.linkIdentity(member.userId, `kyc-${name}-${member.companyId}`);
      tokens[name] = await t.idp.token({ sub: `kyc-${name}-${member.companyId}`, amr: ['pwd', 'mfa'], authTime: now });
    }
  });

  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  describe('identity documents (C-5)', () => {
    it('stores the number encrypted, returns only its last characters, and audits without it', async () => {
      const seller = await contact('owner', { relationships: ['seller'] });
      const number = 'GHA-712345678-9';
      const created = await document('owner', seller.id, { documentNumber: number });
      expect(created).toMatchObject({
        documentTypeCode: 'ghana_card',
        issuingCountryCode: 'GH',
        numberLast4: '6789',
        expired: false,
        verified: null,
        canEdit: true,
        canReveal: true,
        version: 1,
      });
      expect(JSON.stringify(created)).not.toContain('712345678');
      const row = await fx.db.selectFrom('identityDocuments').selectAll().where('id', '=', created.id).executeTakeFirstOrThrow();
      expect(row.numberEncrypted.toString('latin1')).not.toContain('712345678');
      expect(row.numberHash).toHaveLength(32);
      expect(row.createdBy).toBe(members['owner']);
      const [audit] = await audits(seller.id, 'contact.identity_document_added');
      expect(audit!.metadata).toEqual({ identityDocumentId: created.id, documentTypeCode: 'ghana_card', issuingCountryCode: 'GH' });
      expect(JSON.stringify(audit)).not.toContain('712345678');
      // Reveal stays with the E4 endpoint: same number back, to a member allowed to reveal.
      const reveal = await as('owner').post(`/api/v1/contacts/${seller.id}/identity-documents/${created.id}/reveal`, { reason: 'Checking the card for the sale of Osu House' }).expect(200);
      expect(reveal.body.value).toBe(number);
      expect(reveal.headers['cache-control']).toBe('no-store');
    });

    it('keeps reveal permissions unchanged: office administrators and managers cannot reveal', async () => {
      const seller = await contact('owner', { officeId: company.officeId });
      const created = await document('owner', seller.id);
      for (const who of ['admin', 'sales']) {
        const listed = await as(who).get(`/api/v1/contacts/${seller.id}/identity-documents`).expect(200);
        expect(listed.body[0]).toMatchObject({ id: created.id, canReveal: false });
        await as(who).post(`/api/v1/contacts/${seller.id}/identity-documents/${created.id}/reveal`, { reason: 'Trying to read the number' }).expect(403);
      }
      const accountant = await as('accountant').get(`/api/v1/contacts/${seller.id}/identity-documents`).expect(200);
      expect(accountant.body[0]).toMatchObject({ canReveal: true, canEdit: false });
    });

    it('checks the document type against the issuing country, and the dates', async () => {
      const seller = await contact('owner');
      const fields = async (body: object) => {
        const res = await as('owner')
          .post(`/api/v1/contacts/${seller.id}/identity-documents`, { documentTypeCode: 'ghana_card', issuingCountryCode: 'GH', documentNumber: nextCard(), ...body })
          .expect(422);
        return (res.body.errors as Array<{ field: string }>).map((e) => e.field).sort();
      };
      expect(await fields({ issuingCountryCode: 'QA' })).toEqual(['documentTypeCode']);
      expect(await fields({ issuingCountryCode: 'ZZ' })).toEqual(['issuingCountryCode']);
      expect(await fields({ issuedOn: '2030-01-01' })).toEqual(['issuedOn']);
      expect(await fields({ issuedOn: '2022-01-01', expiresOn: '2021-01-01' })).toEqual(['expiresOn']);
      expect(await fields({ expiresOn: '2021-02-30' })).toEqual(['expiresOn']);
      expect(await fields({ documentNumber: '-/-/-' })).toEqual(['documentNumber']);
      expect(await fields({ documentNumber: 'A - B' })).toEqual(['documentNumber']);
      await document('owner', seller.id, { documentTypeCode: 'qatar_id', issuingCountryCode: 'QA', documentNumber: '28763412345' });
      await document('owner', seller.id, { documentTypeCode: 'passport', issuingCountryCode: 'GB', documentNumber: '533380006', issuedOn: null, expiresOn: null });
    });

    it('refuses the same number twice on one contact, whatever its format', async () => {
      const seller = await contact('owner');
      await document('owner', seller.id, { documentNumber: 'GHA-700000001-1' });
      const res = await as('owner')
        .post(`/api/v1/contacts/${seller.id}/identity-documents`, { documentTypeCode: 'ghana_card', issuingCountryCode: 'GH', documentNumber: 'gha 700000001 1' })
        .expect(409);
      expect(res.body.type).toMatch(/conflict$/);
    });

    it('reports another contact with the same number as a possible duplicate, never merging, until confirmed', async () => {
      const first = await contact('owner', { displayName: 'Kwame Asante' });
      const second = await contact('owner', { displayName: 'K. Asante' });
      const number = 'GHA-700000002-2';
      await document('owner', first.id, { documentNumber: number });
      const duplicate = await as('owner')
        .post(`/api/v1/contacts/${second.id}/identity-documents`, { documentTypeCode: 'ghana_card', issuingCountryCode: 'GH', documentNumber: number })
        .expect(409);
      expect(duplicate.body.type).toMatch(/possible-duplicates$/);
      expect(duplicate.body.candidates).toEqual([expect.objectContaining({ visible: true, id: first.id, displayName: 'Kwame Asante', matchedOn: ['identity_document'] })]);
      const confirmed = await document('owner', second.id, { documentNumber: number, confirmNotDuplicate: true });
      const [audit] = await audits(second.id, 'contact.identity_document_added');
      expect(audit!.metadata).toMatchObject({ identityDocumentId: confirmed.id, duplicateConfirmed: [first.id] });
      const both = await fx.db.selectFrom('contacts').select('mergedIntoContactId').where('id', 'in', [first.id, second.id]).execute();
      expect(both.every((row) => row.mergedIntoContactId === null)).toBe(true);
    });

    it('shows an agent no details of a matching contact outside their scope', async () => {
      const elsewhere = await contact('owner');
      const number = 'GHA-700000003-3';
      await document('owner', elsewhere.id, { documentNumber: number });
      const own = await contact('agent');
      const res = await as('agent')
        .post(`/api/v1/contacts/${own.id}/identity-documents`, { documentTypeCode: 'ghana_card', issuingCountryCode: 'GH', documentNumber: number })
        .expect(409);
      expect(res.body.candidates).toEqual([{ visible: false, id: null, reference: null, displayName: null, ownerName: null, archived: false, matchedOn: ['identity_document'] }]);
      await document('agent', own.id, { documentNumber: number, confirmNotDuplicate: true });
      const [audit] = await audits(own.id, 'contact.identity_document_added');
      expect((audit!.metadata as Record<string, unknown>)['duplicateConfirmed']).toBeUndefined();
    });

    it('corrects an unverified document with If-Match, re-encrypting a new number', async () => {
      const seller = await contact('owner');
      const created = await document('owner', seller.id, { documentNumber: 'GHA-700000004-4' });
      const path = `/api/v1/contacts/${seller.id}/identity-documents/${created.id}`;
      await as('owner').patch(path, { expiresOn: '2032-01-01' }).expect(428);
      await as('owner').patch(path, { expiresOn: '2032-01-01' }, 7).expect(412);
      const same = await as('owner').patch(path, { documentNumber: 'gha 700000004 4', expiresOn: '2031-03-01' }, 1).expect(200);
      expect(same.body.version).toBe(1);
      const updated = await as('owner').patch(path, { documentNumber: 'GHA-700000005-5', expiresOn: '2032-01-01' }, 1).expect(200);
      expect(updated.body).toMatchObject({ numberLast4: '0055', expiresOn: '2032-01-01', version: 2 });
      expect(updated.headers['etag']).toBe('"2"');
      const [audit] = await audits(seller.id, 'contact.identity_document_updated');
      expect(audit!.metadata).toMatchObject({
        changes: { expiresOn: { old: '2031-03-01', new: '2032-01-01' }, documentNumber: { old: '[protected]', new: '[protected]' } },
      });
      expect(JSON.stringify(audit)).not.toContain('700000005');
      const reveal = await as('owner').post(`${path}/reveal`, { reason: 'Confirming the corrected number' }).expect(200);
      expect(reveal.body.value).toBe('GHA-700000005-5');
      await as('owner').patch(path, { documentTypeCode: 'qatar_id' }, 2).expect(422);
      await as('owner').patch(`/api/v1/contacts/${seller.id}/identity-documents/${randomUUID()}`, { expiresOn: null }, 1).expect(404);
    });

    it('archives a document with a reason, keeping it as evidence', async () => {
      const seller = await contact('owner');
      const created = await document('owner', seller.id);
      const path = `/api/v1/contacts/${seller.id}/identity-documents/${created.id}`;
      const open = await check('owner', seller.id, { identityDocumentId: created.id });
      await as('owner').action(`${path}/archive`, 1, { reason: 'Replaced' }).expect(422);
      await as('owner').action(`/api/v1/contacts/${seller.id}/kyc-checks/${open.id}/reject`, open.version, { reason: 'Customer withdrew' }).expect(200);
      await as('owner').action(`${path}/archive`, 9, { reason: 'Replaced' }).expect(412);
      const archived = await as('owner').action(`${path}/archive`, 1, { reason: 'Replaced by a renewed card' }).expect(200);
      expect(archived.body).toMatchObject({ archivedReason: 'Replaced by a renewed card', canEdit: false, version: 2 });
      await as('owner').action(`${path}/archive`, 2, { reason: 'Again' }).expect(422);
      await as('owner').patch(path, { expiresOn: null }, 2).expect(422);
      expect((await as('owner').get(`/api/v1/contacts/${seller.id}/identity-documents`).expect(200)).body).toHaveLength(0);
      expect((await as('owner').get(`/api/v1/contacts/${seller.id}/identity-documents?includeArchived=true`).expect(200)).body).toHaveLength(1);
      await as('owner').get(`/api/v1/contacts/${seller.id}/identity-documents?includeArchived=yes`).expect(422);
      await as('owner').post(`/api/v1/contacts/${seller.id}/kyc-checks`, { checkType: 'identity', identityDocumentId: created.id }).expect(422);
      // An archived number no longer counts as a duplicate.
      const fresh = await contact('owner');
      const reused = await as('owner').post(`/api/v1/contacts/${fresh.id}/identity-documents`, {
        documentTypeCode: 'ghana_card',
        issuingCountryCode: 'GH',
        documentNumber: (await as('owner').post(`${path}/reveal`, { reason: 'Copying the archived number' }).expect(200)).body.value,
      });
      expect(reused.status).toBe(201);
    });
  });

  describe('KYC checks and sign-off (SE-1)', () => {
    it('records, reviews and signs off an identity check, verifying its document', async () => {
      const seller = await contact('agent', { relationships: ['seller'] });
      const card = await document('agent', seller.id);
      const recorded = await check('agent', seller.id, { identityDocumentId: card.id, provider: 'In branch', notes: 'Original card seen' });
      expect(recorded).toMatchObject({
        checkType: 'identity',
        status: 'pending',
        identityDocument: { id: card.id, documentTypeCode: 'ghana_card', numberLast4: card.numberLast4 },
        recordedBy: { id: members['agent'] },
        reviewedBy: null,
        canEdit: true,
        canDecide: false,
      });
      const path = `/api/v1/contacts/${seller.id}/kyc-checks/${recorded.id}`;
      const inReview = await as('agent').patch(path, { status: 'in_review', riskRating: 'low' }, 1).expect(200);
      expect(inReview.body).toMatchObject({ status: 'in_review', riskRating: 'low', version: 2 });
      expect((await as('agent').patch(path, { status: 'in_review' }, 2).expect(200)).body.version).toBe(2);
      // Agents cannot sign off (no kyc.approve).
      await as('agent').action(`${path}/approve`, 2, { riskRating: 'low' }).expect(403);
      await as('sales').action(`${path}/approve`, 1, { riskRating: 'low' }).expect(412);
      await as('sales').action(`${path}/approve`, 2, { riskRating: 'low', expiresOn: '2020-01-01' }).expect(422);
      const verified = await as('sales').action(`${path}/approve`, 2, { riskRating: 'medium', expiresOn: '2029-12-31', reason: 'Card and face match' }).expect(200);
      expect(verified.body).toMatchObject({
        status: 'verified',
        riskRating: 'medium',
        reviewedBy: { id: members['sales'] },
        decisionReason: 'Card and face match',
        canEdit: false,
        canDecide: false,
      });
      const docs = await as('owner').get(`/api/v1/contacts/${seller.id}/identity-documents`).expect(200);
      expect(docs.body[0]).toMatchObject({ verified: { by: { id: members['sales'] } }, canEdit: false });
      // Signed-off checks and verified documents are evidence.
      await as('owner').patch(path, { notes: 'Changed' }, 3).expect(422);
      await as('owner').action(`${path}/reject`, 3, { reason: 'Second thoughts' }).expect(422);
      await as('owner').patch(`/api/v1/contacts/${seller.id}/identity-documents/${card.id}`, { expiresOn: '2035-01-01' }, 2).expect(422);
      const [audit] = await audits(seller.id, 'kyc.check_verified');
      expect(audit!.metadata).toMatchObject({ kycCheckId: recorded.id, riskRating: 'medium', reviewerRecordedCheck: false });
      const events = await fx.db.selectFrom('outboxEvents').select('eventType').where('aggregateId', '=', seller.id).where('eventType', '=', 'kyc.check_decided').execute();
      expect(events).toHaveLength(1);
    });

    it('records the failure reason when a check fails', async () => {
      const seller = await contact('owner');
      const recorded = await check('owner', seller.id, { checkType: 'source_of_funds', status: 'in_review' });
      const path = `/api/v1/contacts/${seller.id}/kyc-checks/${recorded.id}/reject`;
      await as('owner').action(path, 1, {}).expect(422);
      const failed = await as('owner').action(path, 1, { reason: 'Bank statement does not cover the deposit', riskRating: 'high' }).expect(200);
      expect(failed.body).toMatchObject({ status: 'failed', riskRating: 'high', decisionReason: 'Bank statement does not cover the deposit' });
      const [audit] = await audits(seller.id, 'kyc.check_failed');
      expect(audit!.metadata).toMatchObject({ checkType: 'source_of_funds', reviewerRecordedCheck: true });
    });

    it('refuses to sign off an identity check whose document has expired', async () => {
      const seller = await contact('owner');
      const card = await document('owner', seller.id, { issuedOn: '2010-01-01', expiresOn: '2020-01-01' });
      expect(card['expired']).toBe(true);
      const recorded = await check('owner', seller.id, { identityDocumentId: card.id });
      const res = await as('owner').action(`/api/v1/contacts/${seller.id}/kyc-checks/${recorded.id}/approve`, 1, { riskRating: 'low' }).expect(422);
      expect(res.body.detail).toContain('expired');
    });

    it('reads a verified check past its renewal date as expired, here and in the Sellers view', async () => {
      const seller = await contact('owner', { relationships: ['seller'] });
      // Signed-off checks cannot be edited, so the old check is recorded as it stood.
      await fx.db
        .insertInto('kycChecks')
        .values({
          companyId: company.companyId,
          contactId: seller.id,
          checkType: 'identity',
          status: 'verified',
          riskRating: 'low',
          reviewedBy: members['owner']!,
          reviewedAt: new Date('2023-01-01T10:00:00Z'),
          expiresOn: '2024-01-01',
          recordedBy: members['owner']!,
        })
        .execute();
      const list = await as('owner').get(`/api/v1/contacts/${seller.id}/kyc-checks`).expect(200);
      expect(list.body[0].status).toBe('expired');
      const sellers = await as('owner').get(`/api/v1/contacts?filter[relationship]=seller&limit=100`).expect(200);
      expect(sellers.body.data.find((row: { id: string }) => row.id === seller.id).identityCheck).toMatchObject({ status: 'expired' });
    });

    it('validates check fields', async () => {
      const seller = await contact('owner');
      const other = await contact('owner');
      const otherCard = await document('owner', other.id);
      await as('owner').post(`/api/v1/contacts/${seller.id}/kyc-checks`, { checkType: 'credit_score' }).expect(422);
      const wrongDoc = await as('owner').post(`/api/v1/contacts/${seller.id}/kyc-checks`, { checkType: 'identity', identityDocumentId: otherCard.id }).expect(422);
      expect(wrongDoc.body.errors[0].field).toBe('identityDocumentId');
      await as('owner').post(`/api/v1/contacts/${seller.id}/kyc-checks`, { checkType: 'identity', expiresOn: '2027-02-30' }).expect(422);
      await as('owner').post(`/api/v1/contacts/${seller.id}/kyc-checks`, { checkType: 'identity', status: 'verified' }).expect(422);
      const recorded = await check('owner', seller.id);
      const path = `/api/v1/contacts/${seller.id}/kyc-checks/${recorded.id}`;
      await as('owner').patch(path, { identityDocumentId: otherCard.id }, 1).expect(422);
      await as('owner').patch(path, { expiresOn: '2027-13-01' }, 1).expect(422);
      const cleared = await as('owner').patch(path, { notes: '', provider: 'Smile ID', providerReference: 'SID-123' }, 1).expect(200);
      expect(cleared.body).toMatchObject({ notes: null, provider: 'Smile ID', providerReference: 'SID-123' });
      await as('owner').patch(`/api/v1/contacts/${seller.id}/kyc-checks/${randomUUID()}`, { notes: 'x' }, 1).expect(404);
    });
  });

  describe('access and tenant isolation', () => {
    it('applies each KYC permission in its own scope', async () => {
      const hq = await contact('owner', { officeId: company.officeId });
      await document('owner', hq.id);
      const recorded = await check('owner', hq.id);
      // Office scope: the Kumasi manager does not see Osu contacts.
      await as('salesKsi').get(`/api/v1/contacts/${hq.id}/kyc-checks`).expect(404);
      // The accountant views everything but records nothing.
      expect((await as('accountant').get(`/api/v1/contacts/${hq.id}/kyc-checks`).expect(200)).body[0]).toMatchObject({ canEdit: false, canDecide: false });
      await as('accountant').post(`/api/v1/contacts/${hq.id}/kyc-checks`, { checkType: 'identity' }).expect(403);
      // Maintenance staff have no KYC access; other companies see nothing.
      await as('technician').get(`/api/v1/contacts/${hq.id}/identity-documents`).expect(403);
      await as('otherOwner').get(`/api/v1/contacts/${hq.id}/kyc-checks`).expect(404);
      await as('otherOwner').post(`/api/v1/contacts/${hq.id}/identity-documents`, { documentTypeCode: 'ghana_card', issuingCountryCode: 'GH', documentNumber: nextCard() }).expect(404);
      await as('otherOwner').action(`/api/v1/contacts/${hq.id}/kyc-checks/${recorded.id}/approve`, 1, { riskRating: 'low' }).expect(404);
      // Office administrators may sign off (kyc.approve, all).
      await as('admin').action(`/api/v1/contacts/${hq.id}/kyc-checks/${recorded.id}/approve`, 1, { riskRating: 'low' }).expect(200);
    });

    it('limits agents to contacts they own; decision D1 does not extend to KYC', async () => {
      const others = await contact('owner');
      await fx.db
        .insertInto('leads')
        .values({ companyId: company.companyId, reference: `LEA-K-${randomUUID().slice(0, 8)}`, contactId: others.id, leadType: 'sell', sourceCode: 'website', assignedTo: members['agent2']! })
        .execute();
      await as('agent2').get(`/api/v1/contacts/${others.id}`).expect(200);
      await as('agent2').get(`/api/v1/contacts/${others.id}/identity-documents`).expect(403);
      await as('agent2').post(`/api/v1/contacts/${others.id}/kyc-checks`, { checkType: 'identity' }).expect(403);
      const list = await as('agent2').get('/api/v1/contacts?limit=100').expect(200);
      expect(list.body.data.find((row: { id: string }) => row.id === others.id).identityCheck).toBeNull();
      const own = await contact('agent2');
      const ownRow = (await as('agent2').get('/api/v1/contacts?limit=100').expect(200)).body.data.find((row: { id: string }) => row.id === own.id);
      expect(ownRow.identityCheck).toEqual({ status: 'none', reviewedAt: null });
    });

    it('refuses KYC changes on archived contacts', async () => {
      const seller = await contact('owner');
      await as('owner').action(`/api/v1/contacts/${seller.id}/archive`, seller.version, { reason: 'Sale abandoned' }).expect(200);
      await as('owner').post(`/api/v1/contacts/${seller.id}/kyc-checks`, { checkType: 'identity' }).expect(422);
      await as('owner').get(`/api/v1/contacts/${seller.id}/kyc-checks`).expect(200);
    });
  });
});
