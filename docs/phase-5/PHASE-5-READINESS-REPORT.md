# Phase 5 Readiness Report (CRM)

| | |
|---|---|
| Date | 1 November 2026 (revision 3, final; revisions 1 and 2 approved the same day) |
| Branch | `phase-4/property-management` (pull request #16) |
| Sources | [Stabilisation Plan](../phase-4/PHASE-4-STABILISATION-PLAN.md) §9 and §11, [Consolidated Status Report](../phase-4/PHASE-4-CONSOLIDATED-STATUS-REPORT.md) §3–§12, Pre-Phase 4 Compliance Audit (`audit/pre-phase-4`, `docs/audits/PRE-PHASE-4-COMPLIANCE-AUDIT.md`), [CI Root Cause Investigation](../phase-4/CI-ROOT-CAUSE-INVESTIGATION.md), GitHub issues and branch settings as read on 1 November |
| **Recommendation** | **GO for CRM**, in the approved order (§7). Branch protection on `main` is active and the owner's review decision for pull request #16 is recorded. Merge #16 first; CRM work branches from `main` |

## Changes since revision 2

| Item | Revision 2 | Revision 3 | Record |
|---|---|---|---|
| Branch protection on `main` | ❌ Not active | ✅ Active: GitHub reports `main` as `protected: true` (checked 1 November, 14:22 UTC) | Owner's settings: pull request required, branch up to date, the six exact checks below, force pushes and deletion blocked |
| Review decision for #16 | ❌ None | ✅ "Review decision (product owner): Approved", with #13 and #21 open as accepted | [#16 comment](https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/pull/16#issuecomment-6559212887) |
| Required approvals | 1 requested | 0, by the owner's choice (option B below): the sole collaborator cannot approve their own pull request | Revisit when a second reviewer joins |

## Changes since revision 1

| Item | Revision 1 | Revision 2 | Record |
|---|---|---|---|
| #6 start without a vendor | Open | ✅ Accepted: CRM may use the test identity provider; no shared environment until #6 closes | [#6 comment](https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/6#issuecomment-6556253555) |
| #13 open until Phase 7 | Not recorded | ✅ Accepted | [#13 comment](https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/13#issuecomment-6556252602) |
| #21 open until pre-launch | Not recorded | ✅ Accepted | [#21 comment](https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/21#issuecomment-6556253039) |
| Phase 5 sequence | Proposed | ✅ Approved: #8 before CRM screens; #17 before contact data; landlord side of #12 within Phase 5 | Comments on [#8](https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/8#issuecomment-6556253892), [#17](https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/17#issuecomment-6556254242), [#12](https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/12#issuecomment-6556254551) |
| Branch protection | Not active | ❌ Still not active (re-checked 1 November, 09:40 UTC) | — |
| Pull request #16 review | None | ❌ Still none; see §1, "Review constraint" | — |

## 1. Gate status checklist

| # | Gate | Status | Evidence |
|---|---|---|---|
| G1 | CI passes 10 consecutive runs | ✅ Met | Runs 37–46 on `8ee5fd8` (IDs 41148051904 → 41149661990), then the push of `a04a277` (41151070641) and the pull request run (41156657083): 12 consecutive green runs |
| G2 | Browser tests pass 5 consecutive runs | ✅ Met | Every run from 37 onward: 55 of 55 expected, 0 unexpected, 0 flaky |
| G3 | Critical vulnerabilities resolved | ✅ Met | No critical advisories. High ones fixed (zod 4.6.7, NestJS 12.3.2 / multer 2.5.0, postcss 8.5.32). One minimatch advisory (development tooling only, no fixed release) accepted in `osv-scanner.toml` until 2026-12-31. `pnpm audit --prod`: none |
| G4 | IS-3 exists and is assigned | ✅ Met | #13, Critical, assigned to @jtechstudio2-png, Phase 7 and 9 |
| G5 | Branch protection active on `main` | ✅ Met | GitHub reports `main` as `protected: true`. Pull request #16 reads "clean" with all six required checks green on `8d9c8e2`. Required approvals set to 0 (sole collaborator; see "Review constraint") |
| G6 | Root cause recorded (Plan §11.2) | ✅ Met | CI Root Cause Investigation Report, approved |
| G7 | Secret and dependency scanning (Plan §11.5–6) | ✅ Met | gitleaks and OSV-Scanner jobs green on every run; Dependabot configured. Required through G5 |
| G8 | Identity provider decided, or start without it explicitly accepted (Plan §11.7) | ✅ Met (accepted) | #6 stays open; CRM uses the test identity provider; no shared environment until it closes |
| G9 | Risk register re-rated with owners and targets; remaining Critical items accepted (Plan §11.9) | ✅ Met | Every Critical and High item has an issue, priority, owner and target phase (§2). #6, #13 and #21 accepted on 1 November |
| G10 | Formal review decision recorded for pull request #16 | ✅ Met | Owner's written decision: Approved ([comment](https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/pull/16#issuecomment-6559212887)) |
| G13 | Phase 5 sequence approved | ✅ Met | #8 → CRM screens; #17 → contact data; landlord side of #12 within Phase 5 |
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

### Review constraint (affects G5 and G10)

The repository has **one collaborator**, @jtechstudio2-png (admin), who is also the author of pull request #16. GitHub does not let an author approve their own pull request. So once "require 1 approval" is on, #16 (and every later pull request) cannot be merged unless one of these is done:

| Option | How | Trade-off |
|---|---|---|
| **A. Add a second reviewer (recommended)** | Invite a developer as a collaborator with write access; they review and approve #16 | Real independent review, which is what the rule is for |
| B. Admin bypass | In a ruleset, add the admin role to the bypass list ("for pull requests only"); in classic protection, leave "Do not allow bypassing" unchecked | The owner can merge without an approval; the review decision is recorded as a written comment on the pull request, not a GitHub approval |

Claude cannot approve or merge pull requests. The formal review decision (approve, request changes, or approve with conditions) has to come from a person.

## 2. Open blockers (Critical and High)

Every item below has an issue, a priority label, an owner and a target phase. The owner is @jtechstudio2-png, the only collaborator, until work is delegated.

### 2.1 Before CRM starts

| Issue | Item | Priority | Target | What closes it |
|---|---|---|---|---|
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
| 1 | CI green 10 consecutive runs **and branch protection requires it** | ✅ Green on every run since 37; required by protection |
| 2 | Root cause recorded | ✅ |
| 3 | Browser tests 5 consecutive runs; performance on a schedule | ✅ |
| 4 | No open high or critical production advisories | ✅ |
| 5 | Secret scanning baseline and required gate | ✅ |
| 6 | Dependabot and required dependency gate | ✅ |
| 7 | Identity provider decided or start explicitly accepted | ✅ Accepted (#6) |
| 8 | IS-3 filed and scheduled before Phase 7 | ✅ #13 |
| 9 | Risk register with owners and dates; Critical items accepted | ✅ |
| 10 | Phase 4 pull request reviewed and merged, or review dated | ✅ Reviewed and approved by the owner; merge pending |
| 11 | No new business features during stabilisation | ✅ |

## 7. Recommendation

**GO for Phase 5 CRM.**

| Condition | Status |
|---|---|
| 1. Branch protection active with the six exact check names | ✅ Active (`main` protected) |
| 2. #6 decided, or test identity provider accepted | ✅ Accepted |
| 3. #13, #21, #6 acceptance recorded | ✅ Recorded |
| 4. Formal review decision for pull request #16 | ✅ Approved by the owner |
| 5. Phase 5 sequence agreed | ✅ Approved |

### Conditions that apply during Phase 5

1. **Merge #16 first.** CRM work branches from `main` after the merge, never from `phase-4/property-management`.
2. **Order of work:** #8 wireframes approved before any CRM screen; #17 key management delivered before any contact data is stored; the landlord side of #12 inside Phase 5.
3. **Identity:** CRM runs on the test identity provider only. No staging or production environment, and no real user accounts, until #6 closes.
4. **Every change through a pull request** with the six required checks green.

### Limits of this verification

- The GitHub tools available here show that `main` is protected, but cannot list the individual rule settings. The check names and options are as the owner configured them. Pull request #16 reads "clean" with all six checks green, which is consistent with those settings.
- Required approvals are 0, so the review is the owner's written decision, not an independent review. Add a second reviewer and set approvals to 1 when the team grows.
