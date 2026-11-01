import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from './support/app.js';
import { Fixtures } from './support/fixtures.js';

describe('authentication and company context (ADR-001)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let company: Awaited<ReturnType<Fixtures['company']>>;
  let otherCompany: Awaited<ReturnType<Fixtures['company']>>;
  let agent: Awaited<ReturnType<Fixtures['member']>>;
  const now = (): number => Math.floor(Date.now() / 1000);

  beforeAll(async () => {
    t = await createTestApp();
    fx = new Fixtures();
    company = await fx.company();
    otherCompany = await fx.company({ countryCode: 'QA' });
    agent = await fx.member(company.companyId, { roleKey: 'agent', officeIds: [company.officeId] });
    await fx.linkIdentity(agent.userId, 'agent-subject');
  });

  afterAll(async () => {
    await fx.close();
    await t.close();
  });

  const agentToken = (extra: Partial<Parameters<TestApp['idp']['token']>[0]> = {}) =>
    t.idp.token({ sub: 'agent-subject', ...extra });

  describe('public endpoints', () => {
    it('serves /health without a token', async () => {
      const res = await t.http.get('/health').expect(200);
      expect(res.body).toEqual({ status: 'ok', database: 'ok' });
    });
  });

  describe('token verification', () => {
    it('rejects a request without a token with a problem response', async () => {
      const res = await t.http.get('/api/v1/me').expect(401);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({
        type: 'urn:estatepro:problem:unauthenticated',
        status: 401,
        instance: '/api/v1/me',
      });
      expect(res.body.requestId).toBe(res.headers['x-request-id']);
    });

    it('rejects a non-bearer authorization header', async () => {
      await t.http.get('/api/v1/me').set('Authorization', 'Basic abc').expect(401);
    });

    it('rejects a token signed by an unknown key', async () => {
      const token = await agentToken({ signWithForeignKey: true });
      const res = await t.http.get('/api/v1/me').auth(token, { type: 'bearer' }).expect(401);
      expect(res.body.detail).toBe('The access token is not valid.');
    });

    it('rejects an expired token with a specific message', async () => {
      const token = await agentToken({ expiresInSeconds: -120 });
      const res = await t.http.get('/api/v1/me').auth(token, { type: 'bearer' }).expect(401);
      expect(res.body.detail).toBe('The access token has expired.');
    });

    it('rejects a token for another audience or issuer', async () => {
      const wrongAudience = await agentToken({ audience: 'someone-else' });
      await t.http.get('/api/v1/me').auth(wrongAudience, { type: 'bearer' }).expect(401);
      const wrongIssuer = await agentToken({ issuer: 'https://evil.invalid/' });
      await t.http.get('/api/v1/me').auth(wrongIssuer, { type: 'bearer' }).expect(401);
    });

    it('rejects symmetric (HS256) tokens', async () => {
      const token = await agentToken({ algorithm: 'HS256' });
      await t.http.get('/api/v1/me').auth(token, { type: 'bearer' }).expect(401);
    });

    it('rejects a token without a subject', async () => {
      const token = await agentToken({ omitSubject: true });
      await t.http.get('/api/v1/me').auth(token, { type: 'bearer' }).expect(401);
    });

    it('rejects a token that is not yet valid', async () => {
      const token = await agentToken({ notBeforeSeconds: 600 });
      await t.http.get('/api/v1/me').auth(token, { type: 'bearer' }).expect(401);
    });

    it('accepts ES256 tokens', async () => {
      const token = await agentToken({ algorithm: 'ES256' });
      await t.http.get('/api/v1/me').auth(token, { type: 'bearer' }).expect(200);
    });
  });

  describe('identity linking on first sign-in', () => {
    it('refuses an unknown subject without a verified email', async () => {
      const token = await t.idp.token({ sub: 'stranger', email: 'stranger@example.test', emailVerified: false });
      const res = await t.http.get('/api/v1/me').auth(token, { type: 'bearer' }).expect(403);
      expect(res.body.detail).toContain('No EstatePro account is linked');
    });

    it('refuses a verified email that has no EstatePro account', async () => {
      const token = await t.idp.token({ sub: 'stranger-2', email: 'nobody@example.test', emailVerified: true });
      const res = await t.http.get('/api/v1/me').auth(token, { type: 'bearer' }).expect(403);
      expect(res.body.detail).toContain('No EstatePro account exists');
    });

    it('links a provisioned owner by verified email and activates the account', async () => {
      const token = await t.idp.token({
        sub: 'owner-subject',
        email: company.ownerEmail,
        emailVerified: true,
      });
      const res = await t.http.get('/api/v1/me').auth(token, { type: 'bearer' }).expect(200);
      expect(res.body.email).toBe(company.ownerEmail);
      expect(res.body.memberships).toEqual([
        expect.objectContaining({ companyId: company.companyId, roleKey: 'company_owner', membershipType: 'staff' }),
      ]);

      const user = await fx.db.selectFrom('users').select('status').where('id', '=', company.ownerUserId).executeTakeFirstOrThrow();
      expect(user.status).toBe('active');

      // Later requests are recognised by subject alone.
      const bySubject = await t.idp.token({ sub: 'owner-subject' });
      await t.http.get('/api/v1/me').auth(bySubject, { type: 'bearer' }).expect(200);
    });

    it('refuses to link an account that already has a different identity at this IdP', async () => {
      const token = await t.idp.token({ sub: 'hijack-attempt', email: agent.email, emailVerified: true });
      const res = await t.http.get('/api/v1/me').auth(token, { type: 'bearer' }).expect(403);
      expect(res.body.detail).toContain('linked to a different sign-in');
    });

    it('refuses disabled and locked accounts', async () => {
      const disabled = await fx.member(company.companyId, { roleKey: 'agent', userStatus: 'disabled' });
      await fx.linkIdentity(disabled.userId, 'disabled-subject');
      const token = await t.idp.token({ sub: 'disabled-subject' });
      const res = await t.http.get('/api/v1/me').auth(token, { type: 'bearer' }).expect(403);
      expect(res.body.detail).toContain('disabled');

      const locked = await fx.member(company.companyId, { roleKey: 'agent', userStatus: 'locked' });
      const lockedToken = await t.idp.token({ sub: 'locked-subject', email: locked.email, emailVerified: true });
      await t.http.get('/api/v1/me').auth(lockedToken, { type: 'bearer' }).expect(403);
    });
  });

  describe('company context', () => {
    it('requires a valid X-Company-Id header on company endpoints', async () => {
      const token = await agentToken();
      const missing = await t.http.get('/api/v1/company').auth(token, { type: 'bearer' }).expect(422);
      expect(missing.body.errors).toEqual([expect.objectContaining({ field: 'X-Company-Id', code: 'required' })]);
      await t.http.get('/api/v1/company').auth(token, { type: 'bearer' }).set('X-Company-Id', 'not-a-uuid').expect(422);
    });

    it('lets an active member work in their company', async () => {
      const token = await agentToken();
      const res = await t.http
        .get('/api/v1/company')
        .auth(token, { type: 'bearer' })
        .set('X-Company-Id', company.companyId.toUpperCase())
        .expect(200);
      expect(res.body).toMatchObject({ id: company.companyId, baseCurrencyCode: 'GHS', defaultTimezone: 'Africa/Accra' });
    });

    it("refuses a company the user doesn't belong to", async () => {
      const token = await agentToken();
      const res = await t.http
        .get('/api/v1/company')
        .auth(token, { type: 'bearer' })
        .set('X-Company-Id', otherCompany.companyId)
        .expect(403);
      expect(res.body.detail).toBe('You are not an active member of this company.');
    });

    it('refuses suspended or ended memberships', async () => {
      const suspended = await fx.member(company.companyId, { roleKey: 'agent', status: 'suspended' });
      await fx.linkIdentity(suspended.userId, 'suspended-member');
      const token = await t.idp.token({ sub: 'suspended-member' });
      await t.http.get('/api/v1/company').auth(token, { type: 'bearer' }).set('X-Company-Id', company.companyId).expect(403);
    });

    it('keeps portal users out of staff endpoints', async () => {
      const tenant = await fx.member(company.companyId, { roleKey: 'tenant', membershipType: 'portal' });
      await fx.linkIdentity(tenant.userId, 'tenant-subject');
      const token = await t.idp.token({ sub: 'tenant-subject' });
      const res = await t.http
        .get('/api/v1/company')
        .auth(token, { type: 'bearer' })
        .set('X-Company-Id', company.companyId)
        .expect(403);
      expect(res.body.detail).toBe('This area is for company staff only.');
    });

    it('blocks suspended and cancelled companies', async () => {
      const blocked = await fx.company();
      const member = await fx.member(blocked.companyId, { roleKey: 'agent' });
      await fx.linkIdentity(member.userId, `blocked-${blocked.companyId}`);
      const token = await t.idp.token({ sub: `blocked-${blocked.companyId}` });

      await fx.setCompanyStatus(blocked.companyId, 'suspended');
      const suspended = await t.http.get('/api/v1/company').auth(token, { type: 'bearer' }).set('X-Company-Id', blocked.companyId).expect(403);
      expect(suspended.body.type).toBe('urn:estatepro:problem:company-inactive');

      await fx.setCompanyStatus(blocked.companyId, 'cancelled');
      await t.http.get('/api/v1/company').auth(token, { type: 'bearer' }).set('X-Company-Id', blocked.companyId).expect(403);

      await fx.setCompanyStatus(blocked.companyId, 'read_only');
      await t.http.get('/api/v1/company').auth(token, { type: 'bearer' }).set('X-Company-Id', blocked.companyId).expect(200);
    });
  });

  describe('multi-factor authentication', () => {
    it('requires MFA for the company owner role', async () => {
      const withoutMfa = await t.idp.token({ sub: 'owner-subject', amr: ['pwd'] });
      const res = await t.http
        .get('/api/v1/company')
        .auth(withoutMfa, { type: 'bearer' })
        .set('X-Company-Id', company.companyId)
        .expect(403);
      expect(res.body.type).toBe('urn:estatepro:problem:mfa-required');

      const withMfa = await t.idp.token({ sub: 'owner-subject', amr: ['pwd', 'mfa'] });
      await t.http.get('/api/v1/company').auth(withMfa, { type: 'bearer' }).set('X-Company-Id', company.companyId).expect(200);
    });

    it('requires MFA when the membership demands it, whatever the role', async () => {
      const strict = await fx.member(company.companyId, { roleKey: 'agent', mfaRequired: true });
      await fx.linkIdentity(strict.userId, 'strict-agent');
      const noMfa = await t.idp.token({ sub: 'strict-agent' });
      await t.http.get('/api/v1/company').auth(noMfa, { type: 'bearer' }).set('X-Company-Id', company.companyId).expect(403);
      const otp = await t.idp.token({ sub: 'strict-agent', amr: ['otp'] });
      await t.http.get('/api/v1/company').auth(otp, { type: 'bearer' }).set('X-Company-Id', company.companyId).expect(200);
    });

    it('accepts configured amr values only', async () => {
      const custom = await createTestApp({ OIDC_MFA_AMR_VALUES: 'hwk' });
      try {
        const otp = await custom.idp.token({ sub: 'owner-subject', amr: ['otp'] });
        await custom.http.get('/api/v1/company').auth(otp, { type: 'bearer' }).set('X-Company-Id', company.companyId).expect(403);
        const hwk = await custom.idp.token({ sub: 'owner-subject', amr: ['hwk'] });
        // Same subject as the main IdP, provider "test-idp" — resolves to the owner.
        await custom.http.get('/api/v1/company').auth(hwk, { type: 'bearer' }).set('X-Company-Id', company.companyId).expect(200);
      } finally {
        await custom.close();
      }
    });
  });

  describe('request ids', () => {
    it('echoes a well-formed client request id', async () => {
      const res = await t.http.get('/health').set('X-Request-Id', 'client-req-12345').expect(200);
      expect(res.headers['x-request-id']).toBe('client-req-12345');
    });

    it('replaces a malformed request id', async () => {
      const res = await t.http.get('/health').set('X-Request-Id', 'bad id with spaces').expect(200);
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  describe('error responses', () => {
    it('returns a problem for unknown routes', async () => {
      const token = await agentToken();
      const res = await t.http.get('/api/v1/nothing-here').auth(token, { type: 'bearer' }).expect(404);
      expect(res.body.type).toBe('urn:estatepro:problem:not-found');
    });

    it('returns a problem for malformed JSON bodies', async () => {
      const res = await t.http
        .post('/api/v1/me')
        .set('Content-Type', 'application/json')
        .send('{"broken": ')
        .expect(400);
      expect(res.body.type).toBe('urn:estatepro:problem:malformed-request');
    });

    it('returns a problem for oversized bodies', async () => {
      const res = await t.http
        .post('/api/v1/me')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ blob: 'x'.repeat(1_100_000) }))
        .expect(413);
      expect(res.body.type).toBe('urn:estatepro:problem:payload-too-large');
    });
  });

  it('records the step-up window from auth_time', async () => {
    const verifier = t.app.get((await import('../src/auth/token-verifier.service.js')).TokenVerifier);
    const recent = { subject: 's', email: null, emailVerified: false, amr: ['mfa'], authTime: now() - 60 };
    const stale = { ...recent, authTime: now() - 3600 };
    const noTime = { ...recent, authTime: null };
    const noMfa = { ...recent, amr: ['pwd'] };
    expect(verifier.hasRecentMfa(recent)).toBe(true);
    expect(verifier.hasRecentMfa(stale)).toBe(false);
    expect(verifier.hasRecentMfa(noTime)).toBe(false);
    expect(verifier.hasRecentMfa(noMfa)).toBe(false);
  });
});

describe('token subject limits', () => {
  it('rejects subjects longer than 255 characters', async () => {
    const t = await createTestApp();
    try {
      const token = await t.idp.token({ sub: 'x'.repeat(256) });
      const res = await t.http.get('/api/v1/me').auth(token, { type: 'bearer' }).expect(401);
      expect(res.body.detail).toBe('The access token has no valid subject.');
    } finally {
      await t.close();
    }
  });
});
