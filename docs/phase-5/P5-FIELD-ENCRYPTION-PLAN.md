# Phase 5 · Field Encryption Implementation Plan (issue #17)

| | |
|---|---|
| Status | **For product-owner approval**, with [ADR-007](../decisions/ADR-007-field-encryption-key-management.md) |
| Issue | [#17](https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/17) (audit IS-7), High, Phase 5 first item |
| Gate | Stages E1–E4 complete and green in CI **before the first contact record is written** by any Phase 5 code (approved Phase 5 sequence) |
| Contents | §1 Recommended approach · §2 Threat model · §3 Implementation roadmap · §4 Schema changes · §5 Tests and acceptance · §6 Open risks · §7 Approval |

## 1. Recommended approach

Adopt **ADR-007 option C**:

1. Classify contact data (C0–C4). Field-encrypt only **C3 sensitive personal data** (date of birth, identity numbers, payout account numbers, individual tax numbers) and **C4 secrets**.
2. Use **application-level envelope encryption**: AES-256-GCM per value, a **per-company data key**, wrapped by a **regional KMS root key**. Bind every ciphertext to its company, column and row.
3. Use **company-scoped HMAC lookup hashes** for exact-match search and duplicate detection on high-entropy identifiers; store `last4` for display.
4. Keep names, emails, phones, addresses and free text **searchable**, protected by RLS, scopes, storage encryption, masking and audit.
5. Reveal C3 only with `contact.view_sensitive` + step-up + reason, always audited, never cached or logged.
6. Put the KMS behind a port: a guarded **local adapter now**, one **cloud adapter** chosen with the hosting and residency decisions (#20, #28) before any shared environment.
7. Handle erasure with anonymisation and crypto-shredding, plus an **erasure ledger** replayed after restores.

Why: it meets the Phase 1 and Phase 2 commitments, limits any key compromise to one company, keeps the CRM usable (search, de-duplication, matching), and does not block Phase 5 on the unresolved hosting decision.

## 2. Threat model

Assets: C3 values; per-company DEKs and lookup keys; the KMS root key; C2 personal data (context).
Trust boundaries: browser ↔ BFF ↔ API ↔ PostgreSQL; API ↔ KMS; operators ↔ hosting console; backups ↔ restore environment.

| ID | Threat (STRIDE) | Actor | Attack path | Mitigation | Residual risk |
|---|---|---|---|---|---|
| T-1 | Information disclosure | External attacker | SQL injection or a bug returns rows, including C3 columns | C3 stored as ciphertext; keys never in the database; parameterised queries (Kysely); RLS | Low: C3 safe; **C2 exposed** within the company context |
| T-2 | Information disclosure | Attacker with a stolen backup or database dump | Reads backup files | Provider storage encryption; C3 ciphertext; wrapped keys need the KMS root key | Low |
| T-3 | Information disclosure | Over-privileged operator or DBA | Queries production data directly | C3 unreadable without KMS rights; KMS rights separate from database rights; break-glass audited | Low for C3; C2 relies on access policy and audit |
| T-4 | Information disclosure | Attacker with code execution on an API host | Reads process memory or calls KMS with the host's identity | Short key cache TTL; KMS permissions limited to unwrap; anomaly alerts on unwrap volume; host hardening (#28) | **Medium**: a compromised API host can decrypt while compromised |
| T-5 | Elevation of privilege | Malicious or careless staff user | Reveals many C3 values | `contact.view_sensitive` only for owner and accountant; step-up; reason; per-user reveal-rate alert; audit review on D-A | Low–medium (insider with legitimate rights) |
| T-6 | Tampering | Attacker with write access to the database | Copies ciphertext from contact A to B, or between companies | AAD binds company, table, column and row; GCM authentication fails | Low |
| T-7 | Information disclosure | Cross-tenant bug | API decrypts with the wrong company key | Unwrap requires company context; AAD includes company id; per-company keys; tests | Low |
| T-8 | Information disclosure | Anyone with log access | Plaintext in logs, traces, error reports or analytics | Redaction of field names and sensitive request bodies; build-failing log test; no C3 in exports | Low |
| T-9 | Information disclosure | Attacker with hashes | Brute-forces lookup hashes | HMAC with a secret per-company key; no hashing of low-entropy values (DOB, phone) | Low |
| T-10 | Denial of service | KMS outage or mis-configuration | Encrypt and reveal fail | Fail closed with a clear error; cache bridges short outages; lists unaffected; alert | Low (feature degradation only) |
| T-11 | Denial of service (data loss) | Operator error | Root key deleted or `company_data_keys` lost | KMS deletion waiting period at maximum; deletion denied by policy; key rows in backups; recovery runbook and drill | Low |
| T-12 | Repudiation | Staff user | Denies having revealed or exported data | Audit rows with step-up time and request id; audit log append-only | Low |
| T-13 | Information disclosure | Browser-side | Revealed value cached by browser, BFF or proxies | `no-store`; value only in the response body; removed from the DOM after 60 s; no URL parameters | Low |
| T-14 | Information disclosure | Restore of an old backup | Erased people or a closed company reappear | Erasure ledger replayed before the restored database serves traffic | Low (procedural; drilled) |
| T-15 | Spoofing | Misuse of the local key adapter in production | Weak root key in an environment variable | Adapter refuses to start outside development and test; startup check in CI and deployment | Low |

Out of scope here: identity-provider compromise (#6), host and network hardening (#28), penetration testing (#21).

## 3. Implementation roadmap

| Stage | Work | Output | Effort | Gate |
|---|---|---|---|---|
| **E0** | Approve ADR-007 and this plan; answer E-Q1 to E-Q5 | Recorded decisions | — | Before E1 |
| **E1** | Crypto core in `apps/api/src/crypto/`: `FieldCipher` (AES-256-GCM, header, AAD), `LookupHasher` (HMAC-SHA256, per-field normalisation), `KeyProvider` port, `local` adapter with production guard, bounded key cache | Module with unit tests | 2 days | Before contact data |
| **E2** | Migration: `company_data_keys` with RLS and grants; key generation in company provisioning; back-fill for existing companies; `identity_documents.number_last4` (G-E1) | Migration and SQL tests | 1 day | Before contact data |
| **E3** | Integration rules: a repository helper so C3 is encrypted on write and never selected into list queries; structured-log redaction; CI check that no full-text or trigram index includes a C3 column; log-leak test | Helpers, lint/test checks | 2 days | Before contact data |
| **E4** | Reveal endpoint (CA-10): permission, step-up freshness, reason, audit, `no-store`; masked metadata in list and detail endpoints | Endpoint, tests | 1.5 days | Before contact data |
| **E5** | Rotation: worker job for DEK rotation and re-encryption (batched, resumable, idempotent); lookup-key rotation procedure; runbook | Job, runbook, tests | 1.5 days | Before Phase 5 exit |
| **E6** | Erasure and recovery: anonymise-and-shred service for a contact; company crypto-shred; erasure ledger in a locked bucket; restore runbook; recovery drill in CI-like environment | Service, runbook, drill record | 1.5 days | Before Phase 5 exit |
| **E7** | Cloud KMS adapter for the chosen provider and region; IAM policies (unwrap-only for the API; deletion denied); provider audit logging | Adapter, policies | 1.5 days | Before any shared environment (with #20, #28) |
| **E8** | Monitoring: reveal-rate alerts, KMS error and decrypt-failure alerts, dashboards | Alerts | 0.5 day | With #28 |

**Total:** about 11.5 engineer-days; E1–E4 (6.5 days) precede any CRM data storage. E1 can start as soon as this plan is approved; the CRM API work that does not touch C3 fields (leads, tasks, activities) can be built in parallel but must not write contact records until E4 is merged.

Dependencies: step-up authentication (ADR-001 R6) exists in the BFF from M6; the audit module exists from M1; the worker exists from M4.

## 4. Schema changes

| # | Change | Stage |
|---|---|---|
| G-E1 | `identity_documents.number_last4 text` (display without decryption) | E2 |
| G-E2 | `contact_payment_accounts.account_number_hash bytea` + index (duplicate-payee checks) | When payouts are built (Phase 7/9) |
| G-E3 | `company_data_keys` table (ADR-007 §4.2) | E2 |
| G-E4 | Hash and encrypted columns for person `tax_number` if E-Q1 is accepted (`tax_number_encrypted`, `tax_number_hash`, `tax_number_last4`; plain column kept for organisations) | E2 |
| G-E5 | Erasure ledger is object storage, not a table (kept outside database backups) | E6 |

All additive. No existing data is affected because no contact data exists yet.

## 5. Tests and acceptance

| Test | Proves |
|---|---|
| Round-trip encrypt/decrypt per C3 field | Basic correctness |
| Tampered byte, wrong AAD, wrong company, wrong row → failure | T-6, T-7 |
| Value encrypted under DEK v1 decrypts after rotation to v2; re-encryption job moves all rows; v1 destroyed only at zero rows | Rotation (E5) |
| Same ID number in two companies → different hashes | T-9 / tenant isolation |
| Reveal without permission, without fresh step-up, without reason → refused; with all → one value, audit row, `no-store` | E4, T-5, T-12, T-13 |
| Captured logs contain no test C3 value after create, update, reveal and error paths | T-8 |
| CI check: no index includes a C3 column | ADR-007 §6 |
| Local adapter refuses `NODE_ENV=production` | T-15 |
| KMS adapter failure → encrypt/reveal 503, list endpoints 200 | T-10 |
| Restore drill: restore backup, replay ledger, erased contact stays erased | T-14 |

Acceptance for #17: E1–E6 merged with these tests in CI; E7–E8 tracked under #28 with the hosting work; ADR-007 status changed to Accepted.

## 6. Open risks

| ID | Risk | Severity | Owner | Mitigation / next step |
|---|---|---|---|---|
| R-1 | KMS provider not chosen; depends on hosting and data residency (#20, #28) | Medium | Product owner | Local adapter until then; no shared environment without E7 |
| R-2 | Erased data persists in backups until they age out; per-market acceptability unknown | Medium | Product owner + legal (#20) | Erasure ledger; disclose retention in the privacy notice; BYOK per-company keys later if required |
| R-3 | Free-text fields will contain sensitive data despite guidance | **High** | Product + engineering | UI warning, redaction tool, erasure redaction; consider pattern detection (ID or card numbers) on save as a later enhancement |
| R-4 | Compromised API host can decrypt while compromised (T-4) | Medium | Engineering (#28) | Short cache TTL, unwrap-only IAM, anomaly alerts, host hardening, pen test (#21) |
| R-5 | Legitimate insiders with `contact.view_sensitive` misuse access (T-5) | Low–medium | Company owners | Step-up, reason, rate alerts, audit review panel (D-A) |
| R-6 | Single-region keys: a region loss affects availability and recovery | Medium | Hosting (#28) | Cross-region replica keys only where residency allows |
| R-7 | Legal requirements in Ghana and Qatar not yet confirmed | Medium | Legal (#20) | Design keeps region-scoped keys and erasure options open |
| R-8 | KMS cost and latency on cache misses | Low | Engineering | Per-process cache; batch unwraps in jobs |
| R-9 | No age-based features (DOB not searchable) | Low | Product owner | E-Q2 |
| R-10 | Office administrators cannot reveal C3 (seed) | Low | Product owner | E-Q5; per-company custom role if needed |

New risks for review before Phase 5 implementation: **R-2, R-3, R-4** (from this plan) and **WR-1, WR-4** (from the wireframe verification). R-3 and WR-1 are the same risk seen from two sides.

## 7. Approval

| Item | Decision |
|---|---|
| ADR-007 (option C) | ☐ Approved ☐ Approved with changes ☐ Rejected |
| Questions E-Q1 to E-Q5 | |
| Roadmap E0–E8 and the E1–E4 gate | |
| New risks R-2, R-3, R-4 reviewed | |
| Approved by / date | |
