import { Injectable } from '@nestjs/common';

import type { TenantContext } from '../common/request-context.js';
import type { Tx } from '../database/database.module.js';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId: string;
  changes?: Record<string, { old: unknown; new: unknown }> | null;
  metadata?: Record<string, unknown>;
}

export interface DomainEvent {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

/** Fields that never appear in audit change sets. */
const NEVER_AUDITED = new Set(['updatedAt', 'version', 'createdAt', 'searchVector']);

/**
 * Field-level differences between two versions of a record, for the audit log.
 * Values are compared as JSON so dates, numbers-as-strings and arrays compare reliably.
 */
export function diffForAudit(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { old: unknown; new: unknown }> | null {
  const changes: Record<string, { old: unknown; new: unknown }> = {};
  for (const key of Object.keys(after)) {
    if (NEVER_AUDITED.has(key)) continue;
    const oldValue = before[key] ?? null;
    const newValue = after[key] ?? null;
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      changes[key] = { old: oldValue, new: newValue };
    }
  }
  return Object.keys(changes).length > 0 ? changes : null;
}

/**
 * Writes audit events and domain events inside the caller's tenant
 * transaction, so they are committed or rolled back with the change itself.
 */
@Injectable()
export class AuditService {
  async record(tx: Tx, ctx: TenantContext, entry: AuditEntry): Promise<void> {
    await tx
      .insertInto('auditLogs')
      .values({
        companyId: ctx.companyId,
        actorType: 'user',
        actorUserId: ctx.userId,
        actorMembershipId: ctx.membershipId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        changes: entry.changes ? JSON.stringify(entry.changes) : null,
        metadata: JSON.stringify(entry.metadata ?? {}),
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      })
      .execute();
  }

  async emit(tx: Tx, ctx: TenantContext, event: DomainEvent): Promise<void> {
    await tx
      .insertInto('outboxEvents')
      .values({
        companyId: ctx.companyId,
        eventType: event.eventType,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        payload: JSON.stringify({ ...event.payload, requestId: ctx.requestId, actorUserId: ctx.userId }),
      })
      .execute();
  }
}
