import { sql } from 'kysely';

import { effectiveKycStatusSql } from '../contacts/contacts.service.js';
import type { Tx } from '../database/database.module.js';

/** The identity check that proves who an owner is: a person's identity, an organisation's ownership. */
export const OWNER_CHECK_TYPE = { person: 'identity', organisation: 'company_ownership' } as const;

/**
 * Whether each owner's identity is verified now (issue #18): the latest check
 * of the type that applies to the contact is verified and not past its expiry
 * date. A newer pending or failed check replaces an older verified one, the
 * same reading as the contact's Identity tab. Anonymised (erased) contacts are
 * never verified.
 */
export async function ownersVerified(tx: Tx, contactIds: readonly string[]): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  if (contactIds.length === 0) return result;
  const { rows } = await sql<{ contactId: string; verified: boolean }>`
    select c.id as contact_id,
           (not c.is_anonymised and coalesce(latest.status = 'verified', false)) as verified
      from contacts c
      left join lateral (
        select ${effectiveKycStatusSql('k')} as status
          from kyc_checks k
         where k.company_id = c.company_id and k.contact_id = c.id
           and k.check_type = case c.contact_type when 'organisation' then ${OWNER_CHECK_TYPE.organisation} else ${OWNER_CHECK_TYPE.person} end
         order by k.created_at desc, k.entry_no desc
         limit 1) latest on true
     where c.id = any(${[...new Set(contactIds)]}::uuid[])`.execute(tx);
  for (const row of rows) result.set(row.contactId, row.verified);
  return result;
}

/**
 * Publish-checklist items for issue #18: one when no current owner is recorded
 * for the unit, and one per current owner whose identity is not verified (the
 * field names the contact so the screen can link to its Identity tab). Fails
 * closed: an owner with no check, or a check of unknown outcome, blocks.
 */
export async function ownerIdentityBlockers(tx: Tx, unitId: string): Promise<Array<{ field: string; code: string; message: string }>> {
  const { rows } = await sql<{ ownerContactId: string }>`
    select distinct owner_contact_id from app.unit_current_owners(${unitId}::uuid) order by owner_contact_id`.execute(tx);
  if (rows.length === 0) {
    return [{ field: 'sellerKyc', code: 'no-owner', message: "No current owner is recorded for this unit. Add the owner on the property's Ownership tab." }];
  }
  const verified = await ownersVerified(tx, rows.map((row) => row.ownerContactId));
  return rows
    .filter((row) => verified.get(row.ownerContactId) !== true)
    .map((row) => ({ field: `sellerKyc.${row.ownerContactId}`, code: 'unverified', message: "An owner's identity is not verified. Verify it on the owner's Identity tab." }));
}
