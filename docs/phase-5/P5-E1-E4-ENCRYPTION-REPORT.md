# Phase 5 · Milestone report: field encryption stages E1–E4 (issue #17)

| | |
|---|---|
| Date | 1 November 2026 |
| Branch / commit | `phase-5/preparation` · `7fc76b1` |
| Scope | ADR-007 stages E1 (crypto core), E2 (keys and schema), E3 (integration rules), E4 (reveal). Approved sequence: these precede any storage of CRM contact data |
| Result | **E1–E4 complete.** No CRM contact data is stored by any endpoint yet. CRM implementation may now start (approved sequence step 4) |

## 1. Deliverables

| Stage | Deliverable | Location |
|---|---|---|
| E1 | AES-256-GCM field cipher: versioned header (format, key version, 96-bit random nonce), authenticated data binding each value to company, table, column and row | `apps/api/src/crypto/field-cipher.ts` |
| E1 | Company-scoped HMAC-SHA256 lookup hashes with identifier normalisation; display suffix | `apps/api/src/crypto/lookup-hash.ts` |
| E1 | Key provider port; `local` adapter (refused when `NODE_ENV=production`); `none` default that fails closed | `apps/api/src/crypto/key-provider.ts`, `crypto.module.ts`, `config/config.ts` |
| E1 | Company key service: first-use key creation, unwrap, bounded cache (≤ 300 s TTL, LRU size limit), copies handed to callers, overwrite on eviction and shutdown | `apps/api/src/crypto/company-keys.service.ts` |
| E2 | Migration 0021: `company_data_keys` (wrapped keys only, RLS, restrictive first-key-only insert for the runtime role, forward-only lifecycle trigger, crypto-shredding by erasing key material) | `database/migrations/0021_field_encryption_keys.sql` |
| E2 | `identity_documents.number_last4`; encrypted, hashed tax number and encrypted registration number for individuals (E-Q1), with a check that refuses plain values for persons | same migration |
| E3 | `SensitiveDataService`: the only path to encrypted columns (`seal`, `open`, `hash`, `protectIdentifier`); maps key and integrity failures to safe errors | `apps/api/src/crypto/sensitive-data.service.ts` |
| E3 | Register of every encrypted column (`SENSITIVE_FIELDS`), used for log redaction and checked against the database catalogue | `apps/api/src/crypto/sensitive-fields.ts` |
| E3 | Log redaction of every protected field name and of request and response bodies; injectable log stream for leak tests | `apps/api/src/app.module.ts` |
| E4 | `POST /api/v1/contacts/{contactId}/sensitive/{field}/reveal` (dateOfBirth, taxNumber, organisationRegNumber) and `POST /api/v1/contacts/{contactId}/identity-documents/{documentId}/reveal` | `apps/api/src/contacts/` |
| E4 | `encryption-unavailable` (503) problem type; per-action step-up window (`REVEAL_STEP_UP_MAX_AGE_SECONDS`, default 300 s) | `common/problem.ts`, `auth/token-verifier.service.ts` |
| Docs | ADR-007 accepted with decisions; implementation note on first-use key creation; configuration in `.env.example`; OpenAPI regenerated | `docs/decisions/ADR-007…`, `apps/api/.env.example`, `apps/api/openapi.json` |

## 2. Tests

| Suite | Tests | Result |
|---|---|---|
| `field-encryption.test.ts` (unit: cipher, hashes, providers, configuration, register, contact scope) | 19 | ✅ |
| `field-encryption.e2e.test.ts` (keys in PostgreSQL, RLS, lifecycle, cache, sealing, reveal endpoints) | 19 | ✅ |
| `field-encryption-logging.e2e.test.ts` (log leakage on success and failure paths; direct redaction) | 2 | ✅ |
| `database-catalogue.test.ts` (+2: every encrypted column registered and `bytea`; no index on an encrypted column) | 6 | ✅ |
| SQL suite `database/tests/04_field_encryption_keys.sql` | 14 assertions | ✅ |
| Full API suite (`test:ci`, local) | 326 in 25 files | ✅ (no regressions) |
| Lint, typecheck, OpenAPI | — | ✅ |
| GitHub CI on `d2ba0de` (E1–E4 code plus this report) | run 64: all six jobs green (SQL, API, web, web end-to-end, gitleaks, OSV-Scanner) | ✅ |

Coverage of the new code (lines): `src/crypto` 99.3 %, `src/contacts` 100 %. Whole API: 96.7 % statements, 92.1 % branches, 99.0 % lines.

## 3. Security validation

Mapped to the threat model (plan §2) and acceptance tests (plan §5):

| Check | Evidence |
|---|---|
| Round-trip for every C3 field, including non-Latin text | unit tests |
| Tampered byte, truncated or unknown format, wrong key → refused, message never contains the value | unit tests |
| Ciphertext moved to another row, column, table or company → refused (T-6, T-7) | unit tests; e2e "ciphertext copied from another contact" → 422, nothing revealed, nothing audited |
| Same identifier → different hash per company; same hash regardless of formatting (T-9) | unit and e2e tests |
| Keys stored only wrapped; wrapped key does not contain the key | e2e test |
| Runtime role: first key only, cannot add versions, change, delete or touch another company's keys | e2e and SQL tests |
| Lifecycle forward-only; key material never replaced; destroy erases it; destroyed key unusable (crypto-shredding) | e2e and SQL tests |
| Reveal requires `contact.view_sensitive`: office admin, sales manager, agent refused (E-Q5) | e2e test |
| Reveal requires a second factor within 5 minutes (10-minute-old sign-in refused; 2-minute-old accepted; no MFA refused) | e2e test |
| Reason required (10–500 characters) | e2e test |
| Response `Cache-Control: no-store`, `Pragma: no-cache` (T-13) | e2e test |
| Audit entry per reveal with actor, field, reason, step-up time; never the value (T-12) | e2e test |
| 404 for unknown fields, missing values, anonymised contacts, other companies' contacts, document of another contact | e2e test |
| No provider configured, or keys wrapped by another root key → 503 `encryption-unavailable`, fail closed (T-10) | e2e tests |
| Local provider refused in production; bad root key refused (T-15) | unit tests |
| No protected value in captured logs across reveals, validation errors and integrity failures; field names redacted at any depth (T-8) | logging e2e tests |
| Individuals' tax and registration numbers cannot be stored in plain text (E-Q1) | e2e and SQL tests |
| Every `*_encrypted` column registered; none indexed | catalogue tests |

## 4. Audit impact

- New audit action `contact.sensitive_revealed` (entity `contact`; metadata: field, reason, step-up time, identity document id where relevant). Written in the same transaction as the reveal: no reveal without an audit entry.
- The Admin dashboard panel "Sensitive reveals (7d)" (wireframe D-A) reads these entries.
- Audit entries never contain protected values (tested).
- Key lifecycle events (rotation, destruction) are audited by the platform job in E5–E6.

## 5. Performance impact

Measured on the development container (4 vCPU), compiled code, 100,000 iterations:

| Operation | Cost |
|---|---|
| Encrypt one value | 14.3 µs |
| Decrypt one value | 7.7 µs |
| Lookup hash | 5.3 µs |
| Unwrap a company key (local provider; cache miss only) | 8.2 µs |
| Ciphertext size for a 10-character value | 43 bytes (33 bytes overhead) |

- List and dashboard endpoints never decrypt (masked metadata and `last4` only), so they are unaffected.
- A reveal or a protected write adds one key lookup (cached for up to 5 minutes) and microseconds of crypto. A cloud KMS adds one network call per cache miss (E7); measured when E7 is built.
- No new index; one partial index on `contacts.tax_number_hash`.

## 6. Deviations from the plan

| Plan | Implemented | Reason |
|---|---|---|
| Keys created at provisioning, back-filled by migration | Created on first use inside the tenant transaction (restrictive RLS allows only the first key) | A SQL migration cannot call the key service; one code path serves new and existing companies. ADR-007 §4.2 updated |
| Masked metadata in contact list and detail endpoints (E4) | Delivered with the contact endpoints in the CRM milestone | No contact endpoints exist yet; `last4` columns and `SensitiveDataService` are ready for them |
| Reason as picklist plus free text | Free text, 10–500 characters | No reason picklist was approved; a company picklist can be added later without breaking the API |

## 7. Risks and remaining work

| Item | Status |
|---|---|
| E5 rotation job and runbook; E6 erasure, erasure ledger and restore drill | Before Phase 5 exit (approved roadmap) |
| E7 cloud KMS adapter; E8 monitoring | With hosting (#28) and data residency (#20), before any shared environment |
| R-1 KMS vendor not chosen | Open; local provider only, no shared environment |
| R-2 erased data in backups; R-4 compromised API host | Accepted |
| R-3 / WR-1 free-text sensitive data | Accepted for Phase 5; tracked in #35 |
| Web end-to-end harness runs the API with `KEY_PROVIDER=none` | Intended until CRM screens need protected fields; switched to `local` with the CRM milestone |

## 8. GitHub references

| Reference | Link |
|---|---|
| Issue #17 (field encryption) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/17 |
| Issue #8 (wireframes, closed) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/8 |
| Issue #35 (sensitive-data detection, R-3) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/35 |
| Commit `7fc76b1` | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/commit/7fc76b1a3fd977d37574113c054f28c771ab147a |
| CI run 64 (green; run 63 on `7fc76b1` was superseded by this push) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/actions/runs/41320179168 |

## 9. Next: CRM implementation

With E1–E4 in place, CRM work follows the approved wireframes. Proposed milestones:

| Milestone | Content |
|---|---|
| C1 | Contacts API: register, record, create and edit with duplicate check (CA-1 to CA-7), masked protected fields, merge, archive; schema gaps G1, G5 |
| C2 | Requirements and matching (CA-8, G2), identity documents and KYC (CA-9) |
| C3 | Leads, activities and follow-ups (CA-11 to CA-13); D1, D5, D6 rules |
| C4 | Dashboards (CA-14), landlord visibility preview (#12, CA-15), exports (CA-16) |
| C5 | Web screens per the approved wireframes, accessibility and RTL tests, CI |
| E5–E6 | Encryption rotation, erasure and restore drill, in parallel before Phase 5 exit |
