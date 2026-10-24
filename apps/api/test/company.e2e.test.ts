import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

describe('company and offices', () => {
  let t: TestApp;
  let fx: Fixtures;
  let companyA: Awaited<ReturnType<Fixtures['company']>>;
  let companyB: Awaited<ReturnType<Fixtures['company']>>;
  let branchId: string;
  let archivedId: string;
  let token: string;

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    companyA = await fx.company();
    companyB = await fx.company({ countryCode: 'GB', jurisdictionCode: 'GB-ENG' });
    branchId = (await fx.office(companyA.companyId, 'KSI')).id;
    archivedId = (await fx.office(companyA.companyId, 'OLD')).id;
    await fx.db.updateTable('offices').set({ archivedAt: new Date() }).where('id', '=', archivedId).execute();

    const agent = await fx.member(companyA.companyId, { roleKey: 'agent', officeIds: [companyA.officeId] });
    await fx.linkIdentity(agent.userId, `company-test-agent`);
    token = await t.idp.token({ sub: 'company-test-agent' });
  });

  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  const get = (path: string) =>
    t.http.get(path).auth(token, { type: 'bearer' }).set('X-Company-Id', companyA.companyId);

  it('returns the current company profile', async () => {
    const res = await get('/api/v1/company').expect(200);
    expect(res.body).toEqual({
      id: companyA.companyId,
      legalName: expect.stringContaining('Test Agency'),
      tradingName: null,
      status: 'active',
      businessTypes: ['agency'],
      headquartersCountryCode: 'GH',
      baseCurrencyCode: 'GHS',
      defaultLocaleCode: 'en-GH',
      defaultTimezone: 'Africa/Accra',
      fiscalYearStartMonth: 1,
    });
  });

  it('lists only the company’s active offices, head office first', async () => {
    const res = await get('/api/v1/offices').expect(200);
    expect(res.body.data.map((o: { code: string }) => o.code)).toEqual(['HQ', 'KSI']);
    expect(res.body.data[0]).toMatchObject({
      isHeadOffice: true,
      countryCode: 'GH',
      jurisdictionCode: 'GH',
      currencyCode: 'GHS',
      timezone: 'Africa/Accra',
      workingDays: [1, 2, 3, 4, 5],
      archivedAt: null,
    });
  });

  it('filters archived offices', async () => {
    const archived = await get('/api/v1/offices?filter[archived]=true').expect(200);
    expect(archived.body.data.map((o: { id: string }) => o.id)).toEqual([archivedId]);
    expect(archived.body.data[0].archivedAt).toMatch(/Z$/);
    const all = await get('/api/v1/offices?filter[archived]=all').expect(200);
    expect(all.body.data).toHaveLength(3);
    const active = await get('/api/v1/offices?filter[archived]=false').expect(200);
    expect(active.body.data).toHaveLength(2);
  });

  it('rejects unknown or invalid filters', async () => {
    const unknown = await get('/api/v1/offices?filter[colour]=blue').expect(422);
    expect(unknown.body.errors).toEqual([expect.objectContaining({ field: 'filter[colour]', code: 'unknown-filter' })]);
    const invalid = await get('/api/v1/offices?filter[archived]=maybe').expect(422);
    expect(invalid.body.errors).toEqual([expect.objectContaining({ field: 'filter[archived]', code: 'invalid' })]);
    await get('/api/v1/offices?filter=plain').expect(422);
  });

  it('returns one office by id', async () => {
    const res = await get(`/api/v1/offices/${branchId}`).expect(200);
    expect(res.body).toMatchObject({ id: branchId, code: 'KSI', isHeadOffice: false });
  });

  it("returns 404 for another company's office and for malformed ids", async () => {
    const res = await get(`/api/v1/offices/${companyB.officeId}`).expect(404);
    expect(res.body.detail).toBe("This record doesn't exist or you don't have access to it.");
    await get('/api/v1/offices/not-a-uuid').expect(404);
  });

  it('derives working days from the country weekend (Qatar: Friday and Saturday off)', async () => {
    const qatar = await fx.company({ countryCode: 'QA' });
    const office = await fx.db.selectFrom('offices').select(['workingDays', 'timezone', 'currencyCode']).where('id', '=', qatar.officeId).executeTakeFirstOrThrow();
    expect(office).toEqual({ workingDays: [1, 2, 3, 4, 7], timezone: 'Asia/Qatar', currencyCode: 'QAR' });
  });
});
