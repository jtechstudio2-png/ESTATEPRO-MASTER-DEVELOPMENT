# Phase 5 · Milestone report: P5-H Phase 5 completion (ownership records, seller identity #18, storage limits #14)

| | |
|---|---|
| Date | 7 November 2026 |
| Branch | `phase-5/preparation`, commits `d5751bf` (#14), `91a0b08`, `193e00d` (ownership, #18), `5358071`, `249c772` (browser tests); CI run 95 |
| Approvals | G3 decisions G3-D1 to G3-D8 approved before work started; the data-subject request register is approved |
| Scope | The open Phase 5 items: ownership records (property "Ownership" tab and LL-1 "add ownership", both in the approved designs), the seller identity publish rule (#18), and explicit timeouts and retries on object storage (#14). No other new features |
| Result | **P5-H complete.** Results in §3; CI run 95 green (§10) |

## 1. Deliverables

### 1.1 Database (migration 0028)

| Change | Purpose |
|---|---|
| `property_ownerships`: `created_by`, `ended_by`, `ended_at`, `end_reason` | Who recorded an ownership, and who ended it, when and why |
| Guard trigger | What is owned, by whom (except a contact merge), the share, the type and the first day never change. A record is ended once (last day, who, why), never re-dated. Evidence can be attached once |
| `DELETE` revoked from the runtime role | Ownership records are history; they are ended, not deleted |
| `app.unit_current_owners(unit)` | Current owners of a unit (whole-property records and the unit's own), judged in the property's time zone with the same rule as the landlord resolver (#12) |
| Rule definition `listing_owner_identity_required` (boolean, default off) | #18: a jurisdiction can require verified owners before publishing. No jurisdiction value is set until the legal review (#20) |

### 1.2 API

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /api/v1/properties/{id}/ownerships` | property.view (record scope) | Current records first, then ended ones. The owner is named only when the member may see the contact (`contact.view` scope); their identity status only with `kyc.view` on the contact. `canManage` tells the screen whether to offer changes |
| `POST /api/v1/properties/{id}/ownerships` | property.update on the property; the owner must be a contact the member can see | Whole property or one unit; type; share; first day (not in the future, in the property's time zone). Refused for an archived property or unit, and for an archived, merged or erased contact. Shares of one type for the same unit (or the whole property) add up to at most 100 %; an owner cannot hold two open records of one type in one place. Idempotency key supported. Audited (`property.ownership_added`) |
| `POST /api/v1/property-ownerships/{id}/end` | property.update | Last day (after the first, not in the future) and a reason. Once only. Audited (`property.ownership_ended`) |
| Listing publish checklist (`publish`, readiness) | (unchanged) | #18, see §1.4 |
| Object storage (all media, export, erasure and worker calls) | — | #14, see §1.5 |

### 1.3 Web

| Screen | Design |
|---|---|
| Property record: new **Ownership** tab: current owners (owner, covers, share, type, from, until, identity status with "Check identity"), past owners with who ended them and why, "Add ownership", "End ownership" with last day and reason | Phase 3 IA "Ownership records"; property tabs (03 §2) |
| **Add ownership** form: owner (contact search, or the contact it was opened from), property (search, or the property it was opened from), whole property or one unit, type, share, first day | LL-1 "add ownership" |
| Contact **Properties** tab (LL-1): "Add ownership" | LL-1 |
| Listing publishing checklist: "No owner recorded" links to the property's Ownership tab; "Owner identity not verified" (one per owner) links to that owner's Identity tab | L-5 |
| Listing rules: the identity setting now reads "Every current owner's identity must be verified before publishing", and says a country's rules can also require it | L-10 |

All new text is in English and Arabic (2,570 keys in both).

### 1.4 Seller identity publish rule (#18)

| Item | Behaviour |
|---|---|
| When it applies | The company setting is on, **or** the jurisdiction rule `listing_owner_identity_required` is true for the property's jurisdiction (or its parent) on the day. Company and office settings cannot switch off a jurisdiction requirement |
| Who must be verified | Every current owner of the listed unit: whole-property owners and the unit's own owners, current today in the property's time zone. Ended and future records do not count |
| What "verified" means | The latest check of the kind that applies is verified and not past its expiry: `identity` for a person, `company_ownership` for an organisation. A newer pending or failed check replaces an older verified one (the Identity tab's reading). An erased contact is never verified |
| Fails closed | No current owner → `sellerKyc` / `no-owner`. Each unverified owner → `sellerKyc.<contact id>` / `unverified`. Unknown status counts as unverified |
| Rule off | Behaviour unchanged (tested) |

### 1.5 Object storage limits (#14)

| Item | Behaviour |
|---|---|
| Limits | Connection timeout `STORAGE_CONNECT_TIMEOUT_MS` (default 3 s), request timeout `STORAGE_REQUEST_TIMEOUT_MS` (default 30 s; the request now fails instead of only warning), attempts `STORAGE_MAX_ATTEMPTS` (default 3, standard retry with back-off and jitter, retry-safe errors only) |
| Failure | Every head, read, write and delete failure becomes a `StorageError` with the operation, outcome (`timeout`, `retry_exhausted`, `client_error`) and attempts. Logged with these fields only |
| Metrics | Calls, outcomes, retries and latency (total, maximum) per operation, in process; shipping them to monitoring comes with #28 |
| API answer | An outage answers 503 `storage-unavailable` ("File storage is not answering right now. Try again in a few minutes."); a misconfiguration (4xx from the store) answers 500 |
| Worker | The job is released for a later retry with the error recorded; work done in the same transaction is rolled back (tested with export expiry) |

## 2. Requirement checklist

| Requirement | Where | Status |
|---|---|---|
| #14: explicit connection and request timeouts | `media/storage.ts`, config | ✅ |
| #14: retries bounded, retry-safe errors only | standard retry mode, `STORAGE_MAX_ATTEMPTS` | ✅ |
| #14: fails predictably within the bound (stalled, refused, unroutable, 5xx, 4xx) | `storage-limits.test.ts` | ✅ |
| #14: callers get a typed error; the API answers 503; the worker retries | problem filter, worker test | ✅ |
| #14: metrics per operation and outcome | `StorageMetrics` | ✅ |
| #18: link listings to owner contacts | ownership records → current owners of the listed unit | ✅ |
| #18: KYC status, evidence and verifier | existing identity checks (C2): status, documents, reviewer | ✅ |
| #18: wire the publish rule, fail closed when status is unknown | publish checklist | ✅ |
| #18: per-jurisdiction setting, not hard-coded | `listing_owner_identity_required` | ✅ |
| #18: blocked without a verified owner; allowed when verified; unchanged when off | API and browser tests | ✅ |
| Ownership tab and LL-1 "add ownership" (approved designs) | web | ✅ |
| Ownership history kept and audited | migration 0028, audit actions | ✅ |

## 3. Tests

| Suite | Tests | Result |
|---|---|---|
| `database/tests/11_ownership_records_p5h.sql` (current owners, inclusive end date, end once, history not rewritten, no deletes, merge repoint, isolation, rule definition off) | 17 assertions | ✅ |
| `api/test/storage-limits.test.ts` (stalled endpoint for all four operations, refused, unroutable, 5xx retried, 4xx not retried, 503/500 answers, classification) | 6 | ✅ |
| `api/test/worker.test.ts` (new: storage outage releases the job for retry and rolls back its work) | 5 (1 new) | ✅ |
| `api/test/ownerships.e2e.test.ts` (add, list, identity status, validation, shares, end, scopes, isolation; #18 rule off, no owner, partial and full verification, organisations, expiry, superseded check, erased owner, ended owner, jurisdiction rule) | 8 | ✅ |
| Full API suite (`test:ci`) | 480 in 39 files | ✅ |
| `web/e2e/ownership.spec.ts` (Ownership tab, LL-1 add then end, #18 checklist links, agent without the owner contact, Arabic) | 5 | ✅ |
| Full end-to-end suite (incl. sweep with the Ownership tab and the add form in English and Arabic, desktop and 320 px) | 94 | ✅ |
| Web unit tests (new: checklist links) | 79 | ✅ |
| Lint, typecheck, message check (2,570 keys in both languages), OpenAPI and web types regenerated | — | ✅ |

API coverage: 95.94 % statements, 90.48 % branches, 98.40 % functions, 98.19 % lines (thresholds 95/90 met). Web coverage: 98.14 % statements, 91.41 % branches.

### 3.1 Defects found and fixed before the milestone closed

| Defect | Found by | Fix |
|---|---|---|
| A stalled store kept requests waiting: the storage client only logged a warning when the request timeout passed | Outage probe | `throwOnRequestTimeout`; the call now fails at the bound |
| `sharePercent` appeared untyped in the OpenAPI document | Web typecheck | Typed as a nullable number |
| The P-7 browser test (property types) could run its accessibility check before the page title was back after a filter change | Full browser suite | The test waits for the title (WCAG 2.4.2) before the check |

Note: the key-rotation worker test can exceed its 20 s limit when the API performance suites run in the same database first (the worker then works through their 20,000-contact companies). CI runs them separately (`test:ci` excludes them), as before.

## 4. Security validation

| Check | Result |
|---|---|
| Ownership needs property.view to read and property.update (record scope) to change | ✅ API test |
| An owner contact the member cannot see is not named, and cannot be chosen (answered as "not found", no existence leak) | ✅ API and browser tests |
| Identity status is shown only with kyc.view on the owner contact | ✅ API test |
| Another company's properties, records and contacts are invisible and unusable | ✅ SQL and API tests |
| Ownership history cannot be rewritten or deleted by the runtime role | ✅ SQL suite 11 |
| The publish rule fails closed (no owner, no check, pending, failed, expired, erased) | ✅ API test |
| A company setting cannot relax a jurisdiction requirement | ✅ API test |
| Storage errors log the operation, outcome, attempts, duration and error name only (no keys, URLs or credentials) | ✅ code review |

## 5. Encryption impact

None. No new protected values; ownership records hold ids, shares and dates. The checklist names owners by contact id only, never by name, because listing editors may not be allowed to see the contact.

## 6. Audit impact

New audit actions: `property.ownership_added` (ownership id, unit, owner contact id, share, type, first day) and `property.ownership_ended` (last day, reason). Both also emit `property.ownership_changed` to the outbox. Publishing remains audited as `listing.published`.

## 7. Performance results

Playwright performance spec (budget: ready and LCP 4,000 ms, script 300 KB):

| Screen | Ready | LCP | Script |
|---|---|---|---|
| Property Ownership tab | 292 ms | 228 ms | 241 KB ✅ |
| Add ownership | 195 ms | 88 ms | 242 KB ✅ |
| Contact record (C-2), unchanged | 290 ms | 236 ms | 260 KB ✅ |

The ownership list is one query on `property_ownerships_property_idx`; the publish check adds one call to `app.unit_current_owners` and one identity query, only when the rule applies.

## 8. Decisions taken in P5-H (for confirmation)

| # | Decision | Reason |
|---|---|---|
| H-D1 | Seller identity is required when the company setting is on **or** the jurisdiction rule says so; a company cannot switch off a jurisdiction requirement | #18 asks for per-jurisdiction settings; a legal requirement must not be relaxed by a company |
| H-D2 | The rule covers every current owner of the listed unit (whole property and unit records), for sales and lettings | #18 says "seller/landlord"; joint owners all sign |
| H-D3 | "Verified" is the latest identity check (person) or ownership check (organisation), verified and not expired | The same reading as the contact's Identity tab; an organisation proves who owns and controls it, not a personal identity |
| H-D4 | Ownership records are added and ended, never edited or deleted; the end date is the last day of ownership | Ownership is history (sales, transfers); matches the landlord resolver (#12) |
| H-D5 | Ownership cannot start or end in the future | A record states what is true; future transfers are recorded when they happen |
| H-D6 | Shares of one ownership type for the same unit (or the whole property) add up to at most 100 % | Catches double entry; legal and beneficial ownership are counted separately |
| H-D7 | The jurisdiction rule `listing_owner_identity_required` is off everywhere until the legal review (#20) | No legal rule is activated without review |
| H-D8 | Storage defaults: connect 3 s, request 30 s, 3 attempts; outages answer 503 `storage-unavailable` | Fails within about 100 s in the worst case for the largest upload; configurable per environment |

## 9. Risks and open items

| Item | Status |
|---|---|
| Jurisdiction values for the owner identity rule | Legal review (#20) |
| Storage metrics to monitoring | With observability (#28) |
| Evidence documents on ownership records | The column exists; attaching files comes with the documents module |
| Arabic native-speaker review (#25) | Open, pre-launch; the new Arabic strings are included |
| Manual screen-reader pass (#24) | Open, pre-launch |

## 10. GitHub references

| Reference | Link |
|---|---|
| G3 report | `docs/phase-5/P5-G3-DATA-SUBJECT-REQUESTS-REPORT.md` |
| Issues | #14 (storage limits), #18 (seller identity) |
| Branch | `phase-5/preparation` |
| Commits | `d5751bf` (#14), `91a0b08`, `193e00d` (ownership records, #18), `5358071`, `249c772` (browser tests) |
| CI run 95 (green, on `0589ffc`; runs 91, 93 and 94 were cancelled by later pushes; run 92 failed in the browser tests fixed in `5358071` and `249c772`) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/actions/runs/42342621124 |

## Approval

Product owner, 7 November 2026: **P5-H approved; H-D1 to H-D8 approved. Phase 5 planned work is approved as complete.** Issue #20 (legal review) remains required before any jurisdiction rule is activated, including `listing_owner_identity_required`. Issues #24 (accessibility verification) and #25 (Arabic native-speaker review) remain pre-launch requirements. A Phase 5 consolidated completion report is to be reviewed before major Phase 6 work begins.
