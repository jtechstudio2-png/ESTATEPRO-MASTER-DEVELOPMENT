# P6-0 · Implementation notes: history order and sales-record protection

For engineers building Phase 6 (and later phases). Decisions and reasons are in [ADR-008](../decisions/ADR-008-sales-records-integrity-retention-erasure.md); results are in the [P6-0 report](P6-0-REPORT.md).

## 1. What changed

| Area | Files |
|---|---|
| Insertion order (#15) | `database/migrations/0029_history_order_15.sql` |
| Sales-record integrity, erasure, retention, accountant grants | `database/migrations/0030_sales_records_protection.sql` |
| History cursors | `apps/api/src/common/list-query.ts` (`TieBreak`, `encodeEntryCursor`, `toEntryPage`, `keysetEntryCondition`) |
| Readers now ordered by (time, `entry_no`) | `listings.service.ts` (status history, price history, listing history), `properties.service.ts` (property activity), `keys.service.ts` (key movements), `crm/leads.service.ts` (status history, assignments), `privacy/requests.service.ts` (events, evidence), `contacts/contacts.service.ts` (consent in force, consent history, latest identity check), `contacts/kyc.service.ts` (a contact's checks), `exports/exports.service.ts` (marketing consent in force), `privacy/access-report.ts` (consents, checks), `properties/owner-identity.ts` (owner verified) |
| Controllers parsing history cursors | `listings.controller.ts` (three history endpoints), `properties.controller.ts` (activity), `keys.controller.ts` (movements) |
| Erasure blocker messages | `privacy/requests.service.ts` (API text), `web/src/components/privacy/request-record.tsx` and `privacy.json` (en, ar) |
| Tests | `database/tests/12_sales_records_p6_0.sql`, `apps/api/test/p6-0-sales-records.e2e.test.ts`, `apps/api/test/list-query.test.ts` |

No public response shape changed. History cursors changed format (§3).

## 2. Writing history rows

Every history or audit table has `entry_no bigint NOT NULL` with a sequence default. Never set it; the database does, and refuses any later change (`42501`, trigger `<table>_entry_no_fixed`).

When you add a new history table:

```sql
CREATE TABLE something_history (
  id          uuid        PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id  uuid        NOT NULL,
  ...
  changed_at  timestamptz NOT NULL DEFAULT now(),
  entry_no    bigint      NOT NULL GENERATED ALWAYS AS IDENTITY   -- new, empty table: identity is fine
);
CREATE INDEX something_history_idx ON something_history (company_id, parent_id, changed_at, entry_no);
CREATE TRIGGER something_history_entry_no_fixed BEFORE UPDATE OF entry_no ON something_history
  FOR EACH ROW WHEN (OLD.entry_no IS DISTINCT FROM NEW.entry_no) EXECUTE FUNCTION app.entry_no_fixed();
```

Identity is fine for a new empty table (not for a partitioned one: use a sequence). For an existing table with rows, follow migration 0029: number in visible order first, then attach a sequence, and grant `USAGE` on the sequence to every role that holds INSERT on the table (0029 reads them from `information_schema.role_table_grants`; `estatepro_auth` writes sign-in audit rows).

## 3. Reading histories

```ts
// Controller: history endpoints parse entry cursors.
const parsed = parseListQuery<'changedAt'>(query, HISTORY_SORT, {}, 'entry');

// Service
let qb = tx
  .selectFrom('somethingHistory as h')
  .select([...columns, sortValueSql('h.changedAt', 'timestamp').as('cursorValue')])
  .select(sql<string>`h.entry_no::text`.as('entryNoText'))
  .where('h.parentId', '=', id);
if (query.cursor) qb = qb.where(keysetEntryCondition('h.changedAt', 'h.entryNo', query.sort, query.cursor));
const rows = await qb.orderBy('h.changedAt', query.sort.direction).orderBy('h.entryNo', query.sort.direction).limit(query.limit + 1).execute();
return toEntryPage(rows, query.limit, (r) => r.cursorValue, (r) => r.entryNoText, toDto);
```

- Unpaged reads: `.orderBy(time).orderBy('entryNo')`.
- "Latest wins" reads (consent in force, latest check): `order by …, time desc, entry_no desc`.
- Record lists (contacts, listings, deals) keep `keysetCondition` and id cursors: their sort is not about write order.
- A history cursor is `{ v, n }`; a record cursor is `{ v, id }`. Each is refused where the other is expected (validation error, field `cursor`, "Load the first page again").

## 4. Sales pipeline rules the database enforces

| Table | Rule | Error |
|---|---|---|
| `deals` | Stage history is written on insert and on every `stage_id` change. To attach a note, run `select set_config('app.stage_note', $note, true)` in the same transaction immediately before the update; the trigger clears it after use, so it belongs to one stage change only | — |
| `deals` | A closed deal (won or lost) keeps its stage, type, listing, unit, currency, close time, lost reason and notes | `23514` |
| `deals` | One deal per lead | `23505` |
| `deal_stage_history` | The application cannot insert, update or delete | `42501` |
| `offers` | Inserted as `submitted`; listing and currency of the deal; open deal only; counter-offer answers an open offer of the other side | `23514` |
| `offers` | Terms and conditions never change | `42501` |
| `offers` | Status: submitted → countered, accepted, rejected, withdrawn, expired; accepted → withdrawn; `responded_at` changes only with the status | `23514` |
| `viewings` | Inserted as scheduled or confirmed; status moves forward only; cancelled needs a reason; rescheduled needs the new viewing; finished viewings only change `seller_feedback_shared` | `23514` |
| `deal_milestones` | What it is never changes; once completed, completion, due date and notes are fixed | `23514` |
| `sales_transactions` | Inserted as pending for the accepted offer of its deal and listing in its currency; pending → exchanged → completed → (rescinded), or fallen through / rescinded; terms fixed after exchange; recorded dates fixed | `23514` |
| `leads` | `converted_deal_id` points at the deal whose `lead_id` is this lead, and never changes once set | `23514` |
| All pipeline tables | The runtime role cannot delete | `42501` |

Map these errors to Problem responses in the S1–S3 services (`registerConstraintMessages` for named constraints; catch `23514`/`42501` from triggers and answer 409 or 422 with a clear message).

## 5. Erasure

`app.erase_contact` (migration 0026) now calls `app.erase_contact_sales(company, subjects, lead_ids)`, which anonymises the pipeline's free text and returns the ids it touched so their audit rows and outbox events are redacted too. It refuses to run outside an erasure.

`app.contact_erasure_blockers` adds:

| Code | API message (`erasure-blocked:<code>`) | Screen |
|---|---|---|
| `open_deal` | "This person is a party to a deal that is still open. Close the deal first." | `privacy.blocker.openDeal` |
| `sale_record` | "This person is a party to a recorded sale that is still in progress or within its retention period." | `privacy.blocker.saleRecord` |

Retention is read with `app.jurisdiction_rule(code, 'sales_records_retention_years', date)`, the SQL twin of `ListingSettingsService.jurisdictionRule`.

## 6. Running the migrations

- Both migrations run in one transaction each, as the migration owner (a maintenance role).
- 0029 rewrites each history table once (backfill) with its guards disabled only inside the migration, then builds new indexes. Measured cost in the P6-0 report §7. On a large production database, schedule it like any table rewrite; no production data exists yet.
- 0030 adds triggers and grants and replaces two functions; it does not rewrite data.
- Rollback: restore from backup (no down migrations, as in all earlier phases).

## 7. Testing new pipeline code

- SQL: extend `database/tests/12_sales_records_p6_0.sql` patterns (`test_assert`, `test_expect_error` with SQLSTATE).
- API: write rows inside `fx.db.transaction()` to reproduce same-instant ties and assert the order and the paging.
- Erasure: create the person's records, erase through `/privacy-requests/{id}/erase`, assert text is `[Erased]` and facts are kept.
