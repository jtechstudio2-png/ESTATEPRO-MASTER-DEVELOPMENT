# ADR-007 — Field encryption and key management

| | |
|---|---|
| Status | **Accepted** (product owner, 1 November 2026: "The CRM wireframes and the field encryption plan are approved"; issue [#17](https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/17), audit IS-7) |
| Date | 1 November 2026 |
| Context | Phase 5 (CRM) stores personal data about buyers, sellers, landlords and tenants. The schema already has envelope-encrypted columns (`*_encrypted`) and keyed hash columns (`number_hash`), but no key hierarchy, rotation or recovery design (audit IS-7; Phase 2 §14 deferred it) |
| Requirements | Phase 1 §6 NFR "field-level encryption for sensitive personal and banking data"; Phase 1 §16 "envelope encryption … with per-Company data keys; masked in the UI by default"; Phase 2 §14 "never logged; revealed only with `contact.view_sensitive` and audited" |
| Companion | [Field Encryption Implementation Plan](../phase-5/P5-FIELD-ENCRYPTION-PLAN.md) (threat model, roadmap, open risks) |
| Gate | Approved sequence: this design is implemented (plan stages E1–E4) **before any contact data is stored** in Phase 5 |

## 1. Decision summary

| ID | Decision |
|---|---|
| E-D1 | **Classify** contact data into five classes (§2). Only class **C3, sensitive personal data**, and **C4, secrets**, are field-encrypted. C2 personal data (names, emails, phones, addresses) is protected by tenant isolation, access control, storage encryption and audit, not field encryption, because the CRM must search, sort and de-duplicate it |
| E-D2 | **Envelope encryption in the application.** AES-256-GCM per field value, with a per-company data encryption key (DEK). The database never sees plaintext or keys |
| E-D3 | **Key hierarchy:** one KMS root key per deployment region → per-company DEKs (wrapped by the root key, stored in `company_data_keys`) → field ciphertext. A separate per-company lookup key for keyed hashes |
| E-D4 | **Ciphertext is bound to its place** with authenticated data (company, table, column, row id), so a value cannot be copied to another row or company and still decrypt |
| E-D5 | **Search on C3 is exact-match only**, through HMAC-SHA256 lookup hashes for high-entropy identifiers (ID numbers, account numbers). No partial, range or sorted search on encrypted values. Display uses stored `last4` and masked metadata |
| E-D6 | **KMS behind a port** (`KeyProvider`), like storage and geocoding. A local adapter for development and CI that refuses to start in production; one cloud adapter chosen with the hosting and data-residency decisions (#20, #28) |
| E-D7 | **Rotation:** automatic yearly rotation of the KMS root key; DEK rotation yearly and on suspected compromise, with background re-encryption; lookup-key rotation only on compromise |
| E-D8 | **Erasure** by anonymisation plus removal of ciphertext for the person, and crypto-shredding (DEK destruction) for a whole company. An erasure ledger outside database backups is re-applied after any restore |
| E-D9 | **Reveal** of a C3 value needs `contact.view_sensitive`, step-up authentication and a reason; it is always audited; plaintext is never cached, logged or put in URLs |
| E-D10 | **Fail closed:** if keys are unavailable, encrypt and reveal operations fail with a clear error; the rest of the CRM keeps working because lists never decrypt |

## 2. Contact data classification

| Class | Definition | Examples (table.column) | Protection |
|---|---|---|---|
| **C0 Public** | Intended for publication | Published listing text, public location | Integrity and access control only |
| **C1 Internal** | Business data, not about a person | Picklists, property types, lead source codes, task types | Tenant isolation (RLS) |
| **C2 Personal** | Identifies or contacts a person; needed for daily work and search | `contacts.display_name`, `display_name_local`, `given_name`, `family_name`, `primary_email`, `primary_phone_e164`, `contact_methods.value`, `addresses.*`, `requirements.*`, `leads.message`, `activities.subject/body`, `contacts.notes`, `consents.evidence`, nationality and residence country | RLS, role scopes, storage encryption, TLS, audit of exports, masking in lists, erasure by anonymisation |
| **C3 Sensitive personal** | Misuse causes fraud, identity theft or serious harm; rarely needed in clear | `contacts.date_of_birth_encrypted`; `identity_documents.number_encrypted`; `contact_payment_accounts.account_number_encrypted`, `routing_encrypted`; `bank_accounts.account_number_encrypted` (company accounts, migration 0008); `contacts.tax_number` and `organisation_reg_number` for persons (see §3.2) | All C2 measures **plus** field encryption, reveal with step-up, reveal audit |
| **C4 Secrets** | Credentials for systems | `webhook_endpoints.secret_encrypted`; `mfa_factors.secret_encrypted` (unused while the identity provider holds MFA, ADR-001) | Field encryption with the same scheme; never revealed to users after creation |

Scanned identity documents and KYC evidence files are stored in object storage (ADR-005) with server-side encryption, private buckets and short-lived signed URLs. They are C3 **files**; the file encryption-at-rest is the storage provider's, and access is controlled by the documents module (§5).

### 2.1 Special categories

EstatePro does not collect health, religion, ethnicity, biometric or criminal data. Nationality is C2. If a future feature needs a special category (for example tenant references that mention health), it requires a new classification decision first.

## 3. Encryption scope

### 3.1 Encrypted now (Phase 5)

| Field | Phase it is first written | Lookup hash | Display |
|---|---|---|---|
| `contacts.date_of_birth_encrypted` | Phase 5 (C-3) | **None** (low entropy: a hash of a date can be brute-forced) | Masked; reveal only |
| `identity_documents.number_encrypted` | Phase 5 (KYC, #18) | `number_hash` (exists) | Last 4 digits from plaintext at write time (new column `number_last4`, plan G-E1) |

### 3.2 Encrypted when first written (later phases, same scheme)

| Field | Phase | Lookup hash |
|---|---|---|
| `contact_payment_accounts.account_number_encrypted`, `routing_encrypted` | 7 / 9 | New `account_number_hash` for duplicate-payee fraud checks (plan G-E2) |
| `bank_accounts.account_number_encrypted` (company accounts) | 9 | Not needed |
| `webhook_endpoints.secret_encrypted` | 12 | Not applicable |
| `contacts.tax_number`, `organisation_reg_number` for **persons** | Decision E-Q1 | Hash if duplicate detection is wanted |

### 3.3 Deliberately not field-encrypted

| Field group | Reason | Compensating controls |
|---|---|---|
| Names, emails, phone numbers | Needed for search, sorting, de-duplication and daily calling; encrypted search would break CRM-02 and Phase 3 search | RLS, scopes, masking in lists, export audit, rate-limited duplicate check |
| Addresses | Needed for maps and matching (ADR-006) | As above |
| Free text (notes, lead messages, activity bodies) | Unstructured and searched; encrypting would hide it from search and timelines | UI guidance not to record ID or bank numbers; redaction tool; erasure redacts; risk R-3 |
| Organisation tax and registration numbers | Public registers in all three markets | — |

## 4. Key management architecture

```text
            ┌──────────────────────────────────────┐
            │ KMS (per deployment region)          │
            │  Root key  RK-region  (never leaves) │
            └───────────────┬──────────────────────┘
                 wrap / unwrap (KMS API, audited by provider)
            ┌───────────────┴──────────────────────┐
            │ company_data_keys (PostgreSQL, RLS)  │
            │  company · purpose · version ·       │
            │  wrapped_key · kms_key_ref · status  │
            └───────────────┬──────────────────────┘
               unwrapped in API memory (cache ≤ 5 min)
      ┌─────────────────────┴─────────────────────┐
      │ DEK (field, AES-256)   LK (lookup, HMAC)  │
      └──────────┬───────────────────────┬────────┘
       AES-256-GCM + AAD           HMAC-SHA256
      ┌──────────┴─────────┐   ┌─────────┴─────────┐
      │ *_encrypted bytea  │   │ *_hash bytea      │
      └────────────────────┘   └───────────────────┘
```

### 4.1 Keys

| Key | Where | Lifetime | Purpose |
|---|---|---|---|
| Root key (RK) | KMS, one per deployment region, non-exportable | Automatic yearly rotation inside KMS; old versions kept for unwrap | Wraps company keys |
| Data key (DEK) | `company_data_keys` (wrapped); API memory (unwrapped, cached) | Rotated yearly or on compromise; old versions decrypt-only until no data uses them | Encrypts field values for one company |
| Lookup key (LK) | `company_data_keys` (wrapped, `purpose = 'lookup'`) | Rotated only on compromise (needs recomputation) | Keyed hashes for exact lookups |

### 4.2 `company_data_keys` (new table, plan stage E2)

| Column | Notes |
|---|---|
| `company_id`, `purpose` (`field` \| `lookup`), `version` (int) | Primary key |
| `wrapped_key` bytea | Output of KMS encrypt/wrap; useless without RK |
| `kms_key_ref` text | Identifier of the RK (and region) that wrapped it |
| `status` | `active` (one per company and purpose) → `decrypt_only` → `destroyed` |
| `created_at`, `retired_at`, `destroyed_at` | Lifecycle |

RLS by company like every tenant table. The runtime role may read only `active` and `decrypt_only` rows for the current company context; only the key-management job may insert or change status. Keys are created when a company is provisioned (provisioning CLI, M1) and back-filled for existing companies by migration.

### 4.3 Ciphertext format

```text
byte 0      format version (0x01)
bytes 1–4   DEK version (uint32, big-endian)
bytes 5–16  nonce (96-bit, random per value)
bytes 17–   AES-256-GCM ciphertext ‖ 16-byte tag
AAD         "ep1|" ‖ company_id ‖ "|" ‖ table ‖ "." ‖ column ‖ "|" ‖ row_id
```

- The version byte allows a future algorithm change without a flag day.
- Random 96-bit nonces are safe far beyond EstatePro's volume per DEK; yearly DEK rotation keeps each key well below the 2³² messages per key guideline for random nonces.
- AAD binds a value to its company, column and row. Copying ciphertext to another contact or company fails authentication (threat T-6).

### 4.4 Lookup hashes

`hash = HMAC-SHA256(LK_company, purpose ‖ ":" ‖ normalise(value))`, stored as `bytea`. Normalisation is defined per field (upper case, strip spaces and separators for ID and account numbers). Lookups are company-scoped by construction: the same passport number gives different hashes in different companies, so hashes cannot be correlated across tenants. Low-entropy values (dates of birth, phone numbers) are never hashed this way.

### 4.5 Key provider port

| Adapter | Use | Guard |
|---|---|---|
| `local` | Development, tests, CI. Root key from an environment variable; AES key wrap | Refuses to start when `NODE_ENV=production` or when the configured environment is `staging`/`production` |
| One cloud KMS adapter (AWS KMS, Google Cloud KMS or Azure Key Vault) | Shared environments | Chosen with the hosting and region decision (#20, #28). Root key in the same region as the company's data |

The port has three operations: `generateDataKey(companyId, purpose)`, `unwrap(wrappedKey, keyRef)`, `describe(keyRef)`. Unwrapped keys live in a bounded in-memory cache (TTL ≤ 5 minutes, per process, cleared on shutdown); buffers are overwritten on eviction.

## 5. Encryption at rest and in transit

| Layer | Mechanism | Owner |
|---|---|---|
| Database storage, WAL, replicas | Managed PostgreSQL storage encryption (AES-256), provider or customer-managed key | Hosting (#28) |
| Database backups and point-in-time recovery | Provider-encrypted; access restricted and audited | Hosting (#28) |
| Object storage (media, documents, ID scans) | Server-side encryption by the provider (R2 or S3 default), private buckets, signed URLs (ADR-005) | ADR-005 |
| C3 and C4 fields | Application envelope encryption (this ADR) | API |
| In transit | TLS 1.2+ everywhere, HSTS, TLS to the database and KMS | Hosting |
| Logs and traces | No C3/C4 values, enforced by redaction and tests (§9) | API |

Storage encryption protects against lost disks and provider media; it does not protect against SQL injection, a stolen database dump taken through a valid session, or an over-privileged operator. Field encryption covers those for C3.

## 6. Search and indexing implications

| Need | Supported? | How |
|---|---|---|
| Find a contact by name, phone, email | Yes | C2 is plain; `search_vector`, trigram, normalised methods (unchanged) |
| Find a contact by passport or national ID number | Exact match only | `number_hash` lookup, company-scoped |
| Detect duplicate ID documents | Yes | `identity_documents_hash_idx` |
| Detect the same payout account used by two contacts | Yes, from Phase 7/9 | `account_number_hash` (G-E2) |
| Search or filter by date of birth or age | **No** | Product impact: no age-based filters. Accepted in E-Q2 |
| Sort or range-query encrypted values | **No** | — |
| Show "ends in 4821" | Yes | `last4` stored at write time |

No index is ever built on ciphertext. Full-text and trigram indexes must never include a C3 column (a CI check enforces it, plan stage E3).

## 7. Multi-tenant considerations

- **Per-company keys:** one company's keys cannot decrypt another's data. A compromised DEK exposes one company only.
- **AAD binding** stops cross-tenant ciphertext copying even if RLS were bypassed.
- **Company-scoped hashes** stop cross-tenant correlation of identity numbers.
- **Unwrap requires a company context:** the API unwraps a DEK only inside a request or job that has set the tenant context (the existing transaction wrapper). Platform staff cannot reveal company data except through a support-access grant (#19), and such reveals are audited in both the company's and the platform's audit logs.
- **Region:** a company's data region is fixed at creation; its keys are wrapped by that region's RK. Moving a company between regions is a re-encryption project, not a configuration change.
- **Per-company KMS keys** (one RK per company) are not used now: cost and KMS quotas grow with the number of companies. They remain an option for an enterprise "bring your own key" offer (E-Q4).

## 8. Backups, erasure and crypto-shredding

| Event | Live database | Backups |
|---|---|---|
| A person's erasure request | Contact anonymised (`is_anonymised`), C3 ciphertext set to NULL, free text redacted, methods removed | Old values remain in backups until they age out of retention |
| Company closure | DEK and LK rows set to `destroyed` and wrapped keys overwritten; company rows deleted per the retention policy | Backups still hold wrapped keys, which RK can unwrap until those backups age out |
| Restore from backup | — | **Erasure ledger re-applied before the restored database serves traffic** |

The **erasure ledger** is an append-only record of erasures and key destructions (ids and timestamps, no personal data), stored outside the database backup set (separate object-storage bucket with object lock). The restore runbook replays it. Backup retention is set with hosting (#28); the privacy notice states that erased data persists in encrypted backups for at most that period. Whether that satisfies each market's erasure rules is part of the legal review (#20).

## 9. Reveal, logging and audit requirements

| Requirement | Detail |
|---|---|
| Reveal authorisation | `contact.view_sensitive` (company owner and accountant in the seed) + step-up re-authentication within the last 5 minutes (ADR-001 R6) + a reason |
| Reveal response | One field, one value; `Cache-Control: no-store`; never in URLs; UI hides it after 60 seconds (proposal, E-Q3) |
| Audit: reveal | `audit_logs` row: actor, contact, field, reason, step-up time, request id. Never the value |
| Audit: key lifecycle | Create, rotate, retire, destroy, unwrap failures, local-adapter use outside development |
| Audit: exports | `contact.export` and `lead.export` already flagged sensitive; exports never include C3 values (masked metadata only) |
| Provider logs | KMS provider audit logs retained for at least the audit-log retention period |
| Alerting | Unusual reveal volume per user per hour, KMS errors, decrypt failures (possible tampering). Thresholds set with #28 |
| Logging | Structured-log redaction for every C3/C4 field name and for request bodies of sensitive endpoints; a test fails the build if a known test value appears in captured logs |

## 10. Key rotation process

| Key | Trigger | Steps |
|---|---|---|
| Root key | Yearly (automatic in KMS); compromise | KMS rotates; existing wrapped DEKs still unwrap. On compromise: create a new RK, re-wrap every company's DEKs (fast: keys only, not data), disable the old RK after verification |
| DEK | Yearly per company; compromise; company request | 1) Generate version n+1, mark it `active`, old version `decrypt_only`. 2) New writes use n+1. 3) Worker re-encrypts rows in batches per company (idempotent: reads the version from the ciphertext header; resumable). 4) When no ciphertext uses version n, mark it `destroyed` and overwrite. Progress and completion audited |
| Lookup key | Compromise only | Add new LK; compute new hashes from decrypted values into a shadow column; switch reads; drop old hashes; destroy old LK |

Rotation never needs downtime: reads accept any non-destroyed version.

## 11. Recovery procedures

| Scenario | Effect | Procedure |
|---|---|---|
| KMS temporarily unavailable | Cache keeps working for up to 5 minutes; then encrypt/reveal fail (E-D10); lists unaffected | Retry with backoff; incident if > 5 minutes; no fallback to weaker storage |
| Root key scheduled for deletion by mistake | Pending deletion (KMS waiting period) | Cancel within the waiting period (set to the provider maximum). Deletion of RKs is blocked by policy except via break-glass |
| `company_data_keys` row damaged or deleted | That company's C3 data unreadable | Restore the key row from backup (wrapped keys are in backups); then re-apply the erasure ledger |
| Suspected DEK compromise | One company exposed | Emergency DEK rotation (§10); incident and breach assessment |
| Region or account loss | Data and keys lost together | Covered by hosting disaster recovery (#28): cross-region replica keys only where residency allows (#20) |
| Break-glass | Any key-administration action outside automation | Two named people, time-boxed role, fully audited |

Recovery drills (restore + ledger replay + decrypt sample) are part of the plan (E6) and are repeated before launch.

## 12. Compliance considerations (Ghana, Qatar, UK)

To be confirmed by the legal review in #20; nothing here is legal advice.

| Market | Law | Relevance to this design |
|---|---|---|
| United Kingdom | UK GDPR and Data Protection Act 2018 | Art. 32 lists encryption as an appropriate security measure; Art. 34(3)(a): notification to individuals may not be required where breached data was unintelligible (for example encrypted); Art. 17 erasure is met by anonymisation plus backup ageing (§8); processor and transfer rules apply to the KMS provider |
| Ghana | Data Protection Act, 2012 (Act 843) | Requires appropriate security safeguards and honours data-subject rights; controllers register with the Data Protection Commission. Key residency and cross-border processing by the KMS provider must be confirmed |
| Qatar | Law No. 13 of 2016 on Personal Data Privacy Protection | Requires precautions to protect personal data and has rules on cross-border transfer and on data of a special nature. Hosting region for data and keys must be confirmed |

Design choices that keep options open: region-scoped root keys, per-company keys, the erasure ledger, and no C3 data in logs or analytics.

## 13. Options considered

| Option | Verdict | Reason |
|---|---|---|
| A. Storage encryption only | Rejected | Does not protect against injection, dumps through valid sessions or over-privileged operators; contradicts Phase 1 §16 |
| B. Database-side encryption (`pgcrypto`) | Rejected | Keys or passphrases pass through SQL sessions and logs; DB operators can decrypt |
| **C. Application envelope encryption, per-company DEK, regional KMS root key, C3 only** | **Chosen** | Meets the requirements; small blast radius; keeps CRM search usable |
| D. Encrypt all personal data (C2 too) with blind indexes | Rejected | Breaks name search, fuzzy matching, sorting and de-duplication (CRM-02, Phase 3 02 §7); high cost for limited gain given RLS and storage encryption |
| E. One KMS key per company | Deferred | Strongest isolation and true crypto-shredding in backups, but cost and quota scale with companies; offer later as BYOK (E-Q4) |

## 14. Product-owner decisions

| # | Question | Decision (approved) |
|---|---|---|
| E-Q1 | Encrypt `tax_number` and `organisation_reg_number` for **persons** (individual taxpayer numbers)? | **Yes**, with a lookup hash |
| E-Q2 | Accept that date of birth cannot be searched or used for age filters? | **Yes** |
| E-Q3 | Revealed value hidden after 60 seconds? | **Yes** |
| E-Q4 | Offer per-company KMS keys (BYOK) to enterprise customers later? | **Later, as an enterprise feature**; not Phase 5 |
| E-Q5 | Office administrators do not have `contact.view_sensitive` in the seed. Keep? | **Keep**: office administrators cannot reveal sensitive data |

## 15. Consequences

- Phase 5 adds a small crypto module, one table, one migration for `number_last4`, a reveal endpoint and a worker job before any contact data is written.
- Lists and dashboards never call KMS, so performance is unaffected; reveal and KYC writes add one cached key lookup.
- A cloud KMS vendor must be selected with the hosting decision (#28) before any shared environment, which already waits for #6 and #20.
- Engineers cannot read C3 data in production databases, which is intended; support uses the reveal flow under #19.
