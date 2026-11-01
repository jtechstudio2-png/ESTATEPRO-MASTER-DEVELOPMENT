import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import type { TenantContext } from '../common/request-context.js';
import type { Tx } from '../database/database.module.js';
import type { ListingSettingsBody, ListingSettingsDto } from './dto.js';

export const PRICE_APPROVAL_KEY = 'listing.price_reduction_approval_percent';
export const SELLER_KYC_KEY = 'listing.require_seller_kyc';
export const MIN_PHOTOS_KEY = 'listing.min_photos_to_publish';
export const FLOOR_PLAN_KEY = 'listing.require_floor_plan_to_publish';
const KEYS = [PRICE_APPROVAL_KEY, SELLER_KYC_KEY, MIN_PHOTOS_KEY, FLOOR_PLAN_KEY];

const FIELDS: Array<{ field: keyof ListingSettingsDto; key: string; off: number | boolean | null }> = [
  { field: 'priceReductionApprovalPercent', key: PRICE_APPROVAL_KEY, off: null },
  { field: 'requireSellerKyc', key: SELLER_KYC_KEY, off: false },
  { field: 'minPhotosToPublish', key: MIN_PHOTOS_KEY, off: null },
  { field: 'requireFloorPlanToPublish', key: FLOOR_PLAN_KEY, off: false },
];

/**
 * Company listing settings (decisions D2, G4 and the M4 publishing checks)
 * and the resolution of jurisdiction rules: office → company → jurisdiction
 * (and its parent) → definition default, so country rules live in data, not code.
 */
@Injectable()
export class ListingSettingsService {
  constructor(private readonly audit: AuditService) {}

  async get(tx: Tx): Promise<ListingSettingsDto> {
    const rows = await tx.selectFrom('companySettings').select(['key', 'value']).where('officeId', 'is', null).where('key', 'in', KEYS).execute();
    const value = (key: string): unknown => rows.find((row) => row.key === key)?.value;
    const integer = (key: string, max: number): number | null => {
      const raw = value(key);
      return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= max ? raw : null;
    };
    return {
      priceReductionApprovalPercent: integer(PRICE_APPROVAL_KEY, 100),
      requireSellerKyc: value(SELLER_KYC_KEY) === true,
      minPhotosToPublish: integer(MIN_PHOTOS_KEY, 60),
      requireFloorPlanToPublish: value(FLOOR_PLAN_KEY) === true,
    };
  }

  async save(tx: Tx, ctx: TenantContext, body: ListingSettingsBody): Promise<ListingSettingsDto> {
    const before = await this.get(tx);
    const next: ListingSettingsDto = {
      priceReductionApprovalPercent: body.priceReductionApprovalPercent,
      requireSellerKyc: body.requireSellerKyc,
      minPhotosToPublish: body.minPhotosToPublish === undefined ? before.minPhotosToPublish : body.minPhotosToPublish,
      requireFloorPlanToPublish: body.requireFloorPlanToPublish ?? before.requireFloorPlanToPublish,
    };
    const changes: Record<string, { old: unknown; new: unknown }> = {};
    for (const { field } of FIELDS) {
      if (before[field] !== next[field]) changes[field] = { old: before[field], new: next[field] };
    }
    if (Object.keys(changes).length === 0) return before;

    await tx.deleteFrom('companySettings').where('officeId', 'is', null).where('key', 'in', KEYS).execute();
    // Settings at their "off" value are not stored.
    const rows = FIELDS.filter(({ field, off }) => next[field] !== off).map(({ field, key }) => ({ key, value: next[field] }));
    if (rows.length > 0) {
      await tx
        .insertInto('companySettings')
        .values(rows.map((row) => ({ companyId: ctx.companyId, officeId: null, key: row.key, value: JSON.stringify(row.value), updatedBy: ctx.userId })))
        .execute();
    }
    await this.audit.record(tx, ctx, { action: 'settings.listings_updated', entityType: 'company', entityId: ctx.companyId, changes });
    return next;
  }

  /**
   * Effective value of a jurisdiction rule for a record placed in `officeId`
   * and `jurisdictionCode` on `onDate`, or null when no value applies.
   */
  async effectiveRule(tx: Tx, key: string, officeId: string, jurisdictionCode: string, onDate: string): Promise<unknown> {
    const overrides = await tx
      .selectFrom('companySettings')
      .select(['officeId', 'value'])
      .where('key', '=', key)
      .where((eb) => eb.or([eb('officeId', 'is', null), eb('officeId', '=', officeId)]))
      .execute();
    const office = overrides.find((row) => row.officeId === officeId);
    if (office) return office.value;
    const company = overrides.find((row) => row.officeId === null);
    if (company) return company.value;

    const jurisdiction = await tx.selectFrom('jurisdictions').select(['code', 'parentCode']).where('code', '=', jurisdictionCode).executeTakeFirst();
    const codes = [jurisdictionCode, ...(jurisdiction?.parentCode ? [jurisdiction.parentCode] : [])];
    for (const code of codes) {
      const row = await tx
        .selectFrom('jurisdictionSettings')
        .select('value')
        .where('jurisdictionCode', '=', code)
        .where('key', '=', key)
        .where('effectiveFrom', '<=', onDate)
        .where((eb) => eb.or([eb('effectiveTo', 'is', null), eb('effectiveTo', '>', onDate)]))
        .orderBy('effectiveFrom', 'desc')
        .executeTakeFirst();
      if (row) return row.value;
    }
    const definition = await tx.selectFrom('jurisdictionSettingDefinitions').select('defaultValue').where('key', '=', key).executeTakeFirst();
    return definition?.defaultValue ?? null;
  }
}
