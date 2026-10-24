# ADR-003 — API conventions

| | |
|---|---|
| Status | Accepted (product owner instruction "standardise API conventions", 24 October 2026) |
| Supersedes | Phase 1 baseline §15 and Phase 1 detailed specification §17.1–17.2 where they conflict (route names such as `/branches` and `/work-orders`) |
| Resolves | Audit contradiction C2; audit item MD-5 (OpenAPI contract) |

## 1. Base and versioning

- Base path `/api/v1`. Breaking changes require `/api/v2`; additive changes do not.
- Deprecated endpoints return `Deprecation` and `Sunset` headers at least six months before removal.

## 2. Resource naming

- **Plural, kebab-case nouns from the Phase 2 schema vocabulary:** `/offices`, `/properties`, `/units`, `/listings`, `/property-types`, `/maintenance-requests`, `/management-agreements`. Never synonyms (`/branches`, `/work-orders`).
- **Containment, one level deep:** `GET /properties/{propertyId}/units`, `POST /properties/{propertyId}/units`. Every item is also addressable at the top level (`GET /units/{unitId}`). There is no deeper nesting.
- Path parameters are named `{resourceId}` in camelCase; ids are UUID strings.
- Query parameters are camelCase.

## 3. Methods and state changes

| Operation | Method and path | Success |
|---|---|---|
| List | `GET /properties` | 200 |
| Read | `GET /properties/{propertyId}` | 200 + `ETag` |
| Create | `POST /properties` | 201 + `Location` + `ETag` |
| Update fields | `PATCH /properties/{propertyId}` with `If-Match` | 200 + new `ETag` |
| State change | `POST /properties/{propertyId}/archive`, `/restore`; `POST /listings/{listingId}/status-transitions` | 200 |
| Delete | Not used for business records (they are archived). `DELETE` only for removable sub-items such as a draft translation | 204 |

- State is never changed by `PATCH`; status fields are read-only in `PATCH` bodies and change only through action endpoints, which run the business rules and write status history.
- Action paths are kebab-case verbs or nouns: `/archive`, `/restore`, `/status-transitions`, `/confirm-upload`.

## 4. Request context and headers

| Header | Rule |
|---|---|
| `Authorization: Bearer <token>` | IdP access token (ADR-001); required except on `/health` |
| `X-Company-Id` | Required on every company-scoped endpoint; must match an active membership of the caller |
| `If-Match: "<version>"` | Required on `PATCH` and action endpoints for versioned records. Missing → 428; stale → 412 |
| `Idempotency-Key` | Accepted on every `POST` that creates a record; required on money and messaging endpoints (Phases 7–12). Same key + same body within 24 h replays the stored response; same key + different body → 422 |
| `X-Request-Id` | Optional client-supplied id (8–128 characters `[A-Za-z0-9._-]`); generated otherwise; echoed on every response and recorded in logs and audit events |
| `Accept-Language` | Optional; selects translated labels where translations exist |

## 5. Payload format

- `Content-Type: application/json`; field names camelCase.
- Dates `YYYY-MM-DD`; timestamps RFC 3339 in UTC (`2026-10-24T09:30:00.000Z`).
- **Money:** `{ "amount": "6000.00", "currency": "GHS" }`. The amount is a decimal string, rounded to the currency's minor units; never a JSON number.
- Measurements (areas, bathrooms, coordinates) are JSON numbers.
- Unknown fields in request bodies are rejected (422), so typos do not silently do nothing.
- Read-only fields (`id`, `reference`, `version`, `status`, timestamps) in a request body are rejected (422).
- `null` clears an optional field in `PATCH`; omitting a field leaves it unchanged.

## 6. Lists

- Response: `{ "data": [ … ], "page": { "limit": 50, "nextCursor": "…" | null } }`.
- `limit` 1–100 (default 50); `cursor` is opaque (base64url) and only valid with the same filters and sort.
- Filters: `filter[status]=available,reserved` (comma = OR within a field); ranges `filter[price][gte]=100000&filter[price][lte]=500000`. Each endpoint publishes its allowed filters; unknown filters → 422.
- Sort: `sort=createdAt` or `sort=-createdAt`, one field from the endpoint's allow-list; ties are broken by `id`.
- Text search: `q=` (minimum 2 characters).
- Archived records are excluded unless `filter[archived]=true` or `filter[archived]=all`.

## 7. Errors (RFC 9457)

`Content-Type: application/problem+json`

```json
{
  "type": "urn:estatepro:problem:validation-failed",
  "title": "Validation failed",
  "status": 422,
  "detail": "2 fields are invalid.",
  "instance": "/api/v1/properties",
  "requestId": "6f1c…",
  "errors": [
    { "field": "address.postalCode", "code": "required", "message": "Postcode is required for United Kingdom addresses." }
  ]
}
```

| Status | `type` suffix | When |
|---|---|---|
| 400 | `malformed-request` | Body is not valid JSON |
| 401 | `unauthenticated` | Missing, invalid or expired token |
| 403 | `forbidden`, `mfa-required`, `company-inactive` | Permission missing; MFA proof missing; company suspended/cancelled or read-only for writes |
| 404 | `not-found` | Record does not exist **or** the caller may not see it (one message for both) |
| 409 | `conflict` | Unique or exclusion rule (e.g. duplicate reference, one open listing per unit); body includes `conflictingResource { type, id }` when known |
| 412 | `precondition-failed` | `If-Match` does not match the current version |
| 415 | `unsupported-media-type` | Not JSON |
| 422 | `validation-failed`, `business-rule-violated`, `idempotency-key-reused` | Field validation; state-machine or database rule; reused key with a different body |
| 428 | `precondition-required` | `If-Match` missing |
| 429 | `rate-limited` | Rate limit exceeded (`Retry-After` header); enforced at the gateway from Phase 15 |
| 500 | `internal-error` | Unexpected error; no internal details, only `requestId` |

Database error mapping: unique violation (23505) and exclusion violation (23P01) → 409; check violation (23514), foreign-key violation (23503) and rule triggers → 422; row-level security violation (42501) → 403 for writes, never revealing other companies' data.

## 8. Contract

- The OpenAPI 3.1 document is generated from the API code and committed at `apps/api/openapi.json`.
- CI fails if the committed document differs from the generated one, so the contract cannot drift silently.
