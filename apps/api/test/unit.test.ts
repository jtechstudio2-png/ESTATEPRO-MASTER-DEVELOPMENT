import { HttpException, HttpStatus, Logger, NotFoundException } from '@nestjs/common';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { diffForAudit } from '../src/audit/audit.service.js';
import { problemFromPostgresError, registerConstraintMessages } from '../src/common/db-errors.js';
import { ProblemFilter } from '../src/common/problem.filter.js';
import { ProblemError, Problems } from '../src/common/problem.js';
import { flattenValidationErrors } from '../src/common/validation.js';
import { ConfigError, loadConfig } from '../src/config/config.js';
import { preferredLocales } from '../src/reference/picklists.js';

const validEnv = {
  DATABASE_URL: 'postgres://a:b@localhost/db',
  AUTH_DATABASE_URL: 'postgres://a:b@localhost/db',
  OIDC_ISSUER: 'https://idp.example/',
  OIDC_AUDIENCE: 'api',
  OIDC_JWKS_URL: 'https://idp.example/jwks',
  OIDC_PROVIDER: 'example-idp',
  STORAGE_BUCKET: 'estatepro-media',
  STORAGE_ACCESS_KEY_ID: 'key',
  STORAGE_SECRET_ACCESS_KEY: 'secret',
};

describe('configuration', () => {
  it('applies defaults', () => {
    const config = loadConfig(validEnv);
    expect(config).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      DATABASE_POOL_MAX: 10,
      OIDC_MFA_AMR_VALUES: ['mfa', 'otp', 'hwk', 'swk', 'fido'],
      STEP_UP_MAX_AGE_SECONDS: 900,
      TRUST_PROXY_HOPS: 0,
    });
  });

  it('parses comma-separated amr values', () => {
    expect(loadConfig({ ...validEnv, OIDC_MFA_AMR_VALUES: ' mfa , hwk,,' }).OIDC_MFA_AMR_VALUES).toEqual(['mfa', 'hwk']);
  });

  it('lists every invalid setting', () => {
    expect(() => loadConfig({ ...validEnv, DATABASE_URL: 'nope', OIDC_PROVIDER: 'Bad Provider' })).toThrow(ConfigError);
    try {
      loadConfig({ ...validEnv, DATABASE_URL: 'nope', OIDC_PROVIDER: 'Bad Provider' });
    } catch (error) {
      expect((error as Error).message).toContain('DATABASE_URL');
      expect((error as Error).message).toContain('OIDC_PROVIDER');
    }
  });
});

describe('PostgreSQL error mapping', () => {
  const pgError = (code: string, extra: Record<string, unknown> = {}) => ({ code, message: 'x', severity: 'ERROR', ...extra });

  it.each([
    ['23505', 409, 'conflict'],
    ['23P01', 409, 'conflict'],
    ['23514', 422, 'business-rule-violated'],
    ['23503', 422, 'business-rule-violated'],
    ['23502', 422, 'business-rule-violated'],
    ['22001', 422, 'business-rule-violated'],
    ['22P02', 422, 'business-rule-violated'],
    ['40001', 409, 'conflict'],
    ['40P01', 409, 'conflict'],
  ])('maps %s to %i', (code, status, type) => {
    const problem = problemFromPostgresError(pgError(code));
    expect(problem?.status).toBe(status);
    expect(problem?.code).toBe(type);
  });

  it('distinguishes RLS violations from protecting triggers', () => {
    expect(problemFromPostgresError(pgError('42501', { message: 'new row violates row-level security policy for table "x"' }))?.status).toBe(403);
    expect(problemFromPostgresError(pgError('42501', { message: 'row is posted and cannot be edited' }))?.status).toBe(422);
  });

  it('uses registered constraint messages', () => {
    registerConstraintMessages({ test_unique_idx: 'That reference is taken.' });
    expect(problemFromPostgresError(pgError('23505', { constraint: 'test_unique_idx' }))?.detail).toBe('That reference is taken.');
  });

  it('returns null for unexpected errors', () => {
    expect(problemFromPostgresError(pgError('XX000'))).toBeNull();
  });
});

describe('ProblemFilter', () => {
  beforeAll(() => {
    Logger.overrideLogger(false); // the filter logs 5xx errors; expected here
  });

  const run = (exception: unknown) => {
    const json = vi.fn((_body: Record<string, unknown>) => undefined);
    const type = vi.fn((_contentType: string) => ({ json }));
    const status = vi.fn((_code: number) => ({ type }));
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ requestId: 'req-1', originalUrl: '/api/v1/x?y=1', method: 'GET', path: '/api/v1/x' }),
        getResponse: () => ({ status }),
      }),
    };
    new ProblemFilter().catch(exception, host as never);
    return { status: status.mock.calls[0]?.[0], body: json.mock.calls[0]?.[0] };
  };

  it('passes ProblemErrors through with instance and request id', () => {
    const { status, body } = run(Problems.conflict('Taken', { type: 'property', id: 'p1' }));
    expect(status).toBe(409);
    expect(body).toEqual({
      type: 'urn:estatepro:problem:conflict',
      title: 'Conflict',
      status: 409,
      detail: 'Taken',
      instance: '/api/v1/x',
      requestId: 'req-1',
      conflictingResource: { type: 'property', id: 'p1' },
    });
  });

  it.each([
    [new NotFoundException(), 404],
    [new HttpException('x', HttpStatus.PAYLOAD_TOO_LARGE), 413],
    [new HttpException('x', HttpStatus.UNSUPPORTED_MEDIA_TYPE), 415],
    [new HttpException('x', HttpStatus.BAD_REQUEST), 400],
    [new HttpException('x', HttpStatus.SERVICE_UNAVAILABLE), 503],
    [new HttpException('x', HttpStatus.METHOD_NOT_ALLOWED), 405],
    [new HttpException('x', HttpStatus.GONE), 410],
    [new HttpException('x', HttpStatus.BAD_GATEWAY), 500],
  ])('maps Nest HTTP exceptions (%#)', (exception, expected) => {
    expect(run(exception).status).toBe(expected);
  });

  it('maps body-parser errors', () => {
    expect(run({ type: 'entity.parse.failed', status: 400 }).status).toBe(400);
    expect(run({ type: 'entity.too.large', status: 413 }).status).toBe(413);
    expect(run({ type: 'encoding.unsupported', status: 415 }).status).toBe(415);
  });

  it('maps database errors, and hides unexpected ones', () => {
    expect(run({ code: '23505', message: 'dup', severity: 'ERROR' }).status).toBe(409);
    const unexpected = run({ code: 'XX000', message: 'internal', severity: 'ERROR' });
    expect(unexpected.status).toBe(500);
    expect(unexpected.body?.['detail']).not.toContain('internal');
  });

  it('turns unknown errors into 500 without details', () => {
    const { status, body } = run(new Error('secret stack detail'));
    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('secret');
  });
});

describe('problem helpers', () => {
  it('words single and multiple validation errors', () => {
    expect(Problems.validation([{ field: 'a', code: 'x', message: 'm' }]).detail).toBe('1 field is invalid.');
    expect(Problems.validation([]).detail).toBe('0 fields are invalid.');
  });

  it('exposes the type URN', () => {
    expect(new ProblemError(418, 'teapot', 'Teapot').type).toBe('urn:estatepro:problem:teapot');
    expect(Problems.idempotencyKeyReused().status).toBe(422);
    expect(Problems.preconditionRequired().status).toBe(428);
    expect(Problems.preconditionFailed().status).toBe(412);
  });
});

describe('validation error flattening', () => {
  it('produces dotted paths and kebab-case codes', () => {
    const errors = flattenValidationErrors([
      {
        property: 'address',
        children: [{ property: 'postalCode', constraints: { isNotEmpty: 'postalCode should not be empty' }, children: [] }],
      },
      { property: 'colour', constraints: { whitelistValidation: 'property colour should not exist' }, children: [] },
    ]);
    expect(errors).toEqual([
      { field: 'address.postalCode', code: 'is-not-empty', message: 'postalCode should not be empty' },
      { field: 'colour', code: 'unknown-field', message: 'This field is not allowed.' },
    ]);
  });
});

describe('audit diff', () => {
  it('reports changed fields only and ignores bookkeeping columns', () => {
    expect(
      diffForAudit(
        { name: 'A', price: '10.00', version: 1, updatedAt: 'x', tags: ['a'] },
        { name: 'B', price: '10.00', version: 2, updatedAt: 'y', tags: ['a'] },
      ),
    ).toEqual({ name: { old: 'A', new: 'B' } });
  });

  it('returns null when nothing changed and treats undefined as null', () => {
    expect(diffForAudit({ a: null }, { a: undefined })).toBeNull();
  });
});

describe('preferredLocales', () => {
  it('orders Accept-Language tags by weight, adding base languages and dropping invalid tags', () => {
    expect(preferredLocales(undefined)).toEqual([]);
    expect(preferredLocales('ar-qa,en;q=0.8')).toEqual(['ar-QA', 'ar', 'en']);
    expect(preferredLocales('en;q=0.5, fr-FR;q=0.9, de;q=abc, *, x-klingon, es;q=0')).toEqual(['fr-FR', 'fr', 'en']);
    expect(preferredLocales('en-GB, en-GH, en')).toEqual(['en-GB', 'en', 'en-GH']);
  });
});
