import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';
import { ProbeController } from './support/probe.controller.js';

describe('permission guard, step-up MFA, read-only companies and validation', () => {
  let t: TestApp;
  let fx: Fixtures;
  let company: Awaited<ReturnType<Fixtures['company']>>;
  const now = (): number => Math.floor(Date.now() / 1000);

  beforeAll(async () => {
    t = await createTestApp({}, { controllers: [ProbeController] });
    fx = new Fixtures();
    company = await fx.company();
    const agent = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] });
    await fx.linkIdentity(agent.userId, 'guard-agent');
    const manager = await fx.member(company.companyId, { roleKey: 'sales_manager', officeIds: [company.officeId] });
    await fx.linkIdentity(manager.userId, 'guard-manager');
    const maint = await fx.member(company.companyId, { roleKey: 'maintenance_staff' });
    await fx.linkIdentity(maint.userId, 'guard-maint');
    await fx.linkIdentity(company.ownerUserId, 'guard-owner');
  });

  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  const as = async (sub: string, extra: Record<string, unknown> = {}) => ({
    token: await t.idp.token({ sub, ...extra }),
  });

  it('passes the granted scope and office ids to the handler', async () => {
    const { token } = await as('guard-agent');
    const res = await t.http.get('/test-probe/property-view').auth(token, { type: 'bearer' }).set('X-Company-Id', company.companyId).expect(200);
    expect(res.body).toEqual({ scope: 'office', officeIds: [company.officeId], roleKey: 'agent' });
  });

  it('refuses a role without the permission', async () => {
    const { token } = await as('guard-maint');
    const res = await t.http.get('/test-probe/contact-export').auth(token, { type: 'bearer' }).set('X-Company-Id', company.companyId);
    expect(res.status).toBe(404); // GET on a POST route
    const post = await t.http.post('/test-probe/contact-export').auth(token, { type: 'bearer' }).set('X-Company-Id', company.companyId).expect(403);
    expect(post.body.type).toBe('urn:estatepro:problem:forbidden');
  });

  it('requires a recent MFA sign-in for sensitive permissions (step-up)', async () => {
    const noMfa = await as('guard-manager');
    const res = await t.http.post('/test-probe/contact-export').auth(noMfa.token, { type: 'bearer' }).set('X-Company-Id', company.companyId).expect(403);
    expect(res.body.type).toBe('urn:estatepro:problem:mfa-required');

    const stale = await as('guard-manager', { amr: ['mfa'], authTime: now() - 7200 });
    await t.http.post('/test-probe/contact-export').auth(stale.token, { type: 'bearer' }).set('X-Company-Id', company.companyId).expect(403);

    const fresh = await as('guard-manager', { amr: ['mfa'], authTime: now() - 30 });
    const ok = await t.http.post('/test-probe/contact-export').auth(fresh.token, { type: 'bearer' }).set('X-Company-Id', company.companyId).expect(201);
    expect(ok.body).toEqual({ scope: 'office' });
  });

  it('blocks writes in read-only companies but allows reads', async () => {
    const readOnly = await fx.company();
    const member = await fx.member(readOnly.companyId, { roleKey: 'agent', officeIds: [readOnly.officeId] });
    await fx.linkIdentity(member.userId, `ro-${readOnly.companyId}`);
    await fx.setCompanyStatus(readOnly.companyId, 'read_only');
    const { token } = await as(`ro-${readOnly.companyId}`);
    await t.http.get('/test-probe/property-view').auth(token, { type: 'bearer' }).set('X-Company-Id', readOnly.companyId).expect(200);
    const res = await t.http
      .post('/test-probe/write')
      .auth(token, { type: 'bearer' })
      .set('X-Company-Id', readOnly.companyId)
      .send({ name: 'abc', count: 1, child: { label: 'ok' } })
      .expect(403);
    expect(res.body.detail).toContain('read-only');
  });

  it('returns 422 with one entry per invalid or unknown field', async () => {
    const { token } = await as('guard-agent');
    const res = await t.http
      .post('/test-probe/write')
      .auth(token, { type: 'bearer' })
      .set('X-Company-Id', company.companyId)
      .send({ name: 'a', count: 99, child: { label: 'x' }, colour: 'blue' })
      .expect(422);
    expect(res.body.type).toBe('urn:estatepro:problem:validation-failed');
    expect(res.body.errors.map((e: { field: string; code: string }) => `${e.field}:${e.code}`).sort()).toEqual([
      'child.label:min-length',
      'colour:unknown-field',
      'count:max',
      'name:min-length',
    ]);
  });

  it('accepts a valid body', async () => {
    const { token } = await as('guard-agent');
    await t.http
      .post('/test-probe/write')
      .auth(token, { type: 'bearer' })
      .set('X-Company-Id', company.companyId)
      .send({ name: 'abc', count: 3, child: { label: 'ok' } })
      .expect(201, { received: 'abc' });
  });
});
