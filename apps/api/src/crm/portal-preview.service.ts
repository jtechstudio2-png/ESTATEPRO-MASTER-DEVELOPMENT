import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AuditService } from '../audit/audit.service.js';
import { Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { scopeFor } from '../contacts/contact-access.js';
import { ContactsService } from '../contacts/contacts.service.js';
import type { Tx } from '../database/database.module.js';
import { propertyScopeSql } from '../properties/property-access.js';
import type { PortalPreviewDto } from './portal-preview.dto.js';

/** What a landlord portal never shows, whatever they own (wireframe LL-1). */
/** What the landlord portal never shows, as codes (translated by the web app) and in English. */
const NOT_VISIBLE: ReadonlyArray<readonly [code: string, text: string]> = [
  ['other_owners', 'Properties, units and listings of other owners'],
  ['tenant_buyer_contacts', 'Tenants’ and buyers’ contact details'],
  ['staff_records', 'Staff notes, activities and follow-ups'],
  ['protected_details', 'Protected details (identity, tax and bank numbers)'],
];

/**
 * Landlord visibility preview (CA-15; wireframe LL-1; issue #12, landlord
 * part). Shows staff what a landlord contact would see in the landlord portal,
 * using the same database resolver the portal will use
 * (app.landlord_unit_access), so staff and portal can never disagree. It is
 * read-only, limited to properties the staff member may view, and audited.
 */
@Injectable()
export class PortalPreviewService {
  constructor(
    private readonly contacts: ContactsService,
    private readonly audit: AuditService,
  ) {}

  async landlord(tx: Tx, ctx: TenantContext, contactId: string): Promise<PortalPreviewDto> {
    const contact = await this.contacts.loadRow(tx, contactId);
    if (!contact || !(await this.contacts.canRead(tx, ctx, contact))) throw Problems.notFound();
    const propertyScope = scopeFor(ctx, 'property.view');
    if (propertyScope === null) throw Problems.forbidden('The preview needs permission to view properties.');

    const { rows: access } = await sql<{
      propertyId: string;
      reference: string;
      name: string | null;
      timezone: string;
      unitId: string;
      unitReference: string;
      unitLabel: string;
      basis: string;
      basisId: string;
    }>`
      select a.property_id, p.reference, p.name, p.timezone, a.unit_id, u.reference as unit_reference, u.unit_label, a.basis, a.basis_id
        from app.landlord_unit_access(${contactId}::uuid) a
        join properties p on p.id = a.property_id
        join units u on u.id = a.unit_id
       where ${propertyScopeSql(propertyScope, ctx, 'p')}
       order by p.reference, u.reference`.execute(tx);
    const propertyIds = [...new Set(access.map((row) => row.propertyId))];
    const unitIds = [...new Set(access.map((row) => row.unitId))];
    const ownershipIds = [...new Set(access.filter((row) => row.basis === 'ownership').map((row) => row.basisId))];
    const agreementIds = [...new Set(access.filter((row) => row.basis === 'management_agreement').map((row) => row.basisId))];

    const [ownerships, agreements, listings, role] = await Promise.all([
      ownershipIds.length === 0
        ? []
        : tx.selectFrom('propertyOwnerships').select(['id', 'propertyId', 'unitId', 'sharePercent', 'ownershipType', 'effectiveFrom', 'effectiveTo']).where('id', 'in', ownershipIds).execute(),
      agreementIds.length === 0
        ? []
        : tx.selectFrom('managementAgreements').select(['id', 'propertyId', 'unitId', 'serviceLevel', 'startDate', 'endDate']).where('id', 'in', agreementIds).execute(),
      unitIds.length === 0
        ? []
        : tx
            .selectFrom('listings')
            .select(['id', 'reference', 'title', 'status', 'isPublished', 'unitId'])
            .where('unitId', 'in', unitIds)
            .where('archivedAt', 'is', null)
            .orderBy('reference')
            .execute(),
      tx.selectFrom('contactRelationships').select('id').where('contactId', '=', contactId).where('relationshipType', '=', 'landlord').where('status', '=', 'active').executeTakeFirst(),
    ]);

    const properties = propertyIds.map((propertyId) => {
      const rows = access.filter((row) => row.propertyId === propertyId);
      const first = rows[0]!;
      const units = [...new Map(rows.map((row) => [row.unitId, { id: row.unitId, reference: row.unitReference, label: row.unitLabel }])).values()];
      const unitSet = new Set(units.map((unit) => unit.id));
      return {
        id: propertyId,
        reference: first.reference,
        name: first.name,
        timezone: first.timezone,
        basis: [
          ...ownerships
            .filter((o) => o.propertyId === propertyId)
            .map((o) => ({ type: 'ownership', id: o.id, unitId: o.unitId, sharePercent: o.sharePercent, kind: o.ownershipType, from: o.effectiveFrom, until: o.effectiveTo })),
          ...agreements
            .filter((m) => m.propertyId === propertyId)
            .map((m) => ({ type: 'management_agreement', id: m.id, unitId: m.unitId, sharePercent: null, kind: m.serviceLevel, from: m.startDate, until: m.endDate })),
        ],
        units,
        listings: listings.filter((listing) => unitSet.has(listing.unitId)),
      };
    });

    await this.audit.record(tx, ctx, {
      action: 'contact.portal_preview',
      entityType: 'contact',
      entityId: contactId,
      metadata: { portal: 'landlord', properties: properties.length, units: unitIds.length, listings: listings.length },
    });
    return {
      contact: { id: contact.id, name: contact.displayName },
      portal: 'landlord',
      hasLandlordRole: role !== undefined,
      generatedAt: new Date().toISOString(),
      properties,
      notVisible: NOT_VISIBLE.map(([, text]) => text),
      notVisibleCodes: NOT_VISIBLE.map(([code]) => code),
      limitedToYourAccess: propertyScope !== 'all',
    };
  }
}
