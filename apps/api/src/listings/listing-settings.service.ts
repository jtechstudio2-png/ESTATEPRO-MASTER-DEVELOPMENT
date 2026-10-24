import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import type { TenantContext } from '../common/request-context.js';
import type { Tx } from '../database/database.module.js';
import type { ListingSettingsBody, ListingSettingsDto } from './dto.js';

export const PRICE_APPROVAL_KEY = 'listing.price_reduction_approval_percent';
export const SELLER_KYC_KEY = 'listing.require_seller_kyc';

/**
 * Company listing settings (decision D2 and gap G4) and the resolution of
 * jurisdiction rules: office → company → jurisdiction (and its parent) →
 * definition default, so country rules live in data, not code.
 */
@Injectable()
export class ListingSettingsService {
  constructor(private readonly audit: AuditService) {}

  async get(tx: Tx): Promise<ListingSettingsDto> {
    const rows = await tx
      .selectFrom('companySettings')
      .select(['key', 'value'])
      .where('officeId', 'is', null)
      .where('key', 'in', [PRICE_APPROVAL_KEY, SELLER_KYC_KEY])
      .execute();
    const value = (key: string): unknown => rows.find((row) => row.key === key)?.value;
    const percent = value(PRICE_APPROVAL_KEY);
    return {
      priceReductionApprovalPercent: typeof percent === 'number' && Number.isInteger(percent) && percent >= 1 && percent <= 100 ? percent : null,
      requireSellerKyc: value(SELLER_KYC_KEY) === true,
    };
  }

  async save(tx: Tx, ctx: TenantContext, body: ListingSettingsBody): Promise<ListingSettingsDto> {
    const before = await this.get(tx);
    const next: ListingSettingsDto = {
      priceReductionApprovalPercent: body.priceReductionApprovalPercent,
      requireSellerKyc: body.requireSellerKyc,
    };
    if (before.priceReductionApprovalPercent === next.priceReductionApprovalPercent && before.requireSellerKyc === next.requireSellerKyc) {
      return before;
    }

    await tx
      .deleteFrom('companySettings')
      .where('officeId', 'is', null)
      .where('key', 'in', [PRICE_APPROVAL_KEY, SELLER_KYC_KEY])
      .execute();
    const rows = [
      ...(next.priceReductionApprovalPercent !== null ? [{ key: PRICE_APPROVAL_KEY, value: next.priceReductionApprovalPercent }] : []),
      ...(next.requireSellerKyc ? [{ key: SELLER_KYC_KEY, value: true }] : []),
    ];
    if (rows.length > 0) {
      await tx
        .insertInto('companySettings')
        .values(rows.map((row) => ({ companyId: ctx.companyId, officeId: null, key: row.key, value: JSON.stringify(row.value), updatedBy: ctx.userId })))
        .execute();
    }

    const changes: Record<string, { old: unknown; new: unknown }> = {};
    if (before.priceReductionApprovalPercent !== next.priceReductionApprovalPercent) {
      changes['priceReductionApprovalPercent'] = { old: before.priceReductionApprovalPercent, new: next.priceReductionApprovalPercent };
    }
    if (before.requireSellerKyc !== next.requireSellerKyc) {
      changes['requireSellerKyc'] = { old: before.requireSellerKyc, new: next.requireSellerKyc };
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
