import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ProblemError } from '../src/common/problem.js';
import type { PermissionScope, TenantContext } from '../src/common/request-context.js';
import { assertPropertyAccess, canUseOffice, type PropertyAccessRow, propertyScopeSql } from '../src/properties/property-access.js';
import { Fixtures } from './support/fixtures.js';

/**
 * Record-level property scopes, checked directly against the database for
 * every scope value (including those no seeded role uses for properties yet).
 */
describe('property access scopes', () => {
  let fx: Fixtures;
  let company: Awaited<ReturnType<Fixtures['company']>>;
  let member: Awaited<ReturnType<Fixtures['member']>>;
  let manager: Awaited<ReturnType<Fixtures['member']>>;
  let kumasiOfficeId: string;
  let accra: PropertyAccessRow;
  let kumasi: PropertyAccessRow;

  const ctx = (grants: Record<string, PermissionScope>, officeIds: string[] = []): TenantContext => ({
    companyId: company.companyId,
    userId: member.userId,
    membershipId: member.membershipId,
    membershipType: 'staff',
    roleKey: 'agent',
    contactId: null,
    officeIds,
    permissions: new Map(Object.entries(grants).map(([key, scope]) => [key, { scope, isSensitive: false }])),
    requestId: 'test',
    ipAddress: null,
    userAgent: null,
  });

  async function insertProperty(officeId: string, createdBy: string | null): Promise<PropertyAccessRow> {
    const type = await fx.db.selectFrom('propertyTypes').select('id').where('code', '=', 'apartment_building').where('companyId', 'is', null).executeTakeFirstOrThrow();
    const address = await fx.db
      .insertInto('addresses')
      .values({ companyId: company.companyId, countryCode: 'GH', addressLine1: '1 Test Road', locality: 'Accra' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return fx.db
      .insertInto('properties')
      .values({
        companyId: company.companyId,
        reference: `PRP-T-${fx.uniqueSuffix()}`,
        propertyTypeId: type.id,
        officeId,
        addressId: address.id,
        jurisdictionCode: 'GH',
        timezone: 'Africa/Accra',
        createdBy,
      })
      .returning(['id', 'officeId', 'createdBy'])
      .executeTakeFirstOrThrow();
  }

  async function visible(context: TenantContext, scope: PermissionScope): Promise<string[]> {
    const rows = await fx.db
      .selectFrom('properties as p')
      .select('p.id')
      .where('p.companyId', '=', company.companyId)
      .where(propertyScopeSql(scope, context, 'p'))
      .execute();
    return rows.map((row) => row.id).sort();
  }

  async function outcome(context: TenantContext, row: PropertyAccessRow, permission = 'property.update'): Promise<number> {
    try {
      await fx.db.transaction().execute((tx) => assertPropertyAccess(tx, context, row, permission));
      return 200;
    } catch (error) {
      expect(error).toBeInstanceOf(ProblemError);
      return (error as ProblemError).status;
    }
  }

  beforeAll(async () => {
    fx = new Fixtures();
    company = await fx.company();
    kumasiOfficeId = (await fx.office(company.companyId, 'KSI')).id;
    member = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] });
    manager = await fx.member(company.companyId, { roleKey: 'property_manager', officeIds: [company.officeId] });
    accra = await insertProperty(company.officeId, member.membershipId);
    kumasi = await insertProperty(kumasiOfficeId, null);
    await fx.assignWorkOrder(company.companyId, kumasi.id, member.membershipId, manager.membershipId);
  });

  afterAll(async () => {
    await fx.close();
  });

  it('builds a SQL filter for each scope', async () => {
    const both = [accra.id, kumasi.id].sort();
    expect(await visible(ctx({}), 'all')).toEqual(both);
    expect(await visible(ctx({}, [company.officeId]), 'office')).toEqual([accra.id]);
    expect(await visible(ctx({}), 'office')).toEqual([]);
    expect(await visible(ctx({}), 'own')).toEqual([accra.id]);
    expect(await visible(ctx({}), 'assigned')).toEqual([kumasi.id]);
    expect(await visible(ctx({}), 'linked')).toEqual([]);
    expect(await visible(ctx({}), 'team')).toEqual([]);
  });

  it('returns 404 outside the view scope and 403 outside the action scope', async () => {
    expect(await outcome(ctx({ 'property.view': 'all', 'property.update': 'all' }), kumasi)).toBe(200);
    expect(await outcome(ctx({ 'property.update': 'all' }), accra)).toBe(404);
    expect(await outcome(ctx({ 'property.view': 'office', 'property.update': 'office' }, [company.officeId]), kumasi)).toBe(404);
    expect(await outcome(ctx({ 'property.view': 'all' }), accra)).toBe(403);
    expect(await outcome(ctx({ 'property.view': 'all', 'property.update': 'own' }), accra)).toBe(200);
    expect(await outcome(ctx({ 'property.view': 'all', 'property.update': 'own' }), kumasi)).toBe(403);
    expect(await outcome(ctx({ 'property.view': 'assigned', 'property.update': 'assigned' }), kumasi)).toBe(200);
    expect(await outcome(ctx({ 'property.view': 'assigned' }), accra)).toBe(404);
    expect(await outcome(ctx({ 'property.view': 'linked' }), accra)).toBe(404);
    expect(await outcome(ctx({ 'property.view': 'all', 'property.update': 'team' }), accra)).toBe(403);
  });

  it('limits which offices a member may place properties in', () => {
    const context = ctx({}, [company.officeId]);
    expect(canUseOffice(context, 'all', kumasiOfficeId)).toBe(true);
    expect(canUseOffice(context, 'office', company.officeId)).toBe(true);
    expect(canUseOffice(context, 'office', kumasiOfficeId)).toBe(false);
    expect(canUseOffice(context, 'own', company.officeId)).toBe(true);
    expect(canUseOffice(context, 'own', kumasiOfficeId)).toBe(false);
    expect(canUseOffice(context, 'assigned', company.officeId)).toBe(false);
  });
});
