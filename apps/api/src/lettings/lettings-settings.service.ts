import { Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import type { TenantContext } from '../common/request-context.js';
import type { Tx } from '../database/database.module.js';
import { REQUIRE_SIGNED_LEASE_KEY } from './leases.service.js';
import { ARREARS_STEPS_KEY, arrearsSteps, checkArrearsSteps } from './arrears.service.js';
import type { LettingsSettingsBody, LettingsSettingsDto } from './rent.dto.js';
import { Problems } from '../common/problem.js';
import { CHARGE_LEAD_DAYS_KEY, chargeLeadDays } from './rent-schedule.js';

/** Company setting (IN-2): the default inspection areas. */
export const INSPECTION_AREAS_KEY = 'lettings.inspection_areas';

/**
 * Lettings company settings (ST-2): the charge lead time (P7-D6), which has
 * no default and leaves the rent schedule idle until set (W7-D7), and the
 * signed-lease rule for activation (P7-D5, L1-D3), on unless turned off, and
 * the arrears steps (P7-D10, L3), none until set, and the default inspection
 * areas (IN-2, L4), none until set.
 */
@Injectable()
export class LettingsSettingsService {
  constructor(private readonly audit: AuditService) {}

  async get(tx: Tx): Promise<LettingsSettingsDto> {
    const signed = await tx.selectFrom('companySettings').select('value').where('officeId', 'is', null).where('key', '=', REQUIRE_SIGNED_LEASE_KEY).executeTakeFirst();
    const areas = await tx.selectFrom('companySettings').select('value').where('officeId', 'is', null).where('key', '=', INSPECTION_AREAS_KEY).executeTakeFirst();
    return {
      chargeLeadDays: await chargeLeadDays(tx),
      requireSignedLease: signed?.value !== false,
      arrearsSteps: await arrearsSteps(tx),
      inspectionAreas: Array.isArray(areas?.value) ? (areas.value as string[]) : [],
    };
  }

  async save(tx: Tx, ctx: TenantContext, body: LettingsSettingsBody): Promise<LettingsSettingsDto> {
    const before = await this.get(tx);
    if (body.arrearsSteps) {
      const errors = await checkArrearsSteps(tx, ctx, body.arrearsSteps);
      if (errors.length > 0) throw Problems.validation(errors);
    }
    const areas = body.inspectionAreas ? body.inspectionAreas.map((area) => area.trim()) : before.inspectionAreas;
    if (body.inspectionAreas) {
      const seen = new Set<string>();
      const errors = areas.flatMap((area, index) => {
        const key = area.toLocaleLowerCase();
        const error = area.length === 0 ? 'empty' : seen.has(key) ? 'duplicate' : null;
        seen.add(key);
        return error ? [{ field: `inspectionAreas.${index}`, code: error, message: error === 'empty' ? 'Name the area.' : 'This area is listed already.' }] : [];
      });
      if (errors.length > 0) throw Problems.validation(errors);
    }
    const steps = body.arrearsSteps ? body.arrearsSteps.map((step) => ({ actionCode: step.actionCode, afterDays: step.afterDays })) : before.arrearsSteps;
    const after: LettingsSettingsDto = { chargeLeadDays: body.chargeLeadDays, requireSignedLease: body.requireSignedLease, arrearsSteps: steps, inspectionAreas: areas };
    const stepsChanged = JSON.stringify(before.arrearsSteps) !== JSON.stringify(after.arrearsSteps);
    const areasChanged = JSON.stringify(before.inspectionAreas) !== JSON.stringify(after.inspectionAreas);
    if (before.chargeLeadDays === after.chargeLeadDays && before.requireSignedLease === after.requireSignedLease && !stepsChanged && !areasChanged) return before;
    await tx.deleteFrom('companySettings').where('officeId', 'is', null).where('key', 'in', [CHARGE_LEAD_DAYS_KEY, REQUIRE_SIGNED_LEASE_KEY, ARREARS_STEPS_KEY, INSPECTION_AREAS_KEY]).execute();
    const rows = [{ key: REQUIRE_SIGNED_LEASE_KEY, value: JSON.stringify(after.requireSignedLease) }];
    if (after.chargeLeadDays !== null) rows.push({ key: CHARGE_LEAD_DAYS_KEY, value: JSON.stringify(after.chargeLeadDays) });
    if (after.arrearsSteps.length > 0) rows.push({ key: ARREARS_STEPS_KEY, value: JSON.stringify(after.arrearsSteps) });
    if (after.inspectionAreas.length > 0) rows.push({ key: INSPECTION_AREAS_KEY, value: JSON.stringify(after.inspectionAreas) });
    await tx
      .insertInto('companySettings')
      .values(rows.map((row) => ({ companyId: ctx.companyId, officeId: null, key: row.key, value: row.value, updatedBy: ctx.userId })))
      .execute();
    const changes: Record<string, { old: unknown; new: unknown }> = {};
    if (before.chargeLeadDays !== after.chargeLeadDays) changes['chargeLeadDays'] = { old: before.chargeLeadDays, new: after.chargeLeadDays };
    if (before.requireSignedLease !== after.requireSignedLease) changes['requireSignedLease'] = { old: before.requireSignedLease, new: after.requireSignedLease };
    if (stepsChanged) changes['arrearsSteps'] = { old: before.arrearsSteps, new: after.arrearsSteps };
    if (areasChanged) changes['inspectionAreas'] = { old: before.inspectionAreas, new: after.inspectionAreas };
    await this.audit.record(tx, ctx, { action: 'settings.lettings_updated', entityType: 'company', entityId: ctx.companyId, changes });
    return after;
  }
}
