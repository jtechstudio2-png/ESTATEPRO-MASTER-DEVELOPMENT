import type { AuditService } from '../audit/audit.service.js';
import type { TenantContext } from '../common/request-context.js';
import type { Tx } from '../database/database.module.js';
import { asPipelineAction, moveDealToStage } from '../deals/deal-stage.js';

/**
 * Withdraws an accepted offer and returns its deal from "offer accepted" to
 * negotiation (readiness report §4.3), recording why in the stage note. Used
 * by the offer's own withdrawal and by withdrawing the listing (P6-D5); with
 * no stage note (a deal being lost, S3) the deal's stage is left to the
 * caller. The caller sets the listing's status.
 */
export async function releaseAcceptedOffer(
  tx: Tx,
  ctx: TenantContext,
  audit: AuditService,
  offer: { id: string; dealId: string; listingId: string },
  stageNote: string | null,
  cause: 'offer' | 'listing' | 'deal-lost' = 'offer',
): Promise<void> {
  await asPipelineAction(tx);
  await tx.updateTable('offers').set({ status: 'withdrawn', respondedAt: new Date() }).where('id', '=', offer.id).execute();
  const deal = await tx.selectFrom('deals').select(['id', 'dealType', 'stageClass']).where('id', '=', offer.dealId).executeTakeFirstOrThrow();
  if (stageNote !== null && deal.stageClass === 'offer_accepted') await moveDealToStage(tx, deal, 'negotiation', stageNote);
  await audit.record(tx, ctx, {
    action: 'offer.withdrawn',
    entityType: 'offer',
    entityId: offer.id,
    changes: { status: { old: 'accepted', new: 'withdrawn' } },
    metadata: { dealId: offer.dealId, listingId: offer.listingId, wasAccepted: true, cause },
  });
  await audit.emit(tx, ctx, {
    eventType: 'offer.withdrawn',
    aggregateType: 'offer',
    aggregateId: offer.id,
    payload: { offerId: offer.id, dealId: offer.dealId, listingId: offer.listingId, wasAccepted: true },
  });
}
