# EstatePro API

NestJS 12 · TypeScript (strict, ES modules) · Kysely · PostgreSQL 16 · managed OIDC identity provider.

Decisions: [ADR-001 authentication](../../docs/decisions/ADR-001-authentication-managed-identity-provider.md) · [ADR-002 accessibility](../../docs/decisions/ADR-002-accessibility-wcag-2-2-aa.md) · [ADR-003 API conventions](../../docs/decisions/ADR-003-api-conventions.md). The contract is [`openapi.json`](openapi.json).

## Rules for contributors

1. **Company data is read and written only through `TenantDb.run(ctx, tx => …)`.** It opens a transaction and sets `app.company_id`/`app.user_id`, which the row-level security policies read. There is no other database handle available to request code. If the context were missing, RLS returns nothing.
2. **The runtime role `estatepro_app` never owns tables** (owners bypass RLS). A catalogue test enforces this and that every `company_id` table has RLS.
3. **Errors are thrown as `Problems.*`** (RFC 9457). Never return error JSON by hand; never leak SQL or internal names.
4. **Every endpoint declares its permission** with `@RequirePermission('resource.action')` unless it is company reference data open to all staff. Scope (`all`, `office`, `own`, …) arrives through `@Scope()` and must be applied to the query.
5. **State changes go through action endpoints**, write an audit event (`AuditService.record`) and an outbox event (`AuditService.emit`) in the same transaction.
6. **Money is a decimal string plus currency**, never a JavaScript number.
7. **Record-level scope for properties** goes through `propertyScopeSql` (lists) and `assertPropertyAccess` (single records): 404 when the member cannot see the record, 403 when they can see it but the action's scope does not cover it.
8. **Updates take `If-Match: "<version>"`** (428 when missing, 412 when stale) and skip the write when nothing changes, so the version only moves on a real change. **Creates accept `Idempotency-Key`.**
9. **JSON columns keep their stored keys**: the Kysely case plugin maps column names only. Columns with an underscore before a digit (`address_line_1`) are listed in `SchemaCasePlugin`; a catalogue test checks every column maps back.
10. After changing routes or DTOs, regenerate the contract: `pnpm --filter @estatepro/api openapi`. A test fails if it is stale.

## Local setup

```bash
pnpm install
# PostgreSQL 16+ with a superuser; the tests build their own database from database/migrations.
export TEST_DATABASE_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres
pnpm --filter @estatepro/api test        # lint/typecheck: pnpm --filter @estatepro/api lint | typecheck
```

Running the server needs a migrated database with login enabled for the runtime roles (an operations step, not a migration):

```sql
ALTER ROLE estatepro_app LOGIN PASSWORD '…';
ALTER ROLE estatepro_auth LOGIN PASSWORD '…';
ALTER ROLE estatepro_platform LOGIN PASSWORD '…'; -- only where the provisioning tool runs
```

Then copy `.env.example` to `.env`, fill in the identity provider values, and run `pnpm --filter @estatepro/api build && pnpm --filter @estatepro/api start`.

## Provisioning a pilot company

Platform staff (a `platform_staff` row with role `platform_owner` or `super_admin`) create companies with:

```bash
PLATFORM_DATABASE_URL=postgres://estatepro_platform:…@host/estatepro \
pnpm --filter @estatepro/api provision-company -- \
  --staff-email ops@estatepro.example --legal-name "Accra Homes Ltd" --slug accra-homes \
  --country GH --data-region eu-west --office-code OSU --office-name "Osu" \
  --owner-email ama@accrahomes.example --owner-name "Ama Mensah" --status active
```

The owner then signs in through the identity provider with that email (verified); the account is linked on first sign-in. The first platform staff user is inserted manually by the database administrator.

## Endpoints (Phase 4)

| Method | Path | Permission |
|---|---|---|
| GET | `/api/v1/property-types` | `property.view` |
| POST | `/api/v1/property-types` | `settings.manage` |
| PATCH | `/api/v1/property-types/{id}` | `settings.manage` (company types only) |
| GET, POST | `/api/v1/properties` | `property.view`, `property.create` |
| GET, PATCH | `/api/v1/properties/{id}` | `property.view`, `property.update` |
| POST | `/api/v1/properties/{id}/archive`, `/restore` | `property.archive` |
| GET, POST | `/api/v1/properties/{id}/units` | `property.view`, `property.update` |
| GET, PATCH | `/api/v1/units/{id}` | `property.view`, `property.update` |
| POST | `/api/v1/units/{id}/archive`, `/restore` | `property.archive` |

Lists use `limit`, `cursor`, `sort` and `filter[...]` (ADR-003 §6); see `openapi.json` for the filters each list accepts.

## Tests

- Real PostgreSQL, real JWT signatures (a test identity provider serves a JWKS over HTTP), no mocked business rules.
- Coverage thresholds: 95% lines, statements and functions; 90% branches.
- `test/support/probe.controller.ts` is a test-only controller for guard behaviour; it is never registered by `AppModule`.
