# Runbook: key rotation, erasure and restore (ADR-007 E5–E6)

| | |
|---|---|
| Owner | Platform operations, with the data protection officer for erasures |
| Applies to | Every environment that holds real company data |
| Tool | `pnpm --filter @estatepro/api data-protection <command>` (built API, `dist/cli/data-protection.js`) |
| Related | ADR-007 §8, §10, §11; `docs/phase-5/P5-FIELD-ENCRYPTION-PLAN.md`; milestone report `docs/phase-5/P5-E5-E6-ROTATION-ERASURE-REPORT.md` |

Every command writes to the company's audit log (actor "system", with the operator's name in the details). Erasures and key destruction are also written to the erasure ledger. No command prints a protected value or key material.

Environment for the tool: `DATABASE_URL` (runtime role), `PLATFORM_DATABASE_URL` (platform role), `KEY_PROVIDER` and its settings, `STORAGE_*` and `ERASURE_LEDGER_BUCKET`.

## 1. Key rotation

### 1.1 Yearly field-key rotation (automatic)

The worker rotates a company's field key when it is older than `KEY_ROTATION_MAX_AGE_DAYS` (365). Nothing to do except watch for failures:

1. The worker job `key.rotate` re-encrypts the company's protected values in batches of 200. Each batch is its own transaction, and the rotation resumes from its cursor after a restart.
2. When every value is on the new key, the rotation waits `KEY_ROTATION_SETTLE_SECONDS` (600). This lets requests that read the old key just before the switch finish. It then checks again: values written with the old key in the meantime are re-encrypted.
3. When no value uses the old key, the old key is destroyed: its wrapped copy is erased.

Rows keep their version and update time; users editing a contact during a rotation see no conflict.

Check progress: `data-protection rotation-status --company <uuid>`. A rotation stuck in `rewriting` with `last_error` set needs attention. The usual cause is the key provider being unavailable; the job retries with back-off.

### 1.2 Emergency rotation (suspected compromise)

Field key:

```
data-protection rotate-key --company <uuid> --purpose field --trigger compromise --reason "<incident number and summary>" --by "<your name>"
```

Lookup key (only on compromise; it re-computes every lookup hash in two passes):

```
data-protection rotate-key --company <uuid> --purpose lookup --trigger compromise --reason "<incident>" --by "<your name>"
```

The command moves the values at once and stops at `settling`. The worker finishes the rotation after the settle period. Open an incident and a breach assessment as ADR-007 §11 requires. Rotating at a company's request uses `--trigger request`.

Root-key rotation is done in the KMS (yearly, automatic). It needs no action here, because existing wrapped keys still unwrap.

## 2. Erasure ledger bucket (set up once per region)

- Use a bucket separate from media and from database backups, in the company's data region.
- Turn on versioning and **object lock in compliance mode**, with default retention at least as long as the longest backup retention plus one year (set with #28).
- Give the API's ledger credentials permission to put, get and list objects only, never to delete. Give the restore operators read access.
- Set `ERASURE_LEDGER_BUCKET` for the API, the worker and the operator tool.

Entries hold identifiers, times, the request reference and the operator's name. They never hold personal data. The request reference must be a ticket or case number, never the person's name; the tool refuses spaces.

## 3. Restore from backup (any restore, including point-in-time)

The restored database must not serve traffic until the ledger has been replayed. Otherwise erased people and closed companies would reappear (threat T-14).

1. Restore into an isolated database. Do not start the API or the worker against it.
2. Run migrations if the backup predates the current release.
3. Dry run:
   ```
   data-protection replay-ledger --dry-run
   ```
   It lists how many contacts would be erased again and how many company keys destroyed again. It also reports entries for records the backup does not contain. Those are expected when the backup predates them.
4. Replay:
   ```
   data-protection replay-ledger
   ```
   It exits with status 1 if any entry failed; the failures are listed. Fix the cause (usually the key provider or ledger access), then run it again. Replay is idempotent.
5. Check a sample: one recently erased contact shows "Erased contact" with no details, and one live contact's protected value still reveals.
6. Only then point the API and the worker at the restored database.

If a `company_data_keys` row was lost or damaged (ADR-007 §11), restore that row from backup, then run step 4: a destroyed key in the ledger is destroyed again.

## 4. Erasing a person (verified data-subject request)

Until the data-subject request register (gap G3) is built, erasure is carried out by an operator on a verified request:

1. Confirm the request is verified and logged with a reference (for example `DSR-2026-0042`), and that no legal hold applies.
2. Find the contact's id in the company (the request names the company).
3. Run:
   ```
   data-protection erase-contact --company <uuid> --contact <uuid> --reference DSR-2026-0042 --by "<your name>"
   ```

The command refuses in these cases, and changes nothing:

| Case | What to do |
|---|---|
| Organisation | Not personal data. Archive instead |
| Merged record | Erase the contact it was merged into. Its merged records are erased with it |
| Financial or contractual records (payment accounts, leases, ledger entries, statements, payouts…) | The law requires us to keep these. Record the refusal and its legal basis on the request |
| Ledger unreachable | Nothing is erased. Fix ledger access and run again |

What erasure does: see ADR-007 §8 and the milestone report §1. Names, contact details, protected values, notes and the address are removed. Free text about the person is replaced with "[Erased]", including earlier versions and audit change values. Records other people need keep their facts.

Erased data remains in database backups until they age out; the privacy notice says so (risk R-2). The ledger makes sure a restore does not bring it back.

## 5. Closing a company (crypto-shredding)

1. The company must already be `cancelled`, with its retention obligations handled (#20).
2. Run:
   ```
   data-protection shred-company --company <uuid> --confirm <company-slug> --reference CLOSE-<n> --by "<your name>"
   ```

Every field and lookup key of the company is destroyed. Its protected values can no longer be read anywhere, nor can new ones be written. Running API processes may keep an unwrapped key in memory for up to `FIELD_KEY_CACHE_TTL_SECONDS` (5 minutes). The company is cancelled, so its members cannot use it in that time.

## 6. Drills

| Drill | When | How | Record |
|---|---|---|---|
| Restore and replay (automated) | Every CI run | `apps/api/test/data-protection.e2e.test.ts`, "restore drill": puts back pre-erasure rows and destroyed keys as a restore would, replays the ledger, and checks the person is erased and the keys destroyed again | CI run |
| Restore and replay (real backup) | Before launch, then every 6 months | Section 3 against a real backup in a staging copy; record durations, counts and the sample checks | Issue #17 comment |
| Emergency rotation | Before launch, then yearly | Section 1.2 on a staging company; confirm reveals still work and the old key is destroyed | Issue #17 comment |
