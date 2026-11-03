# Phase 5 · Milestone report: C2 Requirements, matching, identity documents and KYC

| | |
|---|---|
| Date | 3 November 2026 |
| Branch | `phase-5/preparation`, commit `8439a5f` |
| Approvals | C1 decisions C1-D1 to C1-D7 approved by the product owner before work started |
| Scope | Requirements and matching (CRM-03; wireframes B-1, B-2; decision D4; gap G2), identity documents (C-5) and identity verification / KYC (CRM-09; SE-1) |
| Result | **C2 complete.** Encryption controls unchanged and enforced; identity numbers encrypted; reveal permissions not relaxed; tenant isolation, audit and performance tested. 400 API tests and 7 SQL test suites green locally and in CI run 68 |

## 1. Deliverables

### 1.1 Database (migration 0023)

| Change | Purpose |
|---|---|
| `app.requirement_area_covers(areas, locality, region, point)` | A listing is inside a requirement when it is inside any of its areas: a locality, a radius (exact, on the spheroid) or a drawn shape. No areas means anywhere |
| `app.rent_per_period()`; `listings.comparable_price` and `requirements.comparable_*_price` (generated) | Rent is compared per period exactly (72,000 a year = 6,000 a month); sale prices compare directly |
| `listings_matching_idx` and whole-unit `*_floor` columns | Lets the price range use an index under row-level security (see §6) |
| Requirement checks: areas are a list of at most 10; bedrooms and price ranges; a rent budget states its period; notes ≤ 2,000 | Integrity |
| `requirement_exclusions` with row-level security; add and remove only | "Not suitable" listings (gap G2) |
| `identity_documents`: version, created by, archive with reason; verified documents cannot change; never deleted by the application | Evidence (C-5) |
| `kyc_checks`: recorded by, the document examined, the reviewer's reason; verified needs a risk rating, failed needs a reason; signed-off checks cannot change; never deleted by the application | Sign-off (SE-1) |

### 1.2 API (`apps/api/src/contacts/`)

| Endpoint | Permission | Wireframe |
|---|---|---|
| `GET /api/v1/requirements` (type, status, currency, financing, contact, budget overlap, move-by, locality; keyset paging) | `contact.view` | B-1 |
| `GET/POST /api/v1/contacts/{id}/requirements`, `GET/PATCH …/{requirementId}` (`If-Match`) | `contact.view` / `contact.update` | B-2 |
| `GET …/requirements/{requirementId}/matches` | `contact.view` + `listing.view` | B-2 |
| `GET/POST …/requirements/{requirementId}/exclusions`, `DELETE …/exclusions/{listingId}` | `contact.view` / `contact.update` | B-2 |
| `GET/POST /api/v1/contacts/{id}/identity-documents`, `PATCH …/{documentId}`, `POST …/{documentId}/archive` (`If-Match`) | `kyc.view` / `kyc.manage` | C-5 |
| `GET/POST /api/v1/contacts/{id}/kyc-checks`, `PATCH …/{checkId}` (`If-Match`) | `kyc.view` / `kyc.manage` | SE-1 |
| `POST …/kyc-checks/{checkId}/approve`, `POST …/kyc-checks/{checkId}/reject` (`If-Match`) | `kyc.approve` | SE-1 |
| Contact register rows gain `identityCheck` (latest identity check; only with `kyc.view` on the contact) | `contact.view` | SE-1 |
| Reveal of a document number: unchanged E4 endpoint | `contact.view_sensitive` + step-up | C-5 |

Matching follows decision D4 exactly. **Must match:** type, currency, price within the budget, bedrooms at least the minimum, inside an area. **Ranked by:** wanted features, wanted property type, bedrooms within the maximum. Each match returns its score breakdown and the rules applied. Duplicate detection (C1) now also matches identity document numbers by keyed hash.

## 2. Requirement checklist

| Requirement | How it is met | Evidence |
|---|---|---|
| Encryption controls remain enforced | Document numbers are written only through `SensitiveDataService` (sealed per row, keyed hash, last 4); the field register name `documentNumber` is used in requests, so log redaction applies | KYC tests; log-leak test extended to the new endpoints |
| Sensitive data remains encrypted | No plaintext column added; ciphertext never in responses, audit or events; catalogue tests still pass (no index on encrypted columns) | Tests "stores the number encrypted…", catalogue suite |
| No relaxation of reveal permissions | Reveal stays on the E4 endpoint (`contact.view_sensitive` + recent second factor). Office administrators and managers see `canReveal: false` and get 403 | Test "keeps reveal permissions unchanged" |
| Tenant isolation | Row-level security on the new table; other companies get 404 on every endpoint; other companies' property types are refused; matching only uses the company's own listings | Isolation tests; SQL suite |
| Audit logging | Every change is audited in the same transaction, with no protected values (§5) | Audit assertions in both e2e suites |
| Performance testing | New 50,000-contact / 40,000-listing test in the nightly and release workflow | §6 |

## 3. Tests

| Suite | Tests | Result |
|---|---|---|
| `requirements.e2e.test.ts` | 18 | ✅ |
| `kyc.e2e.test.ts` | 16 | ✅ |
| `field-encryption-logging.e2e.test.ts` (extended: document create, duplicate, validation) | 2 | ✅ |
| `requirements.performance.test.ts` (nightly and release workflow) | 1 | ✅ p95 774 ms |
| SQL `database/tests/06_requirements_kyc_c2.sql` | 31 assertions | ✅ |
| All SQL suites (23 migrations, 7 files) | — | ✅ |
| Full API suite (`test:ci`, local) | 400 in 29 files | ✅ |
| Lint, typecheck, OpenAPI regenerated | — | ✅ |
| CI run 68 on `8439a5f` (all six required jobs) | — | ✅ [run 68](https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/actions/runs/41601465480) |

Coverage (whole API): 97.26 % statements, 92.33 % branches, 98.96 % functions, 99.36 % lines. New files: 98–100 % of lines.

### 3.1 Defects found by the tests and fixed before commit

| Defect | Found by | Fix |
|---|---|---|
| Match counts for a 100-row register page took 9–15 s at 50,000 requirements: the price condition could not use an index, and counting continued through every match | Performance test | Generated comparable prices with a matching index; counts in lists stop at 100 ("100+", `matchCountCapped`). Exact totals stay on the matches endpoint |
| Under row-level security the price range was applied as a filter, not an index range (`numeric` comparison is not leakproof) | Query plan as the application role | Whole-unit `bigint` copies give the index range; the exact `numeric` comparison then narrows it |
| The document number field was named `number`, not the register's `documentNumber`, so log redaction would not have named it | Review against the field register (ADR-007 E3) | Renamed; log-leak test covers it |

## 4. Security validation

| Check | Result |
|---|---|
| KYC permissions each in their own scope: agents own contacts only; managers office; accountant view only; maintenance staff none | ✅ tested |
| Decision D1 does not extend to KYC: an agent reading a contact through a lead cannot see its documents or checks | ✅ tested |
| Agents cannot sign off checks (no `kyc.approve`) | ✅ tested |
| Identity number duplicates: same contact refused (409); another contact reported as a possible duplicate, never merged, confirmable; out-of-scope matches shown without detail | ✅ tested |
| Signed-off checks and verified documents cannot be changed, even directly in the database | ✅ SQL tests |
| An identity check cannot be signed off with an expired or archived document | ✅ tested |
| Requirements: writes use the narrower contact scope; matches only list listings in the member's `listing.view` scope; `listing.view` is required for matches | ✅ tested |
| Requirements and not-suitable listings move with a contact merge | ✅ tested |

## 5. Encryption impact

| Item | Impact |
|---|---|
| New encrypted fields | None. `identity_documents.number_encrypted` (registered since E2) is now written by the API |
| Writes | One seal and one keyed hash per document create or number correction (cached company key) |
| Reads | Lists never decrypt; they return `numberLast4` only |
| Reveal | Unchanged (E4) |
| Duplicate lookup | Keyed hash only (`identity_number` purpose); never plaintext |

## 6. Audit impact

| Action | Metadata |
|---|---|
| `requirement.created` / `requirement.updated` | contact, type, status, currency, number of areas / field changes |
| `requirement.listing_excluded` / `requirement.listing_restored` | listing, reason |
| `contact.identity_document_added` / `_updated` / `_archived` | document id, type, country; number changes shown as `[protected]`; confirmed duplicate candidates |
| `kyc.check_recorded` / `kyc.check_updated` | check id, type, status, document |
| `kyc.check_verified` / `kyc.check_failed` | check, type, risk rating, reason, document, whether the reviewer also recorded the check |

Outbox events: `requirement.created`, `requirement.updated`, `kyc.check_decided`.

## 7. Performance results

`requirements.performance.test.ts`: one company, 40,000 listings (19,984 published) on 20,000 units around Accra, 50,000 contacts each with a requirement (no area, locality, radius or drawn shape), 50,000 identity documents and 50,000 KYC checks. Requests through the full API as owner and as agent.

| Measure | Before optimisation | Final |
|---|---|---|
| Requests | 90 | 90 |
| Median | 73 ms | **33 ms** |
| p95 (target < 1,000 ms) | 9,122 ms ❌ | **774 ms** ✅ |
| Requirements register, 50 rows | 9,100 ms | 815 ms |
| Requirements register, 100 rows, sorted | 14,805 ms | 1,401 ms (slowest request) |
| Matches for one requirement (exact total) | 304 ms | 113 ms |
| Sellers view (contacts with identity status) | 1,386 ms | 608 ms |
| Identity documents / KYC checks of a contact | 36 / 26 ms | 17 / 24 ms |
| Record a document (encryption + duplicate lookup over 50,000) | 77 ms | 93 ms |

The slowest single request (a 100-row register page) is above 1 s; the p95 target is met. Risk C2-R1 (§8) covers it.

## 8. Decisions taken in C2 (for confirmation)

| # | Decision | Reason |
|---|---|---|
| C2-D1 | Property type and maximum bedrooms rank matches; they do not exclude listings | Decision D4 lists the must-match fields; these were not among them |
| C2-D2 | Rent is compared per period (annual and monthly rents match the same budget) | Common in Ghana and Qatar where rent is quoted yearly |
| C2-D3 | Lists show at most 100 matches per requirement ("100+"); the matches screen gives the exact total | Keeps the Buyers view fast at scale |
| C2-D4 | The same person may record and sign off a KYC check; the audit entry records when they did | Small agencies may have one approver. **Alternative:** enforce four-eyes (recorder cannot sign off) |
| C2-D5 | A verified identity check also verifies its document; verified documents and signed-off checks are never changed (archive or record a new one) | AML evidence |
| C2-D6 | An identity number already on another contact is reported as a possible duplicate and can be confirmed; on the same contact it is refused | Same rule as C1 duplicates: no automatic merges |
| C2-D7 | KYC uses each KYC permission's own scope; decision D1 does not extend to KYC | Identity data is more sensitive than contact details |
| C2-D8 | Matches only include listings the member may view | No widening of listing access |

## 9. Risks and open items

| Item | Status |
|---|---|
| C2-R1: a 100-row register page takes about 1.4 s at 50,000 requirements and 20,000 published listings | Low. p95 met; default page is 50 (≈0.8 s). Option if needed: precompute requirement areas as geometry |
| "Send to client" from a match (B-2) | Needs the activity timeline: C3 |
| Scanned copies of identity documents | Documents module (Phase 10); the column exists |
| Seller identity gate for publishing (#18) | Needs the ownership API (LL-1); setting stays fail-closed |
| Renewal reminders for expiring documents and checks | Notifications (Phase 12); status already reads "expired" |
| Data-subject requests and erasure | Encryption stage E6 |
| Free-text notes on requirements and checks (R-3 / WR-1) | Accepted; tracked in #35; field help says not to record ID or bank numbers |

## 10. GitHub references

| Reference | Link |
|---|---|
| C1 report | `docs/phase-5/P5-C1-CONTACTS-REPORT.md` |
| Wireframes (#8, closed) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/8 |
| Field encryption (#17) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/17 |
| Seller identity for publishing (#18) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/18 |
| Sensitive-data detection (#35) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/35 |
| Branch | `phase-5/preparation` |
| C2 commit | `8439a5f` |
| CI run 68 (green) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/actions/runs/41601465480 |
