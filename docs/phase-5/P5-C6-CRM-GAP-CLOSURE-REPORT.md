# Phase 5 · Milestone report: C6 CRM gap closure

| | |
|---|---|
| Date | 5 November 2026 |
| Branch | `phase-5/preparation`, commit `c76daf4`; CI run 78 green |
| Approvals | C5 decisions C5-D1 to C5-D8 approved before work started; #25 (Arabic native-speaker review) kept open as a pre-launch requirement |
| Scope | The gaps C5 left against the approved wireframes (#8): the Sellers, Landlords and Buyers columns that need per-contact summaries (SE-1, LL-1, B-1), the company-wide "Identity checks" queue (SH-1), API text that was English-only on translated screens, and loosely typed request bodies in the OpenAPI document. No new features beyond the approved wireframes |
| Result | **C6 complete.** Every summary and the queue are limited to what the viewer may see; no protected value is added anywhere; the web app no longer needs type casts for API bodies. Results in §3; CI run 78 green (§10) |

## 1. Deliverables

### 1.1 API

| Change | Wireframe | Notes |
|---|---|---|
| Contact register rows gain `nextFollowUp` (every view), `listings` (Sellers and Landlords views), `valuationLead` (Sellers view) and `properties` (Landlords view) | SE-1, LL-1, C-1 | Computed for the rows of one page only (`contacts/contact-summaries.ts`). Optional fields appear only in the views that use them |
| Requirements register rows gain `nextFollowUp` | B-1 "Next" | The per-contact requirement list is unchanged |
| `GET /api/v1/kyc-checks`: open checks (pending, in review) oldest first by default; filters `status`, `checkType`, `expiring` (verified checks due for renewal within 30 days); cursor paging | SH-1 "Identity checks" | `kyc.view`, by ownership and office (the same rule as the contact's Identity tab) |
| Landlord preview gains `notVisibleCodes`; merge preview gains `blockerDetails` (`code`, `message`, `records`) | LL-1, C-4 | The English text stays for API consumers; screens translate the codes |
| The admin dashboard's "identity checks expiring" item now links to the queue | D-A | |
| OpenAPI: 23 request fields that were typed as a generic object now have their real types (text, number, identifier); merge field choices, activity paging and export parameters are described exactly | — | No behaviour change; validation was already exact |

### 1.2 Web

| Change | Wireframe |
|---|---|
| Sellers view: Identity check, Listings (latest listing, published or not, "+N more"), Valuation lead, Next follow-up (⚠ "None scheduled" when there is none) | SE-1 |
| Landlords view: Listings, Properties, Next follow-up | LL-1 |
| Contact register (all views) and requirements register: Next follow-up | C-1, B-1 |
| `/identity-checks`: Open, Due for renewal, Verified, Failed, Expired; check-type filter; each row opens the contact's Identity tab, where decisions are taken. Menu item "Identity checks" for members with `kyc.view` | SH-1 |
| Landlord preview "not visible" list and merge blockers in the member's language | LL-1, C-4 |
| The four type casts for API bodies are gone; the tighter types caught two real gaps (stored requirement areas sent back with `null` members; lead type held as plain text), both fixed | — |

## 2. Requirement checklist

| Requirement | How it is met | Evidence |
|---|---|---|
| Encryption controls | No new encrypted fields; the queue shows only the last four characters of a document number, as the Identity tab does | API test checks the queue never carries phone, tax or document numbers |
| Reveal controls | Unchanged. Reveal stays on the Identity tab (C-5) with reason and step-up | C5 tests still green |
| Tenant isolation | Row-level security on every query; the queue of another company is empty | API test "is closed to members without kyc.view and to other companies" |
| Scope of summaries | Each summary counts only records the viewer may see: follow-ups by the task rules, leads by lead scope, listings by listing scope, properties by property scope. Without the permission the value is null, never zero | API test "counts only what the viewer may see" (Kumasi listing hidden from the Osu manager; a follow-up assigned to someone else hidden from the agent; the accountant gets null) |
| Audit integrity | Read-only additions; no new writes | — |
| Accessibility | New columns and the queue in the axe sweep, English and Arabic, desktop and 320 px | Sweep |
| Performance budgets | Summaries add about 10 ms per page; all 17 measured screens within budget | §7 |

## 3. Tests

| Suite | Tests | Result |
|---|---|---|
| `api/test/crm-c6.e2e.test.ts` (summaries and their scope, B-1 next follow-up, queue scope and filters, isolation, codes) | 6 | ✅ |
| Full API suite (`test:ci`) | 443 in 34 files | ✅ |
| `web/e2e/crm-contacts.spec.ts` (new: Sellers and Landlords columns; identity-check queue; verified check leaves the open queue) | 15 | ✅ |
| Full end-to-end suite (Playwright, with axe sweep and performance) | 83 | ✅ |
| Web unit tests (navigation and run-time message keys extended) | 75 in 17 files | ✅ |
| Lint, typecheck, message check (2,352 keys in both languages), OpenAPI regenerated | — | ✅ |

API coverage: 97.04 % statements, 91.6 % branches, 98.48 % functions, 99.24 % lines. Web coverage: 98.14 % statements, 91.41 % branches, 97.87 % functions, 99.4 % lines. Thresholds 95/90 met.

### 3.1 Defects found and fixed before commit

| Defect | Found by | Fix |
|---|---|---|
| Stored requirement areas were sent back with `null` members the API does not accept in that place | Tighter OpenAPI types | Absent members are omitted |
| The lead form held the lead type as free text | Tighter OpenAPI types | Typed as the API's lead types |

## 4. Security validation

| Check | Result |
|---|---|
| A summary never reveals a follow-up, lead, listing or property outside the viewer's scope | ✅ tested |
| Agents see identity checks only of contacts they own, not of contacts behind their leads | ✅ tested |
| The accountant reads every check but cannot decide | ✅ tested |
| Members without `kyc.view` get 403 from the queue and see no menu item | ✅ tested (API and navigation unit test) |
| Another company's queue is empty | ✅ tested |

## 5. Encryption impact

None. No new protected fields, no new reveal paths. The queue carries the same masked document reference as the record.

## 6. Audit impact

None. All C6 changes are reads.

## 7. Performance results

Measured on the same machine in the same session, with and without the C6 code:

| Measure | Without C6 | With C6 |
|---|---|---|
| Sellers view, 50,000 contacts (requirements performance test, max) | 619 ms | 635–771 ms |
| Requirements register (max) | 423 ms | 407–434 ms |
| Requirements and KYC test, p95 (target < 1,000 ms) | 612 ms | 607–635 ms ✅ |
| Contact register test, p95 (target < 1,000 ms) | — | 363 ms ✅ |

Screens (Playwright performance spec; budget: ready and LCP 4,000 ms, script 300 KB):

| Screen | Ready | LCP | Script |
|---|---|---|---|
| Sellers view (SE-1), new columns | 448 ms | 116 ms | 233 KB ✅ |
| Identity checks (SH-1), new | 314 ms | 120 ms | 229 KB ✅ |
| Contact register (C-1), next follow-up column | 468 ms | 152 ms | 233 KB ✅ |
| Admin dashboard (D-A) | 672 ms | 472 ms | 225 KB ✅ |

Timing inside the API showed the summaries take about 10 ms of a page; the rest is the list query itself, unchanged by C6. The machine is slower today than when C2 was measured (sellers view 175 ms then), which is why the absolute figures are higher than in the C2 report.

## 8. Decisions taken in C6 (for confirmation)

| # | Decision | Reason |
|---|---|---|
| C6-D1 | Register summaries count only what the viewer may see, and show "—" (null) rather than zero when the viewer has no access to listings or properties | Counts must not reveal hidden records (wireframes §2.2) |
| C6-D2 | "Next follow-up" covers follow-ups about the contact and about its leads. Buyers and sellers without one are flagged "None scheduled" | B-1 "⚠ no follow-up scheduled for an active buyer"; SE-1 the same for sellers |
| C6-D3 | A seller's or landlord's "Listings" are the open listings (draft, available, reserved, under contract) on units they currently own or we manage for them, found through the #12 landlord resolver | One rule for staff views and the future portal |
| C6-D4 | "Valuation lead" is the latest open sell or valuation lead | SE-1 |
| C6-D5 | The identity-check queue uses `kyc.view` by ownership and office (not through leads), lists open checks oldest first, and offers "Due for renewal" for verified checks expiring within 30 days. Decisions stay on the contact's Identity tab, next to the documents | Same rule as C-5; sign-off needs the evidence in view |
| C6-D6 | The API keeps its English text next to the new codes | API consumers and logs keep readable reasons; screens translate the codes |

## 9. Risks and open items

| Item | Status |
|---|---|
| Arabic native-speaker review | Open, pre-launch requirement (#25); the 40 new Arabic strings of C6 are included |
| Manual screen-reader pass | Open (#24) |
| Lead score rule names come from company settings | Shown as entered; scoring rules arrive later (D7) |
| Deals, viewings and conversion | Phase 6 |

## 10. GitHub references

| Reference | Link |
|---|---|
| C5 report | `docs/phase-5/P5-C5-CRM-WEB-SCREENS-REPORT.md` |
| Wireframes (#8) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/8 |
| Portal visibility (#12) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/12 |
| Screen-reader pass (#24) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/24 |
| Arabic review (#25) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/25 |
| Branch | `phase-5/preparation` |
| C6 commit | `c76daf4` |
| CI run 78 (green) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/actions/runs/42032527528 |
