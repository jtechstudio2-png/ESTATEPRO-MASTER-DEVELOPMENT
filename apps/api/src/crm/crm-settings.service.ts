import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import type { TenantContext } from '../common/request-context.js';
import type { Tx } from '../database/database.module.js';
import type { CrmSettingsBody, CrmSettingsDto } from './leads.dto.js';

export const LEAD_RESPONSE_KEY = 'crm.lead_response_minutes';

/**
 * CRM company settings. The lead response target (decision D3, gap G1) has
 * no default: until a company sets it, nothing is reported as overdue and
 * screens show "not set".
 */
@Injectable()
export class CrmSettingsService {
  constructor(private readonly audit: AuditService) {}

  async get(tx: Tx): Promise<CrmSettingsDto> {
    const row = await tx.selectFrom('companySettings').select('value').where('officeId', 'is', null).where('key', '=', LEAD_RESPONSE_KEY).executeTakeFirst();
    const value = row?.value;
    return { leadResponseMinutes: typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 10080 ? value : null };
  }

  async save(tx: Tx, ctx: TenantContext, body: CrmSettingsBody): Promise<CrmSettingsDto> {
    const before = await this.get(tx);
    if (before.leadResponseMinutes === body.leadResponseMinutes) return before;
    await tx.deleteFrom('companySettings').where('officeId', 'is', null).where('key', '=', LEAD_RESPONSE_KEY).execute();
    if (body.leadResponseMinutes !== null) {
      await tx
        .insertInto('companySettings')
        .values({ companyId: ctx.companyId, officeId: null, key: LEAD_RESPONSE_KEY, value: JSON.stringify(body.leadResponseMinutes), updatedBy: ctx.userId })
        .execute();
    }
    await this.audit.record(tx, ctx, {
      action: 'settings.crm_updated',
      entityType: 'company',
      entityId: ctx.companyId,
      changes: { leadResponseMinutes: { old: before.leadResponseMinutes, new: body.leadResponseMinutes } },
    });
    return { leadResponseMinutes: body.leadResponseMinutes };
  }
}
