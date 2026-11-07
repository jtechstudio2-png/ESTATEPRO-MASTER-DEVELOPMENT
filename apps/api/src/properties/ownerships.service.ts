import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AuditService } from '../audit/audit.service.js';
import { todayIn } from '../common/dates.js';
import { type FieldError, Problems } from '../common/problem.js';
import type { TenantContext } from '../common/request-context.js';
import { contactScopeSql, contactWithinScope, scopeFor } from '../contacts/contact-access.js';
import type { Tx } from '../database/database.module.js';
import { ownersVerified } from './owner-identity.js';
import type { AddOwnershipBody, EndOwnershipBody, OwnershipDto, OwnershipListDto, OwnershipType } from './ownership.dto.js';
import { isCalendarDate } from './properties.service.js';
import { assertPropertyAccess, type PropertyAccessRow } from './property-access.js';

interface PropertyForOwnership extends PropertyAccessRow {
  archivedAt: Date | null;
  timezone: string;
}

/**
 * Ownership records of a property (Phase 3 IA "Ownership records", property
 * "Ownership" tab; LL-1 "add ownership"). Records are history: they are added
 * and ended, never rewritten or deleted (migration 0028 enforces it). Viewing
 * needs `property.view`; adding and ending need `property.update` on the
 * property and, for the owner, `contact.view` on the contact.
 */
@Injectable()
export class OwnershipsService {
  constructor(private readonly audit: AuditService) {}

  async list(tx: Tx, ctx: TenantContext, propertyId: string): Promise<OwnershipListDto> {
    const property = await this.loadProperty(tx, propertyId);
    await assertPropertyAccess(tx, ctx, property, 'property.view');
    const canManage = property.archivedAt === null && (await this.allowed(tx, ctx, property, 'property.update'));
    const today = todayIn(property.timezone);

    const rows = await tx
      .selectFrom('propertyOwnerships as o')
      .innerJoin('contacts as c', 'c.id', 'o.ownerContactId')
      .leftJoin('units as u', 'u.id', 'o.unitId')
      .leftJoin('companyMemberships as cm', 'cm.id', 'o.createdBy')
      .leftJoin('users as cu', 'cu.id', 'cm.userId')
      .leftJoin('companyMemberships as em', 'em.id', 'o.endedBy')
      .leftJoin('users as eu', 'eu.id', 'em.userId')
      .select([
        'o.id', 'o.unitId', 'u.unitLabel', 'o.ownerContactId', 'o.sharePercent', 'o.ownershipType', 'o.effectiveFrom', 'o.effectiveTo',
        'o.createdBy', 'cu.displayName as createdByName', 'o.createdAt', 'o.endedBy', 'eu.displayName as endedByName', 'o.endedAt', 'o.endReason',
        'c.displayName as ownerName', 'c.contactType', 'c.officeId as ownerOfficeId', 'c.ownerMembershipId',
      ])
      .where('o.propertyId', '=', propertyId)
      .execute();

    const contactScope = scopeFor(ctx, 'contact.view');
    const visibleContacts = new Set<string>();
    const ownerIds = [...new Set(rows.map((row) => row.ownerContactId))];
    if (contactScope !== null && ownerIds.length > 0) {
      const visible = await tx
        .selectFrom('contacts as c')
        .select('c.id')
        .where('c.id', 'in', ownerIds)
        .where(contactScopeSql(contactScope, ctx, 'c', 'read'))
        .execute();
      for (const row of visible) visibleContacts.add(row.id);
    }
    const kycScope = scopeFor(ctx, 'kyc.view');
    const verified = await ownersVerified(
      tx,
      rows
        .filter((row) => visibleContacts.has(row.ownerContactId) && kycScope !== null && contactWithinScope(kycScope, ctx, { officeId: row.ownerOfficeId, ownerMembershipId: row.ownerMembershipId }))
        .map((row) => row.ownerContactId),
    );

    const data: OwnershipDto[] = rows.map((row) => ({
      id: row.id,
      unit: row.unitId !== null && row.unitLabel !== null ? { id: row.unitId, unitLabel: row.unitLabel } : null,
      owner: visibleContacts.has(row.ownerContactId)
        ? { id: row.ownerContactId, name: row.ownerName, contactType: row.contactType, identityVerified: verified.get(row.ownerContactId) ?? null }
        : null,
      sharePercent: Number(row.sharePercent),
      ownershipType: row.ownershipType as OwnershipType,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      current: isCurrent(row, today),
      createdBy: row.createdBy !== null && row.createdByName !== null ? { id: row.createdBy, name: row.createdByName } : null,
      createdAt: row.createdAt.toISOString(),
      endedBy: row.endedBy !== null && row.endedByName !== null ? { id: row.endedBy, name: row.endedByName } : null,
      endedAt: row.endedAt?.toISOString() ?? null,
      endReason: row.endReason,
    }));
    data.sort(
      (a, b) =>
        Number(b.current) - Number(a.current) ||
        (b.effectiveTo ?? '9999-12-31').localeCompare(a.effectiveTo ?? '9999-12-31') ||
        b.effectiveFrom.localeCompare(a.effectiveFrom) ||
        (a.id < b.id ? -1 : 1),
    );
    return { data, canManage };
  }

  async add(tx: Tx, ctx: TenantContext, propertyId: string, body: AddOwnershipBody): Promise<OwnershipDto> {
    // Lock the property so two members cannot both fill the last share.
    const property = await this.loadProperty(tx, propertyId, true);
    await assertPropertyAccess(tx, ctx, property, 'property.update');
    if (property.archivedAt !== null) throw Problems.businessRule('This property is archived. Restore it before recording ownership.');

    const today = todayIn(property.timezone);
    const unitId = body.unitId ?? null;
    const ownershipType: OwnershipType = body.ownershipType ?? 'legal_owner';
    const sharePercent = body.sharePercent ?? 100;
    const errors: FieldError[] = [];

    if (!isCalendarDate(body.effectiveFrom)) {
      errors.push({ field: 'effectiveFrom', code: 'invalid', message: 'Use a real date such as 2026-11-01.' });
    } else if (body.effectiveFrom > today) {
      errors.push({ field: 'effectiveFrom', code: 'future', message: 'Record an ownership once it has started.' });
    }
    if (unitId !== null) {
      const unit = await tx.selectFrom('units').select(['propertyId', 'archivedAt']).where('id', '=', unitId).executeTakeFirst();
      if (!unit || unit.propertyId !== propertyId) errors.push({ field: 'unitId', code: 'not-found', message: 'Choose a unit of this property.' });
      else if (unit.archivedAt !== null) errors.push({ field: 'unitId', code: 'archived', message: 'This unit is archived.' });
    }

    const contactScope = scopeFor(ctx, 'contact.view');
    const owner = contactScope === null
      ? undefined
      : await tx
          .selectFrom('contacts as c')
          .select(['c.id', 'c.archivedAt', 'c.isAnonymised', 'c.mergedIntoContactId'])
          .where('c.id', '=', body.ownerContactId)
          .where(contactScopeSql(contactScope, ctx, 'c', 'read'))
          .executeTakeFirst();
    if (!owner) {
      errors.push({ field: 'ownerContactId', code: 'not-found', message: 'Choose a contact you can see.' });
    } else if (owner.mergedIntoContactId !== null) {
      errors.push({ field: 'ownerContactId', code: 'merged', message: 'This contact was merged into another contact. Choose that contact.' });
    } else if (owner.isAnonymised) {
      errors.push({ field: 'ownerContactId', code: 'erased', message: 'This contact was erased and cannot be recorded as an owner.' });
    } else if (owner.archivedAt !== null) {
      errors.push({ field: 'ownerContactId', code: 'archived', message: 'This contact is archived. Restore it first.' });
    }
    if (errors.length > 0) throw Problems.validation(errors);

    // Records for the same unit (or the whole property) that are open on or after the new start date.
    const open = await tx
      .selectFrom('propertyOwnerships')
      .select(['id', 'ownerContactId', 'sharePercent'])
      .where('propertyId', '=', propertyId)
      .where(unitId === null ? sql<boolean>`unit_id is null` : sql<boolean>`unit_id = ${unitId}::uuid`)
      .where('ownershipType', '=', ownershipType)
      .where((eb) => eb.or([eb('effectiveTo', 'is', null), eb('effectiveTo', '>=', body.effectiveFrom)]))
      .execute();
    const same = open.find((row) => row.ownerContactId === body.ownerContactId);
    if (same) {
      throw Problems.conflict('This contact already has an open ownership record of this type here. End it first to record a change of share.', {
        type: 'property-ownership',
        id: same.id,
      });
    }
    const held = open.reduce((sum, row) => sum + Number(row.sharePercent), 0);
    if (held + sharePercent > 100.00005) {
      const left = Math.max(0, Math.round((100 - held) * 10_000) / 10_000);
      throw Problems.validation([
        { field: 'sharePercent', code: 'over-100', message: `Shares would add up to more than 100 %. At most ${left} % is not yet recorded; end the records that changed first.` },
      ]);
    }

    const inserted = await tx
      .insertInto('propertyOwnerships')
      .values({
        companyId: ctx.companyId,
        propertyId,
        unitId,
        ownerContactId: body.ownerContactId,
        sharePercent: String(sharePercent),
        ownershipType,
        effectiveFrom: body.effectiveFrom,
        createdBy: ctx.membershipId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.audit.record(tx, ctx, {
      action: 'property.ownership_added',
      entityType: 'property',
      entityId: propertyId,
      metadata: { ownershipId: inserted.id, unitId, ownerContactId: body.ownerContactId, sharePercent, ownershipType, effectiveFrom: body.effectiveFrom },
    });
    await this.audit.emit(tx, ctx, {
      eventType: 'property.ownership_changed',
      aggregateType: 'property',
      aggregateId: propertyId,
      payload: { propertyId, ownershipId: inserted.id, change: 'added' },
    });
    return this.one(tx, ctx, propertyId, inserted.id);
  }

  async end(tx: Tx, ctx: TenantContext, ownershipId: string, body: EndOwnershipBody): Promise<OwnershipDto> {
    const record = await tx
      .selectFrom('propertyOwnerships')
      .select(['id', 'propertyId', 'effectiveFrom', 'effectiveTo'])
      .where('id', '=', ownershipId)
      .forUpdate()
      .executeTakeFirst();
    if (!record) throw Problems.notFound();
    const property = await this.loadProperty(tx, record.propertyId);
    await assertPropertyAccess(tx, ctx, property, 'property.update');
    if (record.effectiveTo !== null) throw Problems.conflict('This ownership record has already ended.', { type: 'property-ownership', id: record.id });

    const today = todayIn(property.timezone);
    if (!isCalendarDate(body.effectiveTo)) {
      throw Problems.validation([{ field: 'effectiveTo', code: 'invalid', message: 'Use a real date such as 2026-11-01.' }]);
    }
    if (body.effectiveTo <= record.effectiveFrom) {
      throw Problems.validation([{ field: 'effectiveTo', code: 'before-start', message: 'The last day of ownership must be after the first day.' }]);
    }
    if (body.effectiveTo > today) {
      throw Problems.validation([{ field: 'effectiveTo', code: 'future', message: 'End an ownership once it has ended.' }]);
    }

    await tx
      .updateTable('propertyOwnerships')
      .set({ effectiveTo: body.effectiveTo, endedBy: ctx.membershipId, endedAt: sql`now()`, endReason: body.reason })
      .where('id', '=', ownershipId)
      .execute();
    await this.audit.record(tx, ctx, {
      action: 'property.ownership_ended',
      entityType: 'property',
      entityId: record.propertyId,
      changes: { effectiveTo: { old: null, new: body.effectiveTo } },
      metadata: { ownershipId, reason: body.reason },
    });
    await this.audit.emit(tx, ctx, {
      eventType: 'property.ownership_changed',
      aggregateType: 'property',
      aggregateId: record.propertyId,
      payload: { propertyId: record.propertyId, ownershipId, change: 'ended' },
    });
    return this.one(tx, ctx, record.propertyId, ownershipId);
  }

  private async one(tx: Tx, ctx: TenantContext, propertyId: string, ownershipId: string): Promise<OwnershipDto> {
    const { data } = await this.list(tx, ctx, propertyId);
    const found = data.find((row) => row.id === ownershipId);
    if (!found) throw Problems.notFound();
    return found;
  }

  private async allowed(tx: Tx, ctx: TenantContext, property: PropertyForOwnership, permission: string): Promise<boolean> {
    try {
      await assertPropertyAccess(tx, ctx, property, permission);
      return true;
    } catch {
      return false;
    }
  }

  private async loadProperty(tx: Tx, propertyId: string, lock = false): Promise<PropertyForOwnership> {
    let query = tx.selectFrom('properties as p').select(['p.id', 'p.officeId', 'p.createdBy', 'p.archivedAt', 'p.timezone']).where('p.id', '=', propertyId);
    if (lock) query = query.forUpdate('p');
    const property = await query.executeTakeFirst();
    if (!property) throw Problems.notFound();
    return property;
  }
}

function isCurrent(row: { effectiveFrom: string; effectiveTo: string | null }, today: string): boolean {
  return row.effectiveFrom <= today && (row.effectiveTo === null || row.effectiveTo >= today);
}
