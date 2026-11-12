import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { Logger } from 'nestjs-pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemContext } from '../src/common/request-context.js';
import { SensitiveDataService } from '../src/crypto/sensitive-data.service.js';
import { TenantDb } from '../src/database/database.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

const DATE_OF_BIRTH = '1979-11-04';
const TAX_NUMBER = 'P0012345678';
const PASSPORT = 'G-4821-7733';
const GHANA_CARD = 'GHA-715550123-4';

/**
 * ADR-007 §9 and threat T-8: protected values never reach the logs. Runs in its
 * own file because the logger is process-wide: the first application created
 * in a test file decides where every later log line goes.
 */
describe('protected values and the logs (ADR-007 §9, T-8)', () => {
  const output: string[] = [];
  let t: TestApp;
  let fx: Fixtures;
  let company: Awaited<ReturnType<Fixtures['company']>>;
  let token: string;

  const post = (path: string, body: object) => t.http.post(path).auth(token, { type: 'bearer' }).set('X-Company-Id', company.companyId).send(body);
  const fieldPath = (contactId: string, field: string) => `/api/v1/contacts/${contactId}/sensitive/${field}/reveal`;

  async function seed(values: { dateOfBirth?: string; taxNumber?: string; passport?: string }): Promise<{ id: string; documentId: string | null }> {
    const tenantDb = t.app.get(TenantDb);
    const sensitive = t.app.get(SensitiveDataService);
    const id = randomUUID();
    const documentId = values.passport ? randomUUID() : null;
    const ctx = systemContext(company.companyId, 'test-seed');
    await tenantDb.run(ctx, async (tx) => {
      const dob = values.dateOfBirth ? await sensitive.seal(tx, ctx, { table: 'contacts', column: 'date_of_birth_encrypted', rowId: id }, values.dateOfBirth) : null;
      const tax = values.taxNumber
        ? await sensitive.protectIdentifier(tx, ctx, { table: 'contacts', column: 'tax_number_encrypted', rowId: id }, 'tax_number', values.taxNumber)
        : null;
      await tx
        .insertInto('contacts')
        .values({
          id,
          companyId: company.companyId,
          contactType: 'person',
          displayName: 'Log test contact',
          dateOfBirthEncrypted: dob,
          taxNumberEncrypted: tax?.encrypted ?? null,
          taxNumberHash: tax?.hash ?? null,
          taxNumberLast4: tax?.last4 ?? null,
        })
        .execute();
      if (documentId !== null && values.passport) {
        const number = await sensitive.protectIdentifier(tx, ctx, { table: 'identity_documents', column: 'number_encrypted', rowId: documentId }, 'identity_number', values.passport);
        await tx
          .insertInto('identityDocuments')
          .values({
            id: documentId,
            companyId: company.companyId,
            contactId: id,
            documentTypeCode: 'passport',
            issuingCountryCode: 'GH',
            numberEncrypted: number.encrypted,
            numberHash: number.hash,
            numberLast4: number.last4,
          })
          .execute();
      }
    });
    return { id, documentId };
  }

  beforeAll(async () => {
    t = await createTestApp({ LOG_LEVEL: 'trace' }, { logStream: { write: (line: string) => void output.push(line) } });
    fx = new Fixtures();
    company = await fx.company();
    await fx.linkIdentity(company.ownerUserId, `fe-log-owner-${company.companyId}`);
    token = await t.idp.token({ sub: `fe-log-owner-${company.companyId}`, amr: ['pwd', 'mfa'], authTime: Math.floor(Date.now() / 1000) });
  });

  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  it('logs requests on success and failure paths without any protected value', async () => {
    const { id, documentId } = await seed({ dateOfBirth: DATE_OF_BIRTH, taxNumber: TAX_NUMBER, passport: PASSPORT });
    expect((await post(fieldPath(id, 'dateOfBirth'), { reason: 'Log leak test reveal' })).status).toBe(200);
    expect((await post(fieldPath(id, 'taxNumber'), { reason: 'Log leak test reveal' })).status).toBe(200);
    expect((await post(`/api/v1/contacts/${id}/identity-documents/${documentId}/reveal`, { reason: 'Log leak test reveal' })).status).toBe(200);
    // Failure paths: a rejected body that carries a value, and a damaged ciphertext.
    expect((await post(fieldPath(id, 'dateOfBirth'), { reason: 'short', dateOfBirth: DATE_OF_BIRTH, taxNumber: TAX_NUMBER })).status).toBe(422);
    const damaged = await seed({ taxNumber: TAX_NUMBER });
    await sql`update contacts set tax_number_encrypted = (select tax_number_encrypted from contacts where id = ${id}) where id = ${damaged.id}`.execute(fx.db);
    expect((await post(fieldPath(damaged.id, 'taxNumber'), { reason: 'Log leak test reveal' })).status).toBe(422);
    // Identity documents (C2): recorded, refused as a duplicate, and rejected by validation.
    const card = { documentTypeCode: 'ghana_card', issuingCountryCode: 'GH', documentNumber: GHANA_CARD };
    expect((await post(`/api/v1/contacts/${id}/identity-documents`, card)).status).toBe(201);
    expect((await post(`/api/v1/contacts/${damaged.id}/identity-documents`, card)).status).toBe(409);
    expect((await post(`/api/v1/contacts/${id}/identity-documents`, { ...card, issuingCountryCode: 'QA' })).status).toBe(422);

    const text = output.join('');
    // The capture works: request lines for the reveals are present.
    expect(text).toContain(`/contacts/${id}/sensitive/dateOfBirth/reveal`);
    expect(text).toContain('"statusCode":422');
    for (const value of [DATE_OF_BIRTH, TAX_NUMBER, PASSPORT, 'G48217733', GHANA_CARD, '715550123']) {
      expect(text, value).not.toContain(value);
    }
  });

  it('redacts protected field names wherever application code logs them', () => {
    const logger = t.app.get(Logger);
    logger.log({ contact: { dateOfBirth: DATE_OF_BIRTH, taxNumber: TAX_NUMBER }, documentNumber: PASSPORT }, 'redaction probe');
    const line = output.find((entry) => entry.includes('redaction probe'));
    expect(line).toBeDefined();
    expect(line).toContain('[redacted]');
    for (const value of [DATE_OF_BIRTH, TAX_NUMBER, PASSPORT]) expect(line).not.toContain(value);
  });
});
