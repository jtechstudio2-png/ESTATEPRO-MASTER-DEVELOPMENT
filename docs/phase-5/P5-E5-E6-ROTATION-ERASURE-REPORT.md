# Phase 5 · Milestone report: E5–E6 key rotation, erasure and recovery

| | |
|---|---|
| Date | 5 November 2026 |
| Branch | `phase-5/preparation`, commits `a767927`, `7818752`, `03b46e8`; CI run 83 green |
| Approvals | C6 decisions C6-D1 to C6-D6 approved before work started; #24 and #25 kept open as pre-launch requirements |
| Scope | The two encryption stages the approved roadmap requires before Phase 5 exit (ADR-007; `P5-FIELD-ENCRYPTION-PLAN.md` §3): **E5** data-key rotation; **E6** erasure, crypto-shredding, the erasure ledger, the restore runbook and a recovery drill. E7 (cloud KMS) and E8 (monitoring) stay with hosting (#28). No new screens beyond showing an erased person correctly |
| Result | **E5–E6 complete.** Keys can be rotated without downtime or false edit conflicts. A person can be erased everywhere without breaking the records the law requires us to keep. A restore cannot bring erased data back. Results in §3; CI run 83 green (§10) |

## 1. Deliverables

### 1.1 Database (migration 0026)

| Change | Purpose |
|---|---|
| `key_rotations` | One row per rotation: from and to version, trigger (scheduled, compromise, request), reason, operator, state (rewriting → settling → completed), batch cursor, rows moved. One open rotation per company and key. Read-only for the runtime role |
| `app.ciphertext_key_version()` | Reads the key version from a ciphertext header, so the database can count values still on an old key |
| `app.touch_row()` | A rotation re-encrypts without bumping a row's version or update time (no false "changed by someone else") |
| `app.erase_contact()` | Erases a person and every record merged into them, in the caller's company; returns counts per table, never values; idempotent |
| `app.contact_erasure_blockers()` | Refuses organisations, and people referenced by financial or contractual records (the `block` rows of the C1 reference register) |
| Guards | Verified identity documents accept only a newer-key ciphertext or a new hash, from a maintenance role. Signed-off KYC checks, activities, activity revisions, lead history and audit rows accept only "[Erased]" in place of their text, inside the erasure function. The runtime role cannot use either path, even if it sets the erasure flag itself |
| `identity_documents.erased_at` | An erased document keeps its type, country, dates and verification, and loses its number, hash and last characters |
| `contacts_anonymised_empty`, `contacts_anonymised_guard` | An erased contact holds no personal data and cannot be given any again or "un-erased" |

### 1.2 API, worker and operator command

| Change | Notes |
|---|---|
| `KeyRotationService` | Field key: batches of 200, each its own transaction, resumable. After every value is moved it waits `KEY_ROTATION_SETTLE_SECONDS` (10 min). It re-checks for values written with the old key during the switch, then destroys the old key. Lookup key: two re-hash passes either side of the settle period (hashes carry no version). Each step audited |
| Worker job `key.rotate` | Yearly field-key rotation per company (`KEY_ROTATION_MAX_AGE_DAYS`, 365); continues open rotations every quarter hour |
| `ErasureService` | Erasure in the company's tenant transaction; the ledger entry is written before the transaction commits. Company crypto-shredding (cancelled companies only, slug typed as confirmation). Ledger replay (dry run or apply) |
| `ErasureLedger` | Append-only entries in a separate bucket (`ERASURE_LEDGER_BUCKET`), object lock in production; ids, times, request reference and operator only. The reference must be a ticket number: spaces are refused, so a name cannot be entered |
| `data-protection` command | `rotate-key`, `rotation-status`, `erase-contact`, `shred-company`, `replay-ledger [--dry-run]` |
| Identity documents | `numberLast4` is null once erased, and `canReveal` is false |
| Runbook | `docs/runbooks/DATA-PROTECTION-RUNBOOK.md`: rotation, ledger bucket, restore with replay, erasure requests, company closure, drills |

### 1.3 Web

| Change | Wireframe |
|---|---|
| An erased person's name shows as "Erased contact" in the member's language; the C5 banner and read-only state apply | C-2 "Anonymised" state |
| Erased document numbers show "Number erased" (Identity tab, identity-check queue, linked documents); no reveal | C-5, SH-1 |

### 1.4 What erasure removes, and what it keeps

| Removed | Replaced with "[Erased]" | Kept |
|---|---|---|
| Names, title, email, phone, nationality, residence, date of birth, tax and registration numbers, notes, custom fields, contact methods, an address not shared with others, document numbers and their hashes | Lead messages and source details, activity subjects and bodies (including earlier versions and system entries), follow-up titles and descriptions, KYC notes and reasons, consent evidence, requirement notes and exclusion reasons, lead history notes, archive reasons, string values in audit changes and outbox payloads | Ids, references, dates, statuses, consent decisions (a withdrawal stays in force), KYC outcomes and risk ratings, who did what and when |

## 2. Requirement checklist

| Requirement | How it is met | Evidence |
|---|---|---|
| Encryption controls | Rotation moves every protected column of the register (ADR-007 §3); the old key is destroyed only when no ciphertext uses it. Shredding destroys every key of a closed company | API tests "moves every protected value…", "destroys every key of a cancelled company"; SQL suite 09 |
| Reveal restrictions | Unchanged rules. Nothing is revealable after erasure, and an erased document offers no reveal | API test (404 after erasure); browser test C-2 erased |
| Tenant isolation | Rotation and erasure always filter by company; erasure runs under row-level security; another company's contact is "not found" | API and SQL tests |
| Audit integrity | Audit rows are never deleted. Erasure keeps actor, action, entity, time and field names, and redacts values. Rotation, key destruction, erasure, replay and shredding are audited without values or key material | SQL suite 09; API tests |
| Accessibility | Erased contact record and Identity tab in the axe sweep, English and Arabic, desktop and 320 px | Browser tests |
| Localisation validation | Three new strings in English and Arabic (erased name, number erased, linked document erased); message check passes | Message check |
| Performance budgets | See §7 | Performance test |
| CI verification | All required jobs green on the final commit | CI run 83 |

## 3. Tests

| Suite | Tests | Result |
|---|---|---|
| `database/tests/09_rotation_erasure_e5_e6.sql` (helpers, blockers, erasure, guards, side doors refused, rotation rules) | 40 assertions | ✅ |
| `api/test/data-protection.e2e.test.ts` (rotation incl. a write with the old key mid-rotation, lookup rotation, yearly worker rotation, erasure, merged records, blockers, ledger failure, shredding, restore drill, replay errors) | 10 | ✅ |
| `api/test/data-protection-args.test.ts` (command arguments, rotated columns) | 3 | ✅ |
| Full API suite (`test:ci`) | 456 in 36 files | ✅ |
| `api/test/data-protection.performance.test.ts` (rotation and erasure at volume, §7) | 3 | ✅ |
| Full end-to-end suite (Playwright; new: erased contact record and Identity tab; erased Arabic contact in the axe sweep) | 85 | ✅ |
| Web unit tests | 75 | ✅ |
| Lint, typecheck, message check (2,355 keys in both languages), OpenAPI and web types regenerated | — | ✅ |

API coverage: 96.35 % statements, 91.02 % branches, 98.34 % functions, 98.49 % lines. Web coverage: 98.14 % statements, 91.41 % branches. Thresholds 95/90 met. The operator command's entry point is exercised through the services it calls, not run as a process.

### 3.1 Defects found and fixed before the milestone closed

| Defect | Found by | Fix |
|---|---|---|
| Existing tests marked contacts anonymised by setting a flag, leaving personal data in place | The new database rule that an anonymised contact holds no personal data | Tests now erase through `app.erase_contact` |
| An erased identity document still offered "Reveal" | Browser test C-2 erased | `canReveal` is false once the number is erased |
| A rotation would have bumped every contact's version, causing edit conflicts | Review of the touch trigger | Rotation leaves version and update time unchanged (tested) |

## 4. Security validation

| Check | Result |
|---|---|
| The runtime role cannot erase, redact history or re-encrypt verified documents, even by setting the erasure flag itself | ✅ SQL suite 09 |
| The runtime role cannot start rotations or change keys | ✅ SQL suites 04 and 09 |
| No protected value, key material or person's name in audit rows, ledger entries or command output | ✅ API tests |
| Erasure is never committed without its ledger entry | ✅ API test (ledger unreachable → nothing erased) |
| A shredded company's values cannot be read or written by a fresh process | ✅ API test |
| A restore followed by replay leaves erased people erased and destroyed keys destroyed; replay is idempotent | ✅ restore drill (API test) |

## 5. Encryption impact

- Key lifecycle is complete for the local provider: create, rotate, retire, destroy.
- Values encrypted before this milestone need no change; rotation moves them when it runs.
- The cloud KMS adapter (E7) and alerting (E8) remain with hosting (#28).
- Root-key rotation is done by the KMS.

## 6. Audit impact

New audit actions:

| Action | When |
|---|---|
| `key.rotation_started`, `key.destroyed`, `key.rotation_completed` | Key rotation |
| `contact.erased` | A person is erased |
| `contact.erasure_replayed` | An erasure is re-applied by ledger replay |
| `company.keys_destroyed` | A closed company's keys are destroyed |

Existing audit rows about an erased person keep their shape, with values redacted (ADR-007 §16).

## 7. Performance results

`api/test/data-protection.performance.test.ts`: one company, 20,000 contacts with an encrypted date of birth, 5,000 of them also with an encrypted tax number and its lookup hash.

| Measure | Budget | Result |
|---|---|---|
| Field-key rotation, 25,000 values (re-encrypt, check, destroy old key) | ≥ 500 values a second | 11.9 s, about 2,100 a second ✅ |
| Lookup-key rotation, 5,000 hashes, two passes | ≥ 250 a second | 3.0 s, about 3,300 a second ✅ |
| Erasing a person with 300 timeline entries, 50 follow-ups and 100 audit rows | < 2 s | 121 ms ✅ |

A rotation runs in batches of 200 rows, each its own short transaction, so screens are not held up while it runs. The screen budgets measured in C6 are unchanged: E5–E6 adds no work to list or record requests.

## 8. Decisions taken in E5–E6 (for confirmation)

| # | Decision | Reason |
|---|---|---|
| E56-D1 | A rotation waits 10 minutes after moving every value, re-checks, and only then destroys the old key. Re-encryption is not an edit (no version change) | No request that read the old key can be left with unreadable data; users see no false conflicts |
| E56-D2 | Lookup keys are rotated only on suspected compromise, in two passes; the worker never rotates them by schedule | ADR-007 E-D7; hashes carry no version |
| E56-D3 | Erasure applies to people only. It is refused while financial or contractual records reference the person (payment accounts, leases, ledger entries, statements, payouts, supplier invoices…); those records are kept by law | Retention obligations override erasure; organisations are not personal data |
| E56-D4 | Erasure redacts history (activity versions, lead history, audit change values) by replacing text with "[Erased]", keeping who did what and when. Consent decisions, KYC outcomes and references stay | Erasure must reach every copy in the live database; audit integrity keeps the event, not the value |
| E56-D5 | The ledger entry is written before the erasure commits; if the ledger is unreachable, nothing is erased. The request reference must be a ticket number | Every erasure must survive a restore; the ledger must hold no personal data |
| E56-D6 | Until the data-subject request register (gap G3) is built, erasure and company shredding are operator commands, audited in the company's audit log, on verified requests | No feature expansion in E5–E6; the register (D-A "Erasure / access requests", C-2 action, C-4 merge blocker) is proposed as the next milestone |
| E56-D7 | Shredding applies only to cancelled companies, with the slug typed as confirmation | Irreversible |

## 9. Risks and open items

| Item | Status |
|---|---|
| Data-subject request register (G3): screens for staff to log, track and carry out access and erasure requests | Proposed next milestone |
| Erased data in backups until they age out (risk R-2) | Accepted (ADR-007); the ledger stops a restore bringing it back; retention period set with #28 |
| Real-backup restore drill and emergency-rotation drill | Before launch (runbook §6), recorded on #17 |
| Ledger bucket with object lock, and separate ledger credentials | With hosting (#28) |
| Exports already downloaded before an erasure | Export files expire after 24 hours (CA-16); a downloaded copy is outside our systems |
| Names of erased contacts shown outside the contact name component (for example a lead's contact in a follow-up row) appear as the stored English "Erased contact" | Low; covered by the Arabic review (#25) |
| Arabic native-speaker review | Open, pre-launch (#25); the three new Arabic strings are included |
| Manual screen-reader pass | Open, pre-launch (#24) |
| E7 cloud KMS adapter, E8 monitoring | With hosting (#28) |

## 10. GitHub references

| Reference | Link |
|---|---|
| C6 report | `docs/phase-5/P5-C6-CRM-GAP-CLOSURE-REPORT.md` |
| Field encryption (#17) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/issues/17 |
| ADR-007 | `docs/decisions/ADR-007-field-encryption-key-management.md` (§16 implementation notes) |
| Runbook | `docs/runbooks/DATA-PROTECTION-RUNBOOK.md` |
| Branch | `phase-5/preparation` |
| Commits | `a767927` (implementation), `7818752` (erased documents not revealable; style restored), `03b46e8` (report figures) |
| CI run 83 (green, on `03b46e8`; runs 81 and 82 were cancelled by the later pushes) | https://github.com/jtechstudio2-png/ESTATEPRO-MASTER-DEVELOPMENT/actions/runs/42087303793 |

## Approval

Product owner, 6 November 2026: **E56-D1 to E56-D7 approved.** Proceed with the data-subject request register (gap G3): access and erasure requests, lifecycle and status tracking, assignment, due dates, audit trail, request evidence, merge blocking while an erasure request is open, admin dashboard and contact record integration. Continue maintaining tenant isolation, encryption controls, audit integrity, reveal controls, accessibility validation, localisation validation and CI verification.
