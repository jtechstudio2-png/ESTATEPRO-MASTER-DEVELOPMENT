# CI Root Cause Investigation Report

| | |
|---|---|
| Date | 31 October 2026 |
| Scope | GitHub Actions workflow `ci.yml` on `phase-4/property-management`, runs 1–46 |
| Trigger | The API test job failed on 19 of 20 runs after the M4 code landed (run 7, 27 October). The web end-to-end job never ran, because it depends on the API job |
| Related | [Stabilisation Plan](PHASE-4-STABILISATION-PLAN.md) §2; [Consolidated Status Report](PHASE-4-CONSOLIDATED-STATUS-REPORT.md) TD-1/TD-2; issue #13 (IS-3, filed during stabilisation) |
| Outcome | **Four independent root causes**, all fixed and verified on GitHub. The final head is green on 10 consecutive runs (§7). |

## 1. Failing workflow IDs

### 1.1 Before the investigation (runs 7–29)

| Run | Workflow run ID | Commit | API test step | Pattern |
|---|---|---|---|---|
| 7 | 40597630976 | `115060f` (M4) | Failed after 120 s | A: test failure |
| 8 | 40628613050 | `a167d88` | Failed | A |
| 9 | 40633793935 | `8c12064` (docs only) | **Passed in 120 s** | — (same code as run 7) |
| 10 | 40638836294 | `83df360` (M5) | Failed after 187 s | A |
| 11–19 | 40642632240 … 40727232975 | M6 commits | Failed | A |
| 20 | 40730267304 | `871df11` | Step left "in progress"; job ended 164 s in | B: cut off |
| 21–25 | 40733796981 … 40738116531 | M6 commits | Failed | A |
| 26 | 41126428893 | `87189bb` | Failed after 147 s | A |
| 27 | 41127710055 | `f5ca548` | Step left "in progress"; job ended 98 s in | B |
| 28–29 | 41134215840, 41139785605 | Reports | Failed | A |

Throughout this period the web end-to-end job was skipped in every run, because it waits for the API job.

### 1.2 During the investigation (runs 30–36)

| Run | Workflow run ID | Commit | Result | Failure (from the new diagnostics) |
|---|---|---|---|---|
| 30 | 41143642665 | `32770c0` | API passed; **web-e2e failed** (first run ever); OSV failed | e2e: 2 axe `color-contrast` failures (P-2 and the sweep). OSV: 8 known vulnerabilities |
| 31 | 41145411481 | `e928be0` | **API failed** | `worker.test.ts`, "treats a missing object as absent…": timed out at 20 s |
| 32 | 41146572750 | `e4c5bce` | API failed | Same test; SeaweedFS log: "No more free space left" |
| 33 | 41146578529 | `e4c5bce` | API failed | Same |
| 34 | 41146581491 | `e4c5bce` | API failed | Same |
| 35 | 41146584436 | `e4c5bce` | API passed; **web-e2e failed** | Contrast on `.fieldActions > .button_primary` (the "Field visit" link-button); SeaweedFS "No more free space" at the end of the job |
| 36 | 41147738183 | `ddd72e3` | Cancelled (superseded by the next push) | — |

## 2. Failure patterns

| Pattern | Signature | Runs |
|---|---|---|
| **A: test failure** | The step completes with vitest exit 1 after 120–190 s. The runner stays healthy and post-steps run. Identical code sometimes passes (runs 7 and 9) | 7, 8, 10–19, 21–26, 28–29, 31–34 |
| **B: cut off** | The test step is left "in progress"; the job ends 98–164 s in; post-steps never run | 20, 27 |
| **C: browser accessibility** | axe `color-contrast` on one element, on GitHub only | 30, 35 |
| **D: dependency gate** | OSV-Scanner finds known vulnerabilities (expected once scanning was added) | 30 |

Pattern B was not seen again after the fixes. Its cause is not confirmed (see §5).

## 3. Reproduction attempts

| # | Where | What | Result |
|---|---|---|---|
| R1 | Local container, 4 vCPU, 15 GB | Full API suite with coverage, as CI runs it, 5 times | **2 of 5 failed**, each on a different test: `infrastructure.test.ts` (audit row order) and `media.e2e.test.ts` (listing expiry audit row). Runs 3–5 passed |
| R2 | Same | Inspected both failures | Both are order-dependent assertions (§4, causes 1 and 2) |
| R3 | Same, test process, PostgreSQL and containers pinned to 2 cores | Performance tests | All within budget: photos 1.68 s per photo (target 3 s); map, clustered p95 433 ms (target 800 ms); listing search p95 234 ms (target 1 s). **Performance budgets ruled out** as a cause on this hardware |
| R4 | Same, 2 cores | Full suite without the performance files, with both test fixes, twice | 2 of 2 passed (284/284) |
| R5 | GitHub (run 30 onward) | Diagnostics written to each job's check run: failing tests, peak memory, OOM kills, container state, ClamAV and SeaweedFS log lines | Found causes 3 and 4 |
| R6 | Local | `worker.test` storage calls timed directly (head with valid and invalid keys) | 6–37 ms, no retries; the 20 s stall is GitHub-specific |
| R7 | Local, SeaweedFS with default settings on a 1.5 GB disk, writes to five new buckets | Attempt to reproduce cause 3 | **Partial.** Each new bucket's first write slowed from 0.2 s to about 5 s as volume growth struggled. The indefinite stall and "No more free space" did not appear, because local disk differs from the runner's. Cause 3 rests on the GitHub log evidence and the verified fix |
| R8 | Local, a build without the CSS fix, then with it | Regression test: hover the primary link-button | **Fails without the fix** (text `rgb(16, 47, 77)` on the brand background) and **passes with it** |
| R9 | Local, harness on one core, P-2 test repeated 5 times | Attempt to reproduce cause 4 by contention | Passed 5 of 5. Cause 4 depends on where the pointer rests, not on CPU |

## 4. Root cause conclusions

### Cause 1: undefined row order within one transaction (test defect, pattern A)

`infrastructure.test.ts` writes two audit rows in one transaction and orders them by `occurred_at`. PostgreSQL's `now()` is fixed for the whole transaction, so both rows carry the **same timestamp** and their order is undefined. UUIDv7 ids don't break the tie either: they are ordered only to the millisecond, and the rest is random.

### Cause 2: query without ORDER BY (test defect, pattern A)

The listing-expiry test read "the first" `listing.status_changed` audit row without `ORDER BY`. The listing has two such rows: the user's publish and the system's expiry. PostgreSQL may return either.

### Cause 3: test storage server out of volume space (CI infrastructure, pattern A, likely B)

SeaweedFS (the S3-compatible test store) started with its default volume size of about 1 GB. It sets its volume limit from free disk divided by volume size, so on the GitHub runner's disk it could not create the volumes new buckets need. The failed jobs' SeaweedFS log shows, repeatedly:

> `assign volume … preallocate:1073741824 … No more free space left` … `create 7 volume, created 0`

A write that needed a new volume waited until the test's 20 s timeout (`worker.test`). Earlier media tests sometimes consumed the room first, which explains why identical code passed occasionally (run 9).

### Cause 4: hovered link-buttons had unreadable text (product defect, pattern C)

The global rule `a:hover { color: brand-hover }` (specificity 0,1,1) outranks `.primary { color: on-brand }` (0,1,0). A **link** styled as a primary button therefore showed dark brand text on the brand background while hovered: a genuine WCAG 1.4.3 failure for mouse users. Real `<button>`s were unaffected, because React Aria's `data-hovered` drives their hover state. It surfaced on GitHub only because Playwright's pointer happened to rest over the "Field visit" button after the previous click; local font metrics moved the button away from the pointer.

### Hypotheses ruled out or not supported

| Hypothesis | Evidence | Verdict |
|---|---|---|
| H1: performance budgets too tight for the 2-vCPU runner | Locally on 2 cores, every budget passed with margin (R3). They now run outside the gate anyway | Not a cause |
| H2: memory exhaustion | Peak memory on GitHub 2.8–4.0 GB of 7.9 GB, lowest available ≥ 3.9 GB, no OOM kills in any run (diagnostics) | Not a cause |
| H3: seeding exceeds hook timeouts | Performance seeding finished in 5–20 s even on 2 cores | Not a cause |
| H4: ClamAV signature reload | ClamAV answered steadily in every diagnosed run; restarts 0 | Not observed; the readiness wait stays as a safeguard |
| H5: storage readiness at start | Superseded by cause 3: the store was up but out of volume space | Folded into cause 3 |

## 5. Resource constraints

| | GitHub runner (private repository) | Local container |
|---|---|---|
| CPU | 2 vCPU | 4 vCPU (2 when pinned) |
| Memory | 7.9 GB | 15.7 GB |
| Peak memory used, API job | 2.8–3.0 GB | 2.1–2.7 GB |
| Peak memory used, browser job | 3.96–4.03 GB | — |
| Peak load (1 min) | API 1.9–3.1; browser 3.3–5.6 | — |
| Disk for SeaweedFS volumes | Not enough at 1 GB per volume | Enough |

**Pattern B (runs 20 and 27, cut off with no post-steps).** The logs of those runs can't be downloaded through the API, and the pattern did not recur once cause 3 was fixed. The most likely explanation is cause 3's retry storm (the master retrying volume growth several times a second) starving the runner, but this is **not confirmed**. If it recurs, the diagnostics now record memory, load and container state up to the moment the job stops.

## 6. Permanent fixes

| Cause | Fix | Commit |
|---|---|---|
| 1 | The test matches the two audit rows by action, not position | `32770c0` |
| 2 | The test orders by `occurred_at` (separate transactions, so distinct timestamps) and takes the latest | `32770c0` |
| 3 | SeaweedFS in CI runs with `-master.volumeSizeLimitMB=64`, so the volume limit leaves room for every test bucket. Test infrastructure only; production uses R2 | `ddd72e3` |
| 4 | Link-buttons have their own hover rules (specificity 0,2,1), plus a regression test that hovers primary and secondary link-buttons and runs axe | `8ee5fd8` |

### Structural changes that keep CI diagnosable and the gate meaningful

| Change | Commit |
|---|---|
| Performance tests moved out of the blocking gate into `performance.yml`: nightly, on a published release or `v*` tag, and on demand | `32770c0` |
| Every test job writes failing tests, peak memory, OOM kills, container restarts and the last ClamAV and SeaweedFS log lines to its check run and summary; reports are kept as artifacts | `32770c0`, `e928be0`, `e4c5bce` |
| Readiness checks that wait until SeaweedFS answers and ClamAV answers steadily; job timeouts; a manual trigger for repeat runs | `32770c0` |
| Secret scanning (gitleaks, full history) and dependency scanning (OSV-Scanner) as CI jobs; Dependabot configuration | `32770c0` |
| Dependency upgrades: zod 4.6.7; NestJS 12.3.2 (multer 2.5.0); postcss 8.5.32 for Next. One documented, time-limited exception: minimatch, development tooling only | `febb038` |

### Recommended follow-up (not done in this window)

- **Give the production S3 client explicit connection and request timeouts.** The client has none today, so a stalled storage call would block a worker job indefinitely. This is a robustness fix outside the CI scope; it should be tracked as an issue.
- **History ordering within one transaction.** Product histories order by timestamp, then id. Several entries written in the same transaction (same timestamp, same millisecond) may therefore appear in any order. This is a minor display issue; consider a per-row sequence if exact order matters.

## 7. Verification evidence

| Check | Evidence |
|---|---|
| Fixes 1 and 2 | Local 2-core runs R4: 2 of 2 passed. No recurrence on GitHub since `32770c0` |
| Fix 3 | Runs 31–35 failed with "No more free space left" on the old setting. From run 37 the SeaweedFS log shows volumes being created ("Created Volume 13 … becomes writable") and no out-of-space errors |
| Fix 4 | Regression test fails without the fix and passes with it (R8); the browser job passes on GitHub from run 37 |
| **10 consecutive green runs** | Head `8ee5fd8`: runs 37–46, all jobs green (SQL, API, web, web-e2e, secrets, dependencies). See the table below |
| **5 consecutive browser runs** | Runs 37–41 (and every run after), each 55 of 55 expected, 0 unexpected, 0 flaky |
| Dependency gate | OSV-Scanner green from run 31; `pnpm audit --prod` reports no known vulnerabilities |
| Secret gate | gitleaks green on every run; the baseline scan of all 49 commits on every branch found nothing |

**Consecutive runs on `8ee5fd8`:**

| Run | Workflow run ID | Trigger | Result |
|---|---|---|---|
| 37 | 41148051904 | push | ✅ success |
| 38 | 41148057231 | manual | ✅ success |
| 39 | 41148060132 | manual | ✅ success |
| 40 | 41148063130 | manual | ✅ success |
| 41 | 41148066098 | manual | ✅ success |
| 42 | 41149651305 | manual | ✅ success |
| 43 | 41149654169 | manual | ✅ success |
| 44 | 41149656960 | manual | ✅ success |
| 45 | 41149659299 | manual | ✅ success |
| 46 | 41149661990 | manual | ✅ success |

Runs 37–46: 10 consecutive green runs; zero failed, cancelled or re-run jobs.
