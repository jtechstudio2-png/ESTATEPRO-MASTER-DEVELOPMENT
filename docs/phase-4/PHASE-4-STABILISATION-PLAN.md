# Phase 4 · Stabilisation Plan

**Before Phase 5 (CRM). No new business features until the exit criteria in §11 are met.**

| | |
|---|---|
| Date | 30 October 2026 |
| Branch | `phase-4/property-management` (not merged; the audit branch also stays unmerged) |
| Input | [Phase 4 Consolidated Status Report](PHASE-4-CONSOLIDATED-STATUS-REPORT.md) |
| Scope | CI, test reliability, dependency and secret hygiene, the identity-provider decision, tracking of audit item IS-3, and re-rating of Critical and High risks. Fixes are limited to what these require: no schema changes for business rules and no new screens or endpoints |

## 0. Evidence gathered for this plan

GitHub Actions run history for `.github/workflows/ci.yml` on this branch, runs 1–27:

| Observation | Detail |
|---|---|
| Last green API test step | Run 9 (`8c12064`, documentation only, after the M4 code landed): test step **passed in 120 s** |
| Pattern A: the step completes with a failure | Run 7 (`115060f`, M4): failed after 120 s<br>Run 10 (`83df360`, M5): after 187 s<br>Run 26 (`87189bb`): after 147 s<br>Vitest exited non-zero; the runner stayed healthy (post-steps ran) |
| Pattern B: the step is cut off | Run 20 (`871df11`): step left "in progress"; job ended 164 s after the step began<br>Run 27 (`f5ca548`): the same, after 98 s<br>Post-steps never ran: the runner lost the process, or the runner itself was lost |
| Same code, different results | Runs 7 and 9 test identical application code. The failure is **intermittent**, not a deterministic regression |
| Logs | Not retrievable through the API (HTTP 404); they must be read in the Actions web page or with `gh run view --log` |
| Runner | The repository is **private**, so jobs run on GitHub's standard runner for private repositories: **2 vCPU** and roughly 7–8 GB RAM (to confirm from the run's "Set up job" output) |
| Local reference | Tests pass on a 4 vCPU, 15 GB container: API 288/288; performance tests with photo processing at 2.17 s against a hard 3 s assertion, listing search p95 232 ms against 1 s, clustered map p95 588 ms against 800 ms |
| Other jobs | The SQL, API lint/typecheck/build and web jobs are green on every recent run; `web-e2e` has always been skipped |

**Correction.** The consolidated status report (TD-1) described every failure as the step being cut off about 90 s in. Only runs 20 and 27 show that. Most failures are ordinary test failures. The report has been corrected.

## 1. Priority 1 — Restore GitHub CI

**Goal:** `main` and the Phase 4 branch are protected by a green, deterministic gate.

| Step | Action |
|---|---|
| 1.1 | Do the root-cause analysis in §2 before changing anything |
| 1.2 | Separate **correctness** from **performance**. The blocking job runs the functional suite with coverage. Performance tests move to their own job: on a schedule or manual, non-blocking, with recorded results. Their budgets are recalibrated for the runner they actually use, or the job runs on a larger runner |
| 1.3 | Make CI diagnosable. On every run, whatever the outcome, keep: the vitest JUnit/JSON report as an artifact; a memory and CPU sample (`free`, `docker stats`) taken in the background; and a final `dmesg` check for the out-of-memory killer |
| 1.4 | Give each job an explicit `timeout-minutes` and concurrency group, and wait for service readiness properly: assert SeaweedFS answers (not just `curl` once) and that ClamAV answers PING |
| 1.5 | Turn on branch protection for `main`: required checks (sql, api, web, web-e2e), pull requests required, no direct pushes |

**Success criteria**

- 10 consecutive green runs of the blocking jobs on the same commit. Use re-runs to measure the flake rate, which must be 0 in 10.
- Every failure leaves enough artifacts to diagnose it without reproducing it.

**Estimated effort:** 1.5–2 engineer-days, including §2.

## 2. Priority 2 — Root-cause analysis of the API job failures

### 2.1 Hypotheses (ranked)

| # | Hypothesis | Fits | For | Against or unknown |
|---|---|---|---|---|
| H1 | **Performance assertions fail on the slower runner.** The photo-processing (< 3 s), listing (p95 < 1 s on 100,000 rows) and GIS budgets are hard `expect` calls tuned on 4 vCPU; CI has 2 vCPU. Photo processing at 2.17 s has only 28% headroom, and image processing scales with cores | Pattern A | Intermittent pass and fail on identical code; failures began with M4, when the media performance test arrived; M5 added more budgets | Not yet seen in a log |
| H2 | **Memory exhaustion.** ClamAV (about 1.2–1.5 GB resident, about double while it reloads signatures), Postgres with 100,000-row seeds, SeaweedFS, image processing of 12 MP photos (decoded buffers and libvips cache) and V8 coverage instrumentation, all on a 7–8 GB runner | Pattern B (the process or runner is lost) | Cut-offs appear later, as the suite grew; post-steps never ran | Run 9 passed with the same load; it may sit near the limit |
| H3 | **Hook timeouts while seeding.** `hookTimeout` is 120 s; seeding 100,000 listings (and the GIS fixtures) on 2 vCPU may exceed it | Pattern A | Run 7 failed at exactly 120 s of step time | The step total includes other files, so this may be coincidence |
| H4 | **ClamAV signature reload.** The container refreshes signatures shortly after start. During the reload clamd answers slowly (scan timeout makes the test fail) and memory roughly doubles (feeding H2) | A and B | The CI wait loop checks only the first PING; the timing varies run to run | Unverified |
| H5 | **Service readiness.** SeaweedFS is "started" but not yet answering (seen locally: `ECONNRESET` just after start). CI checks it with one unasserted `curl` | Pattern A (early failure) | Observed locally | Failures happen at 120–187 s, not at start-up |
| H6 | **Coverage threshold dip.** Same code, so coverage should not change between runs | A | — | Unlikely: identical code passed in run 9 |

### 2.2 Investigation plan

1. **Read the existing logs** in the Actions web page for runs 7, 10, 20, 26 and 27, or with `gh run view <id> --log-failed`. Record the failing test name and message, or the last line before the cut-off. This alone may confirm H1, H3 or H5. *(0.25 day)*
2. **Measure the flake rate.** Re-run the failing job on the current head 5 times, without changes. Write down pass or fail, duration and failing test for each. *(0.25 day, mostly waiting)*
3. **Instrument (§1.3)** and run 3 more times. Take the peak memory from the samples and look for out-of-memory killer entries in `dmesg`. This confirms or rules out H2 and H4. *(0.5 day)*
4. **Reproduce locally under runner limits.** Run the API suite in a container capped at `--cpus=2 --memory=7g`, with ClamAV and SeaweedFS also limited. Run it 5 times and compare with CI. *(0.5 day)*
5. **Split experiment.** Run the functional suite without the three `*.performance.test.ts` files 5 times, and the performance files alone 5 times. If the functional suite is 5 of 5 green, H1 or H3 is confirmed as the main cause. *(0.25 day)*
6. **Write the root-cause record:** the cause, the evidence, the fix, and how a recurrence would be detected. Add it to the decision log.

### 2.3 Likely remedies, decided only after the evidence

| Cause | Remedy |
|---|---|
| H1 or H3 | Separate performance job (§1.2), with runner-appropriate budgets and seeding timeouts. Production-like budgets are verified on fixed hardware in the launch load test instead |
| H2 or H4 | Limit image-processing concurrency in tests. Start ClamAV with signatures already loaded, or wait for a stable reload. Give ClamAV its own job, or use a larger runner |
| H5 | Readiness loops with assertions for every service |

**Success criteria**

- A root cause is confirmed by evidence, either a log line or a measurement.
- The fix is verified by 10 of 10 green runs.
- The record is filed.

**Estimated effort:** 1.5–2 days. This overlaps Priority 1; the combined total is in §10.

## 3. Priority 3 — Browser tests succeed in CI

The `web-e2e` job has never run on GitHub; it is skipped because it needs the `api` job. Expected risks once it runs:

| Risk | Mitigation |
|---|---|
| ClamAV start and signature reload (as H4) | Same readiness fix as §2 |
| Runtime: about 5 min locally (4 vCPU), likely 10–15 min on 2 vCPU | `timeout-minutes: 30`; keep the suite serial (shared seed) |
| `perf.spec.ts` budgets on a slower runner | Move to the performance job (§1.2). It is excluded from the blocking job and runs on a schedule |
| Playwright browser and version drift | Pin to the lockfile version (1.56.1) and install with `--with-deps chromium` (already in the job) |
| Map rendering without a GPU | Already works headless locally (software rendering); verify on CI |
| Flaky selectors or timing | Traces and screenshots are kept on failure (already in the job). Quarantine is not allowed: fix or remove with a tracked issue |

**Success criteria**

- `web-e2e` passes in 5 consecutive runs: 54 functional tests plus the accessibility sweep. The performance spec runs in its own job.
- Duration under 20 minutes.
- Artifacts kept on failure.

**Estimated effort:** 1–1.5 days after Priority 1.

## 4. Priority 4 — Dependency upgrades

From `pnpm audit --prod`, 30 October: 6 advisories, 4 high and 2 moderate.

| Package | Path | Advisory | Exposure | Action | Rating |
|---|---|---|---|---|---|
| `zod` < 4.6.6 | API | Memory exhaustion validating oversized constrained collections (high) | Real: the API validates untrusted request bodies | Upgrade to ≥ 4.6.6; check the web's zod version too; add a request-body size test | **High** |
| `multer` < 2.5.0 | API, through `@nestjs/platform-express` | Denial of service via a pending async fileFilter (high) | Believed low: no file interceptors are registered, and uploads go direct to storage | Upgrade NestJS platform packages; confirm no multipart route exists | **Medium** |
| `postcss` ≤ 8.5.22 (4 advisories) | Web, through `next` | XSS in stringify output; source-map file read and path traversal | Build-time processing of our own CSS only | Upgrade `next` to a release bundling postcss ≥ 8.5.23, or a pnpm override | **Low** |

**Process**

- One package group per commit.
- Run the full local suites (SQL, API, web unit, e2e) and CI for each.
- Read release notes for behaviour changes in zod (validation messages feed our RFC 9457 field errors, so check the API's 422 responses are unchanged).
- Use `pnpm outdated` to list the remaining updates. Majors are planned separately, not done in this window.

**Success criteria**

- `pnpm audit --prod --audit-level=moderate` is clean, or the remaining items are accepted in writing with a reason.
- All suites are green.

**Estimated effort:** 1 day.

## 5. Priority 5 — Secret scanning

| Step | Action |
|---|---|
| 5.1 | **Baseline scan of the whole history and every branch**, including `audit/pre-phase-4` and Phase 2: run gitleaks (or trufflehog) against a full clone. Record the findings |
| 5.2 | **CI gate:** a gitleaks job on every push and pull request, with an allowlist for known test-only values. The allowlisted values must be visibly fake: `estatepro-test-secret` (SeaweedFS), test IdP keys generated at runtime, e2e emails |
| 5.3 | **GitHub-native scanning.** For a private repository, GitHub secret scanning and push protection need GitHub Secret Protection (a paid add-on). Decide: enable it, or rely on gitleaks plus a pre-commit hook |
| 5.4 | **Response procedure.** For any real secret found: rotate it first, then remove it from history only if needed (rewriting history needs your approval), and record it |

**Success criteria**

- The baseline scan is complete, and every finding is triaged as fake, rotated or removed.
- The secret-scanning job is required on `main`.
- A deliberately planted fake secret on a test branch is blocked.

**Estimated effort:** 0.5–1 day, plus the licence decision.

## 6. Priority 6 — Dependency scanning

| Step | Action |
|---|---|
| 6.1 | **Dependabot alerts and security updates**: free for private repositories. Turn them on. Add `dependabot.yml` for npm (grouped minor and patch updates, weekly) and GitHub Actions |
| 6.2 | **CI gate**: `pnpm audit --prod --audit-level=high` fails the build. Moderate findings are reported, not blocking. Accepted exceptions live in a reviewed file with an expiry date |
| 6.3 | **Pull-request review**: `dependency-review-action` and CodeQL need GitHub Code Security on private repositories. The alternative is OSV-Scanner (free) in CI. Decide alongside 5.3 |
| 6.4 | **Container images in CI** (`postgis/postgis:16-3.4`, `chrislusf/seaweedfs:3.80`, `clamav/clamav:1.4`): pin by digest, and refresh deliberately |
| 6.5 | **Lockfile integrity**: `pnpm install --frozen-lockfile` is already enforced |

**Success criteria**

- The dependency gate is required on `main`.
- Dependabot is active.
- A known-vulnerable test dependency on a branch fails the gate.

**Estimated effort:** 0.5–1 day.

## 7. Priority 7 — Identity-provider decision (issue #6)

**Owner:** product owner (the decision). Engineering prepares the evaluation and proof.

**Must-have criteria** (from ADR-001, W-D9 and our tests):

- OIDC authorisation code with PKCE
- Refresh-token rotation
- `end_session_endpoint`
- Verified-email and `amr` claims; MFA with TOTP and WebAuthn
- Step-up re-authentication: `max_age=0` or `prompt=login`, `auth_time`
- An API audience
- Custom domain
- Data residency acceptable for UK, Ghana and Qatar users (EU or UK region)
- Hosted pages localised in **Arabic with right-to-left** layout
- Hosted pages meeting **WCAG 2.2 AA, including 3.3.8 accessible authentication**
- Admin and provisioning APIs, with an SLA
- Pricing at the expected monthly active users
- Later portal needs: separate landlord and tenant applications, magic link or passwordless (IS-9)

**Shortlist to evaluate:**

| Option | Kind |
|---|---|
| Auth0 (Okta Customer Identity) | Managed |
| Microsoft Entra External ID | Managed |
| AWS Cognito | Managed |
| Zitadel Cloud | Managed |
| Keycloak | Self-hosted; ADR-001 preferred managed, so this is listed as a fallback |

**Proof for the top two:**

1. Run our sign-in flow tests (`test/server/auth-flow.test.ts` pattern) and the Playwright sign-in path against a trial tenant.
2. Verify refresh rotation, step-up, sign-out and the API's JWT checks (issuer, audience, `amr`).
3. Check the hosted pages in Arabic and with a screen reader.

**Deliverable:** a short decision record with a scoring matrix and the proof results. Recommend; you decide.

**Success criteria**

- Issue #6 is closed with a recorded decision.
- The chosen vendor passes our auth-flow tests in a trial tenant.

**Estimated effort:** 2–3 engineer-days for evaluation and proof, plus the decision meeting.

## 8. Priority 8 — Open the missing issue for IS-3

Draft issue, ready to file:

> **[Audit IS-3] Freeze `statement_lines` when a statement is issued**
>
> | | |
> |---|---|
> | Labels | `audit`, `database`, `severity:high`, `phase-7`, `phase-9` |
> | Finding | The pre-Phase-4 audit (IS-3) found no trigger protecting `statement_lines`. Once the parent statement is issued, the runtime role can still change or delete its lines, so an issued landlord statement can diverge from what was sent. |
> | Expected | When a statement is issued, its lines become read-only to every application role. Corrections are made by issuing a new statement or an adjustment, mirroring #1 (rent charges). |
> | Acceptance | A database test proves that update and delete of lines on an issued statement fail for the application roles, and that draft statements remain editable. |
> | Related | #1, #2, #3 (money integrity), audit IS-11 (test gaps) |
> | Needed by | Before Phase 7 Leasing and Phase 9 Finance |

**Success criteria:** the issue exists, is linked from the consolidated report, and is scheduled with #1–#3.

**Estimated effort:** 0.1 day. It will be filed on your approval, because it posts to GitHub.

## 9. Priority 9 — Reassess all Critical and High risks

**Method.** For each item in the consolidated report:

1. Rate likelihood (1–3) × impact (1–3).
2. Note the evidence found during stabilisation.
3. Assign an owner, and decide whether it is in or out of the stabilisation window.

Re-rate at the start of stabilisation and again at exit.

**Starting position.** "In window" means it is addressed by this plan.

| Risk | Current | In window | Expected rating at exit |
|---|---|---|---|
| TD-1 / TD-2: CI red; e2e never run | Critical | Yes (P1–P3) | Closed |
| #6 / S-6: identity-provider vendor | Critical | Yes (P7, decision) | Closed, or High if the decision slips |
| #1–#3 and IS-3: money integrity | Critical (before Phase 7) | Tracked only (P8); the fix is scheduled before Phase 7 | Critical, gated by phase |
| S-12: no penetration test | Critical before launch | No | Unchanged; schedule before the first external user |
| S-2: zod advisory | High | Yes (P4) | Closed |
| S-5: no secret or dependency scanning | High | Yes (P5, P6) | Closed |
| TD-15: Phase 4 unreviewed and unmerged | High | Yes: open the pull request once CI is green; human review | Closed when merged |
| TD-10: monthly partition job | High | Partly: document the operational runbook; implement with deployment | High |
| IS-7 / S-8: key management | High | No (Phase 5 prerequisite) | High; first item of Phase 5 |
| #12 / S-9: linked visibility | High | No (Phase 5 scope) | High |
| IS-6 / S-7: support access | High | No | High |
| S-11: data residency | High | Raise the legal question now (no engineering) | High until answered |
| Accessibility: screen reader, WCAG 2.2, W-D10 | High | No (scheduled work) | High |
| IS-10: Arabic native review | High | No | High |
| Load testing | High | No (needs staging) | High |
| Infrastructure, delivery, observability | High | No (launch track) | High |
| MD-7: legal and finance reference data | High | No | High; gated before Phase 7 |
| TD-11 / IS-11: database test gaps | High | No | High; gated before Phase 7 |
| #8: Phase 5 wireframes | High | No (Phase 5 entry) | High; Phase 5 entry criterion |
| Seller KYC dependency | High | No (Phase 5 scope) | High |

**Deliverable:** an updated risk register (consolidated report §12) with owners and target dates. Any risk still Critical at exit needs a recorded acceptance from you.

**Estimated effort:** 0.5 day, plus 0.25 day at exit.

## 10. Schedule and effort

| Order | Work | Effort (engineer-days) | Depends on |
|---|---|---|---|
| 1 | §2 root cause (logs, flake rate, instrumentation, local reproduction, split) | 1.5–2 | — |
| 2 | §1 restore CI (job split, diagnostics, readiness, timeouts, branch protection) | 1 (beyond §2) | §2 |
| 3 | §3 browser tests in CI | 1–1.5 | §1 |
| 4 | §4 dependency upgrades | 1 | §1 (needs a green gate) |
| 5 | §5 secret scanning | 0.5–1 | Licence decision |
| 6 | §6 dependency scanning | 0.5–1 | Licence decision |
| 7 | §8 IS-3 issue | 0.1 | Your approval |
| 8 | §7 identity-provider evaluation and proof | 2–3 | Runs in parallel from day 1 |
| 9 | §9 risk reassessment | 0.75 | Start and exit |
| 10 | Open the Phase 4 pull request and support the review | 0.5, plus reviewer time | §1–§4 |
| | **Total** | **9–12 engineer-days**, about **2 weeks** for one engineer, or about 1.5 weeks with the identity-provider work in parallel | |

## 11. Exit criteria (all required before Phase 5 starts)

1. **CI green and trusted.** Blocking jobs (SQL, API functional suite with coverage, web, web-e2e) are green on 10 consecutive runs of the final head. Branch protection on `main` requires them.
2. **Root cause recorded** for the API job failures, with evidence and the verified fix.
3. **Browser tests in CI.** `web-e2e` (functional and accessibility sweep) green in 5 consecutive runs. The performance job runs on a schedule and keeps its results.
4. **Dependencies.** No open high or critical advisories in production dependencies; moderate ones fixed or formally accepted.
5. **Secret scanning.** Baseline history scan triaged, and a required CI gate in place.
6. **Dependency scanning.** Dependabot on, and the audit gate required in CI.
7. **Identity provider decided** (#6 closed). Alternatively, you explicitly accept starting Phase 5 without it; this is acceptable for development but blocks any shared environment.
8. **IS-3 issue filed** and linked with #1–#3, all scheduled before Phase 7.
9. **Risk register re-rated** with owners and dates, and any remaining Critical item explicitly accepted by you.
10. **Phase 4 pull request open**, reviewed and merged to `main` (audit branch still separate), or the review scheduled with a date.
11. **No new business features** were added during stabilisation. Changes are limited to CI, tests, dependencies, scanning configuration and documentation.

## 12. Decisions needed from you

| # | Decision | Recommendation |
|---|---|---|
| 1 | Performance tests outside the blocking gate (scheduled job with recorded results), with production-like budgets checked in the launch load test | Yes |
| 2 | GitHub Secret Protection and Code Security (paid) or free tooling (gitleaks, OSV-Scanner, Dependabot) | Start with free tooling; revisit before launch |
| 3 | Larger CI runners (paid) if memory is the cause | Only if §2 shows the standard runner cannot run the suite after the split |
| 4 | Approval to file the IS-3 issue (§8) | Yes |
| 5 | Identity-provider shortlist and who decides | Evaluate Auth0 and Microsoft Entra External ID first |
| 6 | Enable branch protection on `main` | Yes |
