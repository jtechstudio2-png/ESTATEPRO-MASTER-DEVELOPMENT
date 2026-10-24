import { Test } from '@nestjs/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';

import { AuditService } from '../src/audit/audit.service.js';
import { APP_CONFIG, type AppConfig } from '../src/config/config.js';
import { ConfigModule } from '../src/config/config.module.js';
import { createKysely, DatabaseHealth, type Db, TenantDb } from '../src/database/database.module.js';
import { HealthController } from '../src/health/health.controller.js';
import type { TenantContext } from '../src/common/request-context.js';
import { Fixtures } from './support/fixtures.js';

describe('tenant transactions and the audit writer', () => {
  let fx: Fixtures;
  let appDb: Db;
  let tenantDb: TenantDb;
  let company: Awaited<ReturnType<Fixtures['company']>>;
  let other: Awaited<ReturnType<Fixtures['company']>>;
  let ctx: TenantContext;

  beforeAll(async () => {
    fx = new Fixtures();
    appDb = createKysely(inject('databaseUrls').app, 2, 'estatepro-infra-test');
    tenantDb = new TenantDb(appDb);
    company = await fx.company();
    other = await fx.company();
    ctx = {
      companyId: company.companyId,
      userId: company.ownerUserId,
      membershipId: company.ownerMembershipId,
      membershipType: 'staff',
      roleKey: 'company_owner',
      contactId: null,
      officeIds: [company.officeId],
      permissions: new Map(),
      requestId: 'req-infra-1',
      ipAddress: '203.0.113.7',
      userAgent: 'vitest',
    };
  });

  afterAll(async () => {
    await appDb.destroy();
    await fx.close();
  });

  it('sees only the current company inside a tenant transaction', async () => {
    const offices = await tenantDb.run(ctx, (tx) => tx.selectFrom('offices').select('companyId').execute());
    expect(new Set(offices.map((o) => o.companyId))).toEqual(new Set([company.companyId]));
  });

  it('sees nothing outside a tenant transaction (fail closed)', async () => {
    const offices = await appDb.selectFrom('offices').select('id').execute();
    expect(offices).toEqual([]);
  });

  it('does not leak the company setting to the next transaction on the same pool', async () => {
    await tenantDb.run(ctx, () => Promise.resolve(undefined));
    const { rows } = await sql<{ value: string | null }>`select nullif(current_setting('app.company_id', true), '') as value`.execute(appDb);
    expect(rows[0]?.value).toBeNull();
  });

  it('writes audit and outbox events in the same transaction', async () => {
    const audit = new AuditService();
    await tenantDb.run(ctx, async (tx) => {
      await audit.record(tx, ctx, {
        action: 'office.viewed',
        entityType: 'office',
        entityId: company.officeId,
        changes: { name: { old: 'A', new: 'B' } },
        metadata: { reason: 'test' },
      });
      await audit.record(tx, ctx, { action: 'office.checked', entityType: 'office', entityId: company.officeId });
      await audit.emit(tx, ctx, { eventType: 'office.viewed', aggregateType: 'office', aggregateId: company.officeId, payload: { a: 1 } });
    });

    const logs = await fx.db.selectFrom('auditLogs').selectAll().where('requestId', '=', 'req-infra-1').orderBy('occurredAt').execute();
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({
      companyId: company.companyId,
      actorType: 'user',
      actorUserId: company.ownerUserId,
      actorMembershipId: company.ownerMembershipId,
      changes: { name: { old: 'A', new: 'B' } },
      metadata: { reason: 'test' },
      ipAddress: '203.0.113.7',
      userAgent: 'vitest',
    });
    expect(logs[1]).toMatchObject({ changes: null, metadata: {} });

    const event = await fx.db.selectFrom('outboxEvents').selectAll().where('aggregateId', '=', company.officeId).where('eventType', '=', 'office.viewed').executeTakeFirstOrThrow();
    expect(event.payload).toEqual({ a: 1, requestId: 'req-infra-1', actorUserId: company.ownerUserId });
  });

  it('rolls back audit events when the change fails', async () => {
    const audit = new AuditService();
    const rollbackCtx: TenantContext = { ...ctx, requestId: 'req-infra-rollback' };
    await expect(
      tenantDb.run(rollbackCtx, async (tx) => {
        await audit.record(tx, rollbackCtx, { action: 'x', entityType: 'office', entityId: company.officeId });
        throw new Error('change failed');
      }),
    ).rejects.toThrow('change failed');
    const logs = await fx.db.selectFrom('auditLogs').select('id').where('requestId', '=', 'req-infra-rollback').execute();
    expect(logs).toEqual([]);
  });

  it('cannot write audit events for another company', async () => {
    const audit = new AuditService();
    await expect(
      tenantDb.run(ctx, (tx) => audit.record(tx, { ...ctx, companyId: other.companyId }, { action: 'x', entityType: 'office', entityId: other.officeId })),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('configuration module and health check', () => {
  it('loads configuration from the environment', async () => {
    const previous = { ...process.env };
    Object.assign(process.env, {
      DATABASE_URL: 'postgres://a:b@localhost/x',
      AUTH_DATABASE_URL: 'postgres://a:b@localhost/x',
      OIDC_ISSUER: 'https://idp.example/',
      OIDC_AUDIENCE: 'api',
      OIDC_JWKS_URL: 'https://idp.example/jwks',
      OIDC_PROVIDER: 'env-idp',
    });
    try {
      const moduleRef = await Test.createTestingModule({ imports: [ConfigModule] }).compile();
      expect(moduleRef.get<AppConfig>(APP_CONFIG).OIDC_PROVIDER).toBe('env-idp');
    } finally {
      process.env = previous;
    }
  });

  it('reports an unreachable database as unavailable', async () => {
    const unreachable = createKysely('postgres://nobody:nothing@127.0.0.1:1/none', 1, 'estatepro-unreachable');
    const health = new DatabaseHealth(unreachable);
    expect(await health.check()).toBe(false);
    await expect(new HealthController(health).health()).rejects.toMatchObject({ status: 503 });
    await unreachable.destroy();
  });
});
