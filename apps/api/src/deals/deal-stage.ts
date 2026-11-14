import { sql } from 'kysely';

import type { Tx } from '../database/database.module.js';

export type StageClass = 'lead' | 'qualification' | 'viewing' | 'negotiation' | 'offer_accepted' | 'contract' | 'closed_won' | 'closed_lost';

/**
 * The deal life cycle (readiness report §4.3), as migration 0033 enforces it
 * (app.deal_stage_change_allowed): moves within a class, and between classes
 * as drawn, including the automatic ones (viewing booked, offer recorded,
 * offer accepted or withdrawn, exchange, completion, losing).
 */
const NEXT_CLASSES: Readonly<Record<StageClass, readonly StageClass[]>> = {
  lead: ['qualification', 'viewing', 'negotiation', 'closed_lost'],
  qualification: ['viewing', 'negotiation', 'closed_lost'],
  viewing: ['qualification', 'negotiation', 'closed_lost'],
  negotiation: ['offer_accepted', 'closed_lost'],
  offer_accepted: ['negotiation', 'contract', 'closed_lost'],
  contract: ['closed_won', 'closed_lost'],
  closed_won: [],
  closed_lost: [],
};

export function stageMoveAllowed(from: StageClass, to: StageClass): boolean {
  if (from === 'closed_won' || from === 'closed_lost') return false;
  return from === to || NEXT_CLASSES[from].includes(to);
}

/**
 * Moves a deal to the first active stage of a class in its pipeline (the
 * company's own stages first, then the defaults). The database records the
 * stage history with the note (migration 0030) and checks that the stage
 * agrees with the deal's offers (migration 0032). Returns false when the
 * pipeline has no such stage.
 */
export async function moveDealToStage(tx: Tx, deal: { id: string; dealType: string }, stageClass: StageClass, note: string): Promise<boolean> {
  const stage = await tx
    .selectFrom('pipelineStages')
    .select('id')
    .where('dealType', '=', deal.dealType)
    .where('stageClass', '=', stageClass)
    .where('isActive', '=', true)
    .orderBy(sql`company_id is null`)
    .orderBy('sortOrder')
    .executeTakeFirst();
  if (!stage) return false;
  await sql`select set_config('app.stage_note', ${note}, true)`.execute(tx);
  await tx.updateTable('deals').set({ stageId: stage.id }).where('id', '=', deal.id).execute();
  return true;
}

/** Marks the transaction as a pipeline action: listings with an accepted offer may then change status (migration 0032). */
export async function asPipelineAction(tx: Tx): Promise<void> {
  await sql`select set_config('app.pipeline_action', 'on', true)`.execute(tx);
}
