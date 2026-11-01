# Phase 5 Readiness Report (CRM)

| | |
|---|---|
| Date | 1 November 2026 |
| Branch | `phase-4/property-management` (pull request #16) |
| Sources | [Stabilisation Plan](../phase-4/PHASE-4-STABILISATION-PLAN.md) §9 and §11, [Consolidated Status Report](../phase-4/PHASE-4-CONSOLIDATED-STATUS-REPORT.md) §3–§12, Pre-Phase 4 Compliance Audit (`audit/pre-phase-4`, `docs/audits/PRE-PHASE-4-COMPLIANCE-AUDIT.md`), [CI Root Cause Investigation](../phase-4/CI-ROOT-CAUSE-INVESTIGATION.md), GitHub issues and branch settings as read on 1 November |
| **Recommendation** | **NO-GO.** Branch protection on `main` is not active, and three conditions from the Stabilisation Plan exit criteria are still open (§7) |

## 1. Gate status checklist

| # | Gate | Status | Evidence |
|---|---|---|---|
| G1 | CI passes 10 consecutive runs | ✅ Met | Runs 37–46 on `8ee5fd8` (IDs 41148051904 → 41149661990), then the push of `a04a277` (41151070641) and the pull request run (41156657083): 12 consecutive green runs |
| G2 | Browser tests pass 5 consecutive runs | ✅ Met | Every run from 37 onward: 55 of 55 expected, 0 unexpected, 0 flaky |
| G3 | Critical vulnerabilities resolved | ✅ Met | No critical advisories. High ones fixed (zod 4.6.7, NestJS 12.3.2 / multer 2.5.0, postcss 8.5.32). One minimatch advisory (development tooling only, no fixed release) accepted in `osv-scanner.toml` until 2026-12-31. `pnpm audit --prod`: none |
| G4 | IS-3 exists and is assigned | ✅ Met | #13, Critical, assigned to @jtechstudio2-png, Phase 7 and 9 |
| G5 | Branch protection active on `main` | ❌ **Not met** | GitHub reports `main` as `protected: false`, and pull request #16 as mergeable ("clean") with **0 approvals**. With the requested rules in force it would read "blocked" |
| G6 | Root cause recorded (Plan §11.2) | ✅ Met | CI Root Cause Investigation Report, approved |
| G7 | Secret and dependency scanning (Plan §11.5–6) | ✅ Met | gitleaks and OSV-Scanner jobs green on every run; Dependabot configured. They become *required* only with G5 |
| G8 | Identity provider decided, or start without it explicitly accepted (Plan §11.7) | ❌ **Open** | #6 open; evaluation started (§3); no acceptance recorded |
| G9 | Risk register re-rated with owners and targets; remaining Critical items accepted (Plan §11.9) | 🟡 Partly met | Every Critical and High item now has an issue, priority, owner and target phase (§2). **Your acceptance of the three remaining Critical items (#6, #13, #21) is not yet recorded** |
| G10 | Phase 4 pull request open, reviewed and merged, or review scheduled with a date (Plan §11.10) | 🟡 Partly met | #16 open, CI green, mergeable; no review and no review date |
| G11 | No business features added during stabilisation (Plan §11.11) | ✅ Met | Stabilisation commits change CI, tests, dependencies, scanning configuration, one CSS accessibility fix and documentation only |
| G12 | Follow-ups filed: storage timeouts, history ordering | ✅ Met | #14 (High), #15 (Medium) |

### G5: settings to enable, and check names

The requested settings (pull request required, 1 approval, dismiss stale approvals, branch up to date, no force pushes, no deletion) are correct. **Four of the requested check names do not exist.** A required check that never reports blocks every pull request permanently. Select these exact names:

| Requested name | Exact check name |
|---|---|
| Database migrations and SQL tests | `Database migrations and SQL tests` |
| API lint, typecheck, build and tests | `API lint, typecheck, build and tests` |
| Web lint, typecheck, build and tests | `Web lint, typecheck, messages, unit tests and build` |
| Web end-to-end tests | `Web end-to-end (Playwright, axe, English and Arabic, 320 px to desktop)` |
| Gitleaks | `Secret scanning (gitleaks)` |
| OSV-Scanner | `Dependency scanning (OSV-Scanner)` |

If a ruleset is used, its enforcement must be **Active** (not "Evaluate"), and it must target `main` (or the default branch).

## 2. Open blockers (Critical and High)

Every item below has an issue, a priority label, an owner and a target phase. The owner is @jtechstudio2-png, the only collaborator, until work is delegated.

### 2.1 Before CRM starts

| Issue | Item | Priority | Target | What closes it |
|---|---|---|---|---|
| — | Branch protection on `main` (G5) | Critical (gate) | Now | Settings change by the repository owner |
| #6 | Identity-provider vendor | Critical | Phase 5 | Decision, **or** your written acceptance to develop Phase 5 against the test provider (blocks any shared environment) |
| #8 | Phase 5 wireframes: admin dashboard layout, agent desktop home | High | Phase 5 entry | Wireframes approved before CRM screens are built (Plan §9 lists it as a Phase 5 entry criterion). Backend work can start first if you accept that order |

### 2.2 First items inside Phase 5 (before the data they protect exists)

| Issue | Item | Priority | Target |
|---|---|---|---|
| #17 | Field-encryption key management (IS-7) | High | Phase 5, **first milestone**: no contact personal data stored before it |
| #18 | Seller identity (KYC) for the listing publish rule | High | Phase 5 |
| #12 | Linked-visibility scope resolver (landlord and tenant portals) | High | Phase 5 to 7 |
| #14 | Explicit S3/R2 client timeouts, retries, metrics | High | Phase 5 |
| #24 | Accessibility: screen reader, WCAG 2.2-only criteria, usability (W-D10) | High | Phase 5, continuing |
| #25 | Arabic native review and translation workflow (IS-10) | High | Phase 5 (before CRM strings multiply) |

### 2.3 Gated to later phases (do not block CRM)

| Issue | Item | Priority | Target |
|---|---|---|---|
| #13 | IS-3 statement integrity and ledger finalisation | Critical | Before Phase 7 and 9 |
| #1, #2, #3 | A1–A3 money integrity | High (Critical before Phase 7) | Before Phase 7 |
| #22 | Database test gaps (IS-11) | High | Before Phase 7 |
| #23 | Legal and finance reference data (MD-7) | High | Before Phase 7 and 9 |
| #19 | Support-access grant enforcement (IS-6) | High, launch blocker | Phase 14, or before any production data |
| #21 | Penetration test (portal review in Phase 7) | Critical before launch | Phase 15 |
| #20 | Data residency legal confirmation | High, launch blocker | Raise now; settled before Phase 16 |
| #26 | Monthly audit-log partition job | High | Phase 16 |
| #27 | Load testing | High, launch blocker | Phase 16 |
| #28 | Infrastructure, delivery pipeline, observability | High, launch blocker | Phase 16 |

Changes made on 1 November so the register is complete: filed #17–#28. Assigned #12, which had no owner. Labelled #6 Critical and Phase 5. Added a Phase 5 target to #14. Re-labelled #8 from Medium to High to match the Consolidated Status Report.

## 3. Identity-provider decision status (#6)

| | |
|---|---|
| State | **Evaluation in progress, no decision** |
| Done | Requirements R1–R12 derived from existing code, weighted criteria, shortlist and proof plan (`docs/decisions/IDP-EVALUATION.md`) |
| Shortlist | Auth0 and Microsoft Entra External ID first, Zitadel Cloud third; Cognito listed; Keycloak as a self-hosted fallback (contradicts ADR-001) |
| Not done | No trial tenants; none of the six proof steps run; no scores; no data-residency confirmation (ties to #20) |
| Needs from you | Vendor trial accounts in an EU region (about 1 engineer-day per vendor), and the decision owner |
| Effect on Phase 5 | Local development and CI use the test provider in `apps/web/e2e/support/idp.ts`, so CRM code is not blocked technically. No shared environment (staging or production) can exist until #6 closes |

## 4. Open security items

| Issue | Item | Priority | Target |
|---|---|---|---|
| — | Branch protection off: scanning and test gates are advisory, not enforced | Critical (gate) | Now |
| #6 | Identity provider; production MFA and refresh-rotation behaviour unverified | Critical | Phase 5 |
| #21 | No penetration test | Critical before launch | Phase 15 (portals in Phase 7) |
| #17 | Field-encryption key management | High | Phase 5, first |
| #18 | Seller KYC | High | Phase 5 |
| #12 | Portal linked visibility; portal RLS as defence in depth (S-9) | High | Phase 5 to 7 |
| #19 | Support-access enforcement | High | Phase 14 / before production data |
| #20 | Data residency | High | Before Phase 16 |
| — | minimatch GHSA-g3hv-75wg-m249 (development tooling only) | Accepted | Re-check by 2026-12-31 (`osv-scanner.toml`) |

Closed since the Consolidated Status Report: S-2 zod advisory, S-4 postcss advisories, multer advisory, S-5 no scanning (gitleaks, OSV-Scanner and Dependabot in place; the gates become enforced with G5).

## 5. Open audit items (Pre-Phase 4 Compliance Audit)

| Finding | Issue | Priority | Target |
|---|---|---|---|
| A1 / R-1 posted rent charges | #1 | High | Phase 7 |
| A2 / R-2 payment below allocations | #2 | High | Phase 7 |
| A3 / R-2 void with live allocations | #3 | High | Phase 7 |
| IS-3 / R-4 statement lines freeze | #13 | Critical | Phase 7 and 9 |
| A4 / IS-2 / R-3 document-version purge | #4 | Medium | Phase 10 |
| P1–P3 / R-7 landlord visibility | #5 | Medium | Phase 6 |
| IS-6 support access | #19 | High | Phase 14 |
| IS-7 key management | #17 | High | Phase 5 |
| IS-10 localisation | #25 | High | Phase 5 |
| IS-11 / V-9 database tests | #22 | High | Phase 7 |
| MD-1 platform consoles | #11 | Medium | Phase 14 |
| MD-2 / MD-3 Phase 5 wireframes | #8 | High | Phase 5 entry |
| MD-4 technician and landlord wireframes | #9, #10 | Medium, Low | Phases 7, 8 |
| MD-7 / V-1 / V-2 legal and finance data | #23 | High | Phases 7, 9 |
| V-3 data residency | #20 | High | Before Phase 16 |
| V-6 / V-8 load and NFR targets | #27 | High | Phase 16 |
| C1 identity provider | #6 | Critical | Phase 5 |
| IS-4 lifecycle transitions (application-only) | — | Medium | Tracked in the status report (TD-9); not Critical or High |
| IS-9 portal authentication default | — | Medium | Decide before Phase 7 |
| R-5 `deals.stage_class` sync on `deal_type` change | — | Not rated | Phase 6 |
| MD-6, MD-8 reference data | — | Low, Medium | Phases 12, 14 |
| MD-5, IS-5, MD-9, MD-10 | — | Resolved | — |

The audit branch `audit/pre-phase-4` remains unmerged, as instructed; pull request #16 does not contain it.

## 6. Stabilisation Plan exit criteria (§11)

| # | Criterion | Status |
|---|---|---|
| 1 | CI green 10 consecutive runs **and branch protection requires it** | 🟡 Green ×12; protection missing |
| 2 | Root cause recorded | ✅ |
| 3 | Browser tests 5 consecutive runs; performance on a schedule | ✅ |
| 4 | No open high or critical production advisories | ✅ |
| 5 | Secret scanning baseline and required gate | 🟡 Baseline clean, gate green; "required" needs G5 |
| 6 | Dependabot and required dependency gate | 🟡 Configured, gate green; "required" needs G5 |
| 7 | Identity provider decided or start explicitly accepted | ❌ |
| 8 | IS-3 filed and scheduled before Phase 7 | ✅ #13 |
| 9 | Risk register with owners and dates; Critical items accepted | 🟡 Register complete; acceptance pending |
| 10 | Phase 4 pull request reviewed and merged, or review dated | 🟡 #16 open, no review date |
| 11 | No new business features during stabilisation | ✅ |

## 7. Recommendation

**NO-GO for CRM today.**

The recommendation changes to **GO** when all of these hold:

1. **Branch protection active on `main`** with the six exact check names in §1. Verified when pull request #16 reads "blocked" until it has an approval.
2. **#6:** a vendor decision, **or** your written acceptance to build Phase 5 against the test identity provider, with no shared environment until #6 closes.
3. **Critical-risk acceptance:** a recorded acceptance that #13 (before Phase 7), #21 (before launch) and #6 (as in point 2) remain open while Phase 5 runs.
4. **Pull request #16:** a review date set (or the review done). Phase 5 should branch from `main` after #16 merges, so CRM is not stacked on unreviewed code.
5. **Phase 5 ordering agreed:** #8 wireframes approved before CRM screens, and #17 key management delivered before any contact personal data is stored.

Points 2–5 need decisions, not engineering. Point 1 is a settings change by the repository owner. No CRM code has been written.
