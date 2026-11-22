-- =============================================================================
-- EstatePro · Migration 0035 · Money integrity and tenancy records (P7-0)
-- =============================================================================
-- Controls on the lettings and statement tables of migrations 0008 and 0010,
-- before any lease, rent or payment feature is built (Phase 7 readiness §4):
--
--  1. #1  Posted rent charges keep their terms. They may only be waived or
--         cancelled, and only while nothing is allocated to them. Corrections
--         are rent_charge_adjustments (signed, with a reason and an approver,
--         in an open period); balances and allocation limits include them.
--  2. #2  A payment's terms are fixed once it leaves "pending", and its amount
--         is never below what is allocated from it.
--  3. #3  A payment becomes bounced, refunded or voided only once its net
--         allocation is zero. app.unwind_payment reverses its allocations and
--         sets the status in one transaction.
--  4. #13 Lines of an issued or void statement cannot change. A statement
--         moves draft → issued → void only; a correction is a new statement
--         that supersedes the voided one (same landlord, currency, period).
--  5. ADR-009 Tenancy records: erasure blockers for a live lease, an open
--         balance, a held deposit, an active management agreement and a
--         record within its retention period (jurisdiction rule
--         tenancy_records_retention_years; while no value is set, records are
--         kept and erasure stays blocked). app.erase_contact also anonymises
--         the free text of the lettings records; amounts, dates and statuses
--         are kept.
-- The database tests are database/tests/17_money_integrity_p7_0.sql and
-- 18_concurrency_p7_0.sql (#22).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Rent charge adjustments (#1)
-- -----------------------------------------------------------------------------
CREATE TABLE rent_charge_adjustments (
  id               uuid           PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id       uuid           NOT NULL,
  rent_charge_id   uuid           NOT NULL,
  -- Negative reduces what is owed (a credit); positive adds to it.
  amount           numeric(19,4)  NOT NULL CHECK (amount <> 0),
  reason           text           NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  adjusted_on      date           NOT NULL DEFAULT current_date,
  approved_by      uuid           NOT NULL,
  created_by       uuid,
  created_at       timestamptz    NOT NULL DEFAULT now(),
  entry_no         bigint         GENERATED ALWAYS AS IDENTITY,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, rent_charge_id) REFERENCES rent_charges (company_id, id),
  FOREIGN KEY (company_id, approved_by) REFERENCES company_memberships (company_id, id)
);
COMMENT ON TABLE rent_charge_adjustments IS 'Corrections to posted rent charges (#1): append-only, signed, with reason and approver.';
CREATE INDEX rent_charge_adjustments_charge_idx ON rent_charge_adjustments (company_id, rent_charge_id);
CREATE INDEX rent_charge_adjustments_approver_idx ON rent_charge_adjustments (company_id, approved_by);

-- An adjustment applies to a posted charge, and never takes what is owed below
-- what has already been paid (reverse an allocation first) or below zero.
CREATE FUNCTION app.rent_charge_adjustments_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  c rent_charges%ROWTYPE;
  adjusted numeric;
  paid numeric;
BEGIN
  SELECT * INTO c FROM rent_charges WHERE company_id = NEW.company_id AND id = NEW.rent_charge_id FOR UPDATE;
  IF c.status <> 'posted' THEN
    RAISE EXCEPTION 'charge % is % and cannot be adjusted', c.id, c.status USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(amount), 0) INTO adjusted FROM rent_charge_adjustments
   WHERE company_id = NEW.company_id AND rent_charge_id = NEW.rent_charge_id;
  SELECT coalesce(sum(amount), 0) INTO paid FROM payment_allocations
   WHERE company_id = NEW.company_id AND rent_charge_id = NEW.rent_charge_id;
  IF c.total_amount + adjusted + NEW.amount < 0 THEN
    RAISE EXCEPTION 'adjustment would take charge % below zero', c.id USING ERRCODE = 'check_violation';
  END IF;
  IF c.total_amount + adjusted + NEW.amount < paid THEN
    RAISE EXCEPTION 'adjustment would take charge % below the % already paid; reverse an allocation first', c.id, paid
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER rent_charge_adjustments_validate BEFORE INSERT ON rent_charge_adjustments
  FOR EACH ROW EXECUTE FUNCTION app.rent_charge_adjustments_validate();
CREATE TRIGGER rent_charge_adjustments_open_period BEFORE INSERT ON rent_charge_adjustments
  FOR EACH ROW EXECUTE FUNCTION app.enforce_open_period('adjusted_on');

-- Append-only; only an erasure may blank the reason (ADR-009).
CREATE FUNCTION app.rent_charge_adjustments_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND app.erasure_in_progress() AND NEW.reason = '[Erased]'
     AND (to_jsonb(OLD) - 'reason') = (to_jsonb(NEW) - 'reason') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% on rent_charge_adjustments is not allowed: adjustments are append-only; record a further adjustment', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
CREATE TRIGGER rent_charge_adjustments_guard BEFORE UPDATE OR DELETE ON rent_charge_adjustments
  FOR EACH ROW EXECUTE FUNCTION app.rent_charge_adjustments_guard();

ALTER TABLE rent_charge_adjustments ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON rent_charge_adjustments FOR ALL TO estatepro_app
  USING (company_id = app.current_company_id()) WITH CHECK (company_id = app.current_company_id());
GRANT SELECT, INSERT ON rent_charge_adjustments TO estatepro_app;
GRANT SELECT ON rent_charge_adjustments TO estatepro_platform;

-- -----------------------------------------------------------------------------
-- 2. Posted rent charges keep their terms (#1)
-- -----------------------------------------------------------------------------
-- scheduled: editable; posted or cancelled, or deleted.
-- posted:    terms fixed; waived or cancelled only while nothing is allocated.
-- waived, cancelled: final.
CREATE FUNCTION app.rent_charges_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  net numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'scheduled' THEN
      RAISE EXCEPTION 'charge % is % and cannot be deleted; waive or cancel it instead', OLD.id, OLD.status
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'scheduled' THEN
    IF NEW.status NOT IN ('scheduled', 'posted', 'cancelled') THEN
      RAISE EXCEPTION 'a scheduled charge can only be posted or cancelled' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- total_amount is generated from amount and tax_amount (compared here); BEFORE triggers see it as NULL.
  IF (to_jsonb(OLD) - ARRAY['status', 'waived_reason', 'updated_at', 'version', 'total_amount'])
     IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['status', 'waived_reason', 'updated_at', 'version', 'total_amount']) THEN
    RAISE EXCEPTION 'charge % is % and its terms cannot change; record an adjustment instead', OLD.id, OLD.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status <> 'posted' OR NEW.status NOT IN ('waived', 'cancelled') THEN
      RAISE EXCEPTION 'a % charge cannot become %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    SELECT coalesce(sum(amount), 0) INTO net FROM payment_allocations
     WHERE company_id = OLD.company_id AND rent_charge_id = OLD.id;
    IF net <> 0 THEN
      RAISE EXCEPTION 'charge % has % allocated; reverse the allocations before it is waived or cancelled', OLD.id, net
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.waived_reason IS DISTINCT FROM OLD.waived_reason
        AND NOT (app.erasure_in_progress() AND NEW.waived_reason = '[Erased]') THEN
    RAISE EXCEPTION 'the reason of charge % is fixed once it is waived or cancelled', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER rent_charges_guard BEFORE UPDATE OR DELETE ON rent_charges
  FOR EACH ROW EXECUTE FUNCTION app.rent_charges_guard();

-- Balances include adjustments (columns appended; existing columns unchanged).
CREATE OR REPLACE VIEW rent_charge_balances WITH (security_invoker = true) AS
SELECT c.company_id,
       c.id AS rent_charge_id,
       c.lease_id,
       c.charge_type,
       c.due_date,
       c.currency_code,
       c.total_amount,
       coalesce(a.paid, 0) AS paid_amount,
       c.total_amount + coalesce(j.adjusted, 0) - coalesce(a.paid, 0) AS outstanding_amount,
       coalesce(j.adjusted, 0) AS adjustment_amount,
       c.total_amount + coalesce(j.adjusted, 0) AS adjusted_total_amount
  FROM rent_charges c
  LEFT JOIN (SELECT company_id, rent_charge_id, sum(amount) AS paid
               FROM payment_allocations GROUP BY company_id, rent_charge_id) a
         ON a.company_id = c.company_id AND a.rent_charge_id = c.id
  LEFT JOIN (SELECT company_id, rent_charge_id, sum(amount) AS adjusted
               FROM rent_charge_adjustments GROUP BY company_id, rent_charge_id) j
         ON j.company_id = c.company_id AND j.rent_charge_id = c.id
 WHERE c.status = 'posted';

-- Allocation guards (migration 0008) now count adjustments in what a charge owes.
CREATE OR REPLACE FUNCTION app.payment_allocations_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  p payments%ROWTYPE;
  c rent_charges%ROWTYPE;
  payment_used numeric;
  charge_paid numeric;
  charge_adjusted numeric;
BEGIN
  SELECT * INTO p FROM payments WHERE company_id = NEW.company_id AND id = NEW.payment_id FOR UPDATE;
  SELECT * INTO c FROM rent_charges WHERE company_id = NEW.company_id AND id = NEW.rent_charge_id FOR UPDATE;

  IF NEW.amount > 0 THEN
    IF p.status <> 'cleared' THEN
      RAISE EXCEPTION 'payment % is % and cannot be allocated until cleared', p.reference, p.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF c.status <> 'posted' THEN
      RAISE EXCEPTION 'charge % is % and cannot receive allocations', c.id, c.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF p.currency_code <> c.currency_code THEN
    RAISE EXCEPTION 'payment currency % does not match charge currency %', p.currency_code, c.currency_code
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.reversal_of_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM payment_allocations
        WHERE company_id = NEW.company_id AND id = NEW.reversal_of_id
          AND payment_id = NEW.payment_id AND rent_charge_id = NEW.rent_charge_id
          AND amount = -NEW.amount) THEN
    RAISE EXCEPTION 'a reversal must exactly negate the original allocation'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT coalesce(sum(amount), 0) INTO payment_used FROM payment_allocations
   WHERE company_id = NEW.company_id AND payment_id = NEW.payment_id;
  SELECT coalesce(sum(amount), 0) INTO charge_paid FROM payment_allocations
   WHERE company_id = NEW.company_id AND rent_charge_id = NEW.rent_charge_id;
  SELECT coalesce(sum(amount), 0) INTO charge_adjusted FROM rent_charge_adjustments
   WHERE company_id = NEW.company_id AND rent_charge_id = NEW.rent_charge_id;

  IF payment_used + NEW.amount > p.amount THEN
    RAISE EXCEPTION 'allocation exceeds unallocated amount of payment %', p.reference
      USING ERRCODE = 'check_violation';
  END IF;
  IF charge_paid + NEW.amount > c.total_amount + charge_adjusted THEN
    RAISE EXCEPTION 'allocation exceeds outstanding amount of charge %', c.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

-- -----------------------------------------------------------------------------
-- 3. Payments keep their terms; reversal before void, bounce or refund (#2, #3)
-- -----------------------------------------------------------------------------
-- pending → cleared, bounced, voided; cleared → bounced, refunded, voided;
-- bounced, refunded, voided: final. Leaving "pending" fixes who paid, how much,
-- when, into which account and with which instrument.
CREATE FUNCTION app.payments_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  net numeric;
  col text;
  fixed text[] := ARRAY['reference', 'payer_contact_id', 'lease_id', 'bank_account_id', 'method_code', 'currency_code', 'amount',
                        'received_on', 'instrument_number', 'instrument_date', 'instrument_bank', 'provider', 'provider_reference',
                        'idempotency_key', 'recorded_by', 'created_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'pending'
       OR EXISTS (SELECT 1 FROM payment_allocations WHERE company_id = OLD.company_id AND payment_id = OLD.id) THEN
      RAISE EXCEPTION 'payment % is % and cannot be deleted; void it instead', OLD.reference, OLD.status
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'pending' THEN
    FOREACH col IN ARRAY fixed LOOP
      IF to_jsonb(OLD) -> col IS DISTINCT FROM to_jsonb(NEW) -> col THEN
        -- An erasure (ADR-009) may blank the cheque details; nothing else changes.
        CONTINUE WHEN app.erasure_in_progress() AND col IN ('instrument_number', 'instrument_bank') AND to_jsonb(NEW) ->> col IS NULL;
        RAISE EXCEPTION 'payment % is %: % cannot change; void it and record a new payment', OLD.reference, OLD.status, col
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END LOOP;
  END IF;
  SELECT coalesce(sum(amount), 0) INTO net FROM payment_allocations
   WHERE company_id = OLD.company_id AND payment_id = OLD.id;
  IF NEW.amount < net THEN
    RAISE EXCEPTION 'payment % cannot be less than the % already allocated', OLD.reference, net
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'pending' AND NEW.status IN ('cleared', 'bounced', 'voided'))
            OR (OLD.status = 'cleared' AND NEW.status IN ('bounced', 'refunded', 'voided'))) THEN
      RAISE EXCEPTION 'a % payment cannot become %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status IN ('bounced', 'refunded', 'voided') AND net <> 0 THEN
      RAISE EXCEPTION 'payment % still has % allocated; reverse its allocations first', OLD.reference, net
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER payments_guard BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION app.payments_guard();

-- Reverses every allocation of a payment that is not yet reversed and sets the
-- payment's status, in the caller's transaction (#3). Used by the payment
-- actions (bounce, refund, void). Returns the number of allocations reversed.
CREATE FUNCTION app.unwind_payment(p_payment uuid, p_status text, p_reason text, p_on date) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  company uuid := app.current_company_id();
  p payments%ROWTYPE;
  n integer := 0;
  a record;
BEGIN
  IF p_status NOT IN ('bounced', 'refunded', 'voided') THEN
    RAISE EXCEPTION 'status must be bounced, refunded or voided' USING ERRCODE = 'check_violation';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'a reason is required' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO p FROM payments WHERE company_id = company AND id = p_payment FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment not found' USING ERRCODE = 'no_data_found';
  END IF;
  FOR a IN
    SELECT o.id, o.rent_charge_id, o.amount FROM payment_allocations o
     WHERE o.company_id = company AND o.payment_id = p_payment AND o.amount > 0
       AND NOT EXISTS (SELECT 1 FROM payment_allocations r WHERE r.company_id = company AND r.reversal_of_id = o.id)
     ORDER BY o.id
  LOOP
    INSERT INTO payment_allocations (company_id, payment_id, rent_charge_id, amount, reversal_of_id, allocated_on, allocated_by)
    VALUES (company, p_payment, a.rent_charge_id, -a.amount, a.id, p_on, nullif(current_setting('app.user_id', true), '')::uuid);
    n := n + 1;
  END LOOP;
  UPDATE payments SET status = p_status, status_reason = p_reason, updated_at = now(), version = version + 1
   WHERE company_id = company AND id = p_payment;
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION app.unwind_payment(uuid, text, text, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.unwind_payment(uuid, text, text, date) TO estatepro_app;

-- -----------------------------------------------------------------------------
-- 4. Statements: issued lines are final; corrections supersede (#13)
-- -----------------------------------------------------------------------------
ALTER TABLE statements ADD COLUMN supersedes_statement_id uuid;
ALTER TABLE statements ADD CONSTRAINT statements_supersedes_fk
  FOREIGN KEY (company_id, supersedes_statement_id) REFERENCES statements (company_id, id);
ALTER TABLE statements ADD CONSTRAINT statements_supersedes_other CHECK (supersedes_statement_id IS NULL OR supersedes_statement_id <> id);
CREATE UNIQUE INDEX statements_one_correction_idx ON statements (company_id, supersedes_statement_id)
  WHERE supersedes_statement_id IS NOT NULL;
COMMENT ON COLUMN statements.supersedes_statement_id IS 'The voided statement this one corrects (#13): same landlord, currency and period';

-- draft → issued or void; issued → void; void final. A correction names a void
-- statement of the same landlord, currency and period.
CREATE FUNCTION app.statements_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  prior statements%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status
     AND NOT ((OLD.status = 'draft' AND NEW.status IN ('issued', 'void')) OR (OLD.status = 'issued' AND NEW.status = 'void')) THEN
    RAISE EXCEPTION 'a % statement cannot become %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.supersedes_statement_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.supersedes_statement_id IS DISTINCT FROM OLD.supersedes_statement_id) THEN
    SELECT * INTO prior FROM statements WHERE company_id = NEW.company_id AND id = NEW.supersedes_statement_id;
    IF prior.status IS DISTINCT FROM 'void' OR prior.landlord_contact_id <> NEW.landlord_contact_id
       OR prior.currency_code <> NEW.currency_code OR prior.period_start <> NEW.period_start OR prior.period_end <> NEW.period_end THEN
      RAISE EXCEPTION 'a correction supersedes a void statement of the same landlord, currency and period'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER statements_guard BEFORE INSERT OR UPDATE ON statements
  FOR EACH ROW EXECUTE FUNCTION app.statements_guard();

-- No line of an issued or void statement may be added, changed or removed,
-- whatever the role (triggers apply to every role, including the platform role).
CREATE FUNCTION app.statement_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT status INTO parent_status FROM statements
   WHERE company_id = coalesce(NEW.company_id, OLD.company_id)
     AND id = coalesce(NEW.statement_id, OLD.statement_id);
  IF parent_status IN ('issued', 'void') THEN
    RAISE EXCEPTION 'statement lines cannot change once the statement is %; issue a correcting statement', parent_status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.company_id, OLD.statement_id) IS DISTINCT FROM (NEW.company_id, NEW.statement_id) THEN
    SELECT status INTO parent_status FROM statements WHERE company_id = OLD.company_id AND id = OLD.statement_id;
    IF parent_status IN ('issued', 'void') THEN
      RAISE EXCEPTION 'a line cannot be moved off a % statement', parent_status USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN coalesce(NEW, OLD);
END
$$;
CREATE TRIGGER statement_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON statement_lines
  FOR EACH ROW EXECUTE FUNCTION app.statement_lines_guard();

-- -----------------------------------------------------------------------------
-- 5. Tenancy records (ADR-009): retention rule
-- -----------------------------------------------------------------------------
INSERT INTO jurisdiction_setting_definitions (key, data_type, description, default_value) VALUES
  ('tenancy_records_retention_years', 'integer',
   'Years a lease''s records (charges, receipts, deposit) are kept after it ends before its parties may be erased (ADR-009). No value: kept, erasure blocked', NULL);

-- When a tenancy record's retention period still runs (no rule: always).
CREATE FUNCTION app.tenancy_retained(p_jurisdiction text, p_from date) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN r IS NULL OR jsonb_typeof(r) <> 'number' THEN true
           ELSE p_from + make_interval(years => (r)::text::int) > current_date
         END
    FROM (SELECT app.jurisdiction_rule(p_jurisdiction, 'tenancy_records_retention_years', current_date) AS r) x
$$;
GRANT EXECUTE ON FUNCTION app.tenancy_retained(text, date) TO estatepro_app, estatepro_platform;

-- -----------------------------------------------------------------------------
-- 6. Erasure blockers (ADR-008 and ADR-009)
-- -----------------------------------------------------------------------------
-- The lettings references that block a merge (lease parties, payers, landlords
-- of agreements) no longer block erasure as such; the specific ADR-009 rules
-- below decide. Every other merge blocker still blocks erasure.
CREATE OR REPLACE FUNCTION app.contact_erasure_blockers(p_contact uuid) RETURNS text[]
LANGUAGE plpgsql STABLE AS $$
DECLARE
  company uuid := app.current_company_id();
  kind text;
  blockers text[] := '{}';
  subjects uuid[];
  lease_ids uuid[];
BEGIN
  SELECT contact_type INTO kind FROM contacts WHERE company_id = company AND id = p_contact;
  IF kind IS NULL THEN
    RETURN blockers;
  END IF;
  IF kind <> 'person' THEN
    blockers := blockers || 'organisation'::text;
  END IF;
  -- Merged-away records of the person are erased with them, so their records count too.
  SELECT array_agg(c.id) INTO subjects FROM contacts c
   WHERE c.company_id = company AND (c.id = p_contact OR c.merged_into_contact_id = p_contact);
  SELECT blockers || coalesce(array_agg(DISTINCT b), '{}') INTO blockers
    FROM unnest(subjects) AS s(id) CROSS JOIN LATERAL unnest(app.contact_merge_blockers(s.id)) AS b
   WHERE b NOT IN ('lease_parties', 'payments', 'management_agreements');
  -- A party to a deal that is still open (ADR-008).
  IF EXISTS (
       SELECT 1 FROM deals d
        WHERE d.company_id = company AND d.status = 'open' AND d.archived_at IS NULL
          AND (d.primary_contact_id = ANY (subjects)
               OR EXISTS (SELECT 1 FROM deal_parties p WHERE p.company_id = company AND p.deal_id = d.id AND p.contact_id = ANY (subjects)))) THEN
    blockers := blockers || 'open_deal'::text;
  END IF;
  -- A party to a recorded sale that is open, or completed and within its retention period (ADR-008).
  IF EXISTS (
       SELECT 1 FROM sales_transactions t
         JOIN deals d ON d.company_id = t.company_id AND d.id = t.deal_id
         JOIN units u ON u.company_id = t.company_id AND u.id = t.unit_id
         JOIN properties pr ON pr.company_id = u.company_id AND pr.id = u.property_id
        WHERE t.company_id = company
          AND (d.primary_contact_id = ANY (subjects)
               OR EXISTS (SELECT 1 FROM deal_parties p WHERE p.company_id = company AND p.deal_id = d.id AND p.contact_id = ANY (subjects)))
          AND (t.status IN ('pending', 'exchanged')
               OR (t.status = 'completed' AND (
                     app.jurisdiction_rule(pr.jurisdiction_code, 'sales_records_retention_years', current_date) IS NULL
                     OR jsonb_typeof(app.jurisdiction_rule(pr.jurisdiction_code, 'sales_records_retention_years', current_date)) <> 'number'
                     OR t.completed_on + make_interval(years => (app.jurisdiction_rule(pr.jurisdiction_code, 'sales_records_retention_years', current_date))::text::int) > current_date)))) THEN
    blockers := blockers || 'sale_record'::text;
  END IF;

  -- Lettings (ADR-009).
  SELECT coalesce(array_agg(DISTINCT lp.lease_id), '{}') INTO lease_ids FROM lease_parties lp
   WHERE lp.company_id = company AND lp.contact_id = ANY (subjects);
  -- A lease that has not closed: in preparation, running, under notice, or ended but not settled.
  IF EXISTS (SELECT 1 FROM leases l WHERE l.company_id = company AND l.id = ANY (lease_ids)
                AND l.status IN ('draft', 'pending_signature', 'active', 'periodic', 'notice_given', 'ended')) THEN
    blockers := blockers || 'live_lease'::text;
  END IF;
  -- Money still owed on a lease of theirs, or received from them and not yet allocated.
  IF EXISTS (SELECT 1 FROM rent_charge_balances b WHERE b.company_id = company AND b.lease_id = ANY (lease_ids) AND b.outstanding_amount <> 0)
     OR EXISTS (SELECT 1 FROM payments p
                 WHERE p.company_id = company AND p.payer_contact_id = ANY (subjects) AND p.status = 'cleared'
                   AND p.amount > coalesce((SELECT sum(a.amount) FROM payment_allocations a
                                             WHERE a.company_id = company AND a.payment_id = p.id), 0)) THEN
    blockers := blockers || 'open_balance'::text;
  END IF;
  -- A deposit not yet returned or forfeited.
  IF EXISTS (SELECT 1 FROM deposits d WHERE d.company_id = company AND d.lease_id = ANY (lease_ids)
                AND d.status NOT IN ('returned', 'forfeited')) THEN
    blockers := blockers || 'deposit_held'::text;
  END IF;
  -- Landlord of a management agreement that has not ended.
  IF EXISTS (SELECT 1 FROM management_agreements m WHERE m.company_id = company AND m.landlord_contact_id = ANY (subjects)
                AND m.status IN ('draft', 'active', 'suspended')) THEN
    blockers := blockers || 'management_agreement'::text;
  END IF;
  -- Records within their retention period: closed or cancelled leases with money recorded,
  -- receipts from the person, and ended management agreements.
  IF EXISTS (SELECT 1 FROM leases l
              WHERE l.company_id = company AND l.id = ANY (lease_ids) AND l.status IN ('closed', 'cancelled')
                AND (EXISTS (SELECT 1 FROM rent_charges c WHERE c.company_id = company AND c.lease_id = l.id)
                     OR EXISTS (SELECT 1 FROM payments p WHERE p.company_id = company AND p.lease_id = l.id)
                     OR EXISTS (SELECT 1 FROM deposits d WHERE d.company_id = company AND d.lease_id = l.id))
                AND app.tenancy_retained(l.jurisdiction_code, coalesce(l.move_out_date, l.end_date, l.updated_at::date)))
     OR EXISTS (SELECT 1 FROM payments p
                  JOIN bank_accounts ba ON ba.company_id = p.company_id AND ba.id = p.bank_account_id
                  LEFT JOIN leases l ON l.company_id = p.company_id AND l.id = p.lease_id
                 WHERE p.company_id = company AND p.payer_contact_id = ANY (subjects)
                   AND app.tenancy_retained(coalesce(l.jurisdiction_code, ba.country_code), p.received_on))
     OR EXISTS (SELECT 1 FROM management_agreements m
                  JOIN properties pr ON pr.company_id = m.company_id AND pr.id = m.property_id
                 WHERE m.company_id = company AND m.landlord_contact_id = ANY (subjects) AND m.status = 'ended'
                   AND app.tenancy_retained(pr.jurisdiction_code, coalesce(m.end_date, m.updated_at::date))) THEN
    blockers := blockers || 'tenancy_record'::text;
  END IF;
  RETURN blockers;
END;
$$;

-- -----------------------------------------------------------------------------
-- 7. Erasure of lettings free text (called by app.erase_contact)
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.erase_contact_tenancy(company uuid, subjects uuid[]) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  lease_ids uuid[];
  payment_ids uuid[];
  deposit_ids uuid[];
  inspection_ids uuid[];
  charge_ids uuid[];
  n bigint;
  counts jsonb := '{}'::jsonb;
BEGIN
  IF NOT app.erasure_in_progress() THEN
    RAISE EXCEPTION 'only an erasure may call this' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT coalesce(array_agg(DISTINCT lease_id), '{}') INTO lease_ids FROM lease_parties
   WHERE company_id = company AND contact_id = ANY (subjects);
  SELECT coalesce(array_agg(id), '{}') INTO payment_ids FROM payments
   WHERE company_id = company AND payer_contact_id = ANY (subjects);
  SELECT coalesce(array_agg(id), '{}') INTO deposit_ids FROM deposits WHERE company_id = company AND lease_id = ANY (lease_ids);
  SELECT coalesce(array_agg(id), '{}') INTO inspection_ids FROM inspections WHERE company_id = company AND lease_id = ANY (lease_ids);
  SELECT coalesce(array_agg(id), '{}') INTO charge_ids FROM rent_charges WHERE company_id = company AND lease_id = ANY (lease_ids);

  UPDATE leases
     SET ended_reason = CASE WHEN ended_reason IS NULL THEN NULL ELSE '[Erased]' END, custom_fields = '{}'::jsonb
   WHERE company_id = company AND id = ANY (lease_ids) AND (ended_reason IS NOT NULL OR custom_fields <> '{}'::jsonb);
  IF cardinality(lease_ids) > 0 THEN counts := counts || jsonb_build_object('leases', cardinality(lease_ids)); END IF;
  UPDATE arrears_actions SET notes = '[Erased]' WHERE company_id = company AND lease_id = ANY (lease_ids) AND notes IS NOT NULL;
  UPDATE rent_reviews SET notes = '[Erased]' WHERE company_id = company AND lease_id = ANY (lease_ids) AND notes IS NOT NULL;
  UPDATE rent_charges SET waived_reason = '[Erased]' WHERE company_id = company AND id = ANY (charge_ids) AND waived_reason IS NOT NULL;
  UPDATE rent_charge_adjustments SET reason = '[Erased]' WHERE company_id = company AND rent_charge_id = ANY (charge_ids) AND reason <> '[Erased]';
  UPDATE inspections SET summary = '[Erased]' WHERE company_id = company AND id = ANY (inspection_ids) AND summary IS NOT NULL;
  UPDATE inspection_items SET notes = '[Erased]' WHERE company_id = company AND inspection_id = ANY (inspection_ids) AND notes IS NOT NULL;
  UPDATE deposit_deductions SET description = '[Erased]' WHERE company_id = company AND deposit_id = ANY (deposit_ids) AND description <> '[Erased]';

  UPDATE payments
     SET notes = CASE WHEN notes IS NULL THEN NULL ELSE '[Erased]' END,
         status_reason = CASE WHEN status_reason IS NULL THEN NULL ELSE '[Erased]' END,
         instrument_number = NULL, instrument_bank = NULL
   WHERE company_id = company AND id = ANY (payment_ids)
     AND (notes IS NOT NULL OR status_reason IS NOT NULL OR instrument_number IS NOT NULL OR instrument_bank IS NOT NULL);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN counts := counts || jsonb_build_object('payments', n); END IF;

  RETURN counts || jsonb_build_object('touched', to_jsonb(lease_ids || payment_ids || deposit_ids || inspection_ids || charge_ids));
END;
$$;
REVOKE ALL ON FUNCTION app.erase_contact_tenancy(uuid, uuid[]) FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- 8. app.erase_contact (migration 0030) now also erases the lettings free text
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.erase_contact(p_contact uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  company uuid := app.current_company_id();
  target record;
  blockers text[];
  subjects uuid[];
  lead_ids uuid[];
  activity_ids uuid[];
  touched uuid[] := '{}';
  address_ids uuid[];
  method_ids uuid[];
  n bigint;
  counts jsonb := '{}'::jsonb;
  sales jsonb;
  tenancy jsonb;
BEGIN
  IF company IS NULL THEN
    RAISE EXCEPTION 'no company in context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT id, contact_type, is_anonymised, merged_into_contact_id INTO target
    FROM contacts WHERE company_id = company AND id = p_contact FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contact not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF target.is_anonymised THEN
    RETURN jsonb_build_object('alreadyErased', true);
  END IF;
  IF target.merged_into_contact_id IS NOT NULL THEN
    RAISE EXCEPTION 'contact % was merged; erase the contact it was merged into', p_contact USING ERRCODE = 'check_violation';
  END IF;
  blockers := app.contact_erasure_blockers(p_contact);
  IF cardinality(blockers) > 0 THEN
    RAISE EXCEPTION 'contact % cannot be erased: %', p_contact, array_to_string(blockers, ', ')
      USING ERRCODE = 'check_violation', DETAIL = array_to_string(blockers, ',');
  END IF;

  PERFORM set_config('app.erasure', 'on', true);

  SELECT array_agg(id) INTO subjects FROM contacts
   WHERE company_id = company AND (id = p_contact OR merged_into_contact_id = p_contact);
  PERFORM 1 FROM contacts WHERE company_id = company AND id = ANY (subjects) FOR UPDATE;
  SELECT coalesce(array_agg(id), '{}') INTO lead_ids FROM leads WHERE company_id = company AND contact_id = ANY (subjects);
  SELECT coalesce(array_agg(DISTINCT activity_id), '{}') INTO activity_ids FROM activity_links
   WHERE company_id = company
     AND ((entity_type = 'contact' AND entity_id = ANY (subjects)) OR (entity_type = 'lead' AND entity_id = ANY (lead_ids)));
  touched := subjects || lead_ids || activity_ids;

  -- The person
  SELECT coalesce(array_agg(address_id), '{}') INTO address_ids FROM contacts
   WHERE company_id = company AND id = ANY (subjects) AND address_id IS NOT NULL;
  UPDATE contacts
     SET display_name = 'Erased contact', display_name_local = NULL, given_name = NULL, family_name = NULL,
         other_names = NULL, title = NULL, primary_email = NULL, primary_phone_e164 = NULL,
         nationality_country_code = NULL, residence_country_code = NULL, date_of_birth_encrypted = NULL,
         tax_number_encrypted = NULL, tax_number_hash = NULL, tax_number_last4 = NULL,
         organisation_reg_number_encrypted = NULL, address_id = NULL, notes = NULL, custom_fields = '{}'::jsonb,
         archived_reason = CASE WHEN archived_reason IS NULL THEN NULL ELSE '[Erased]' END,
         is_anonymised = true, version = version + 1
   WHERE company_id = company AND id = ANY (subjects);
  counts := counts || jsonb_build_object('contacts', cardinality(subjects));

  -- Addresses used only by this person are removed; a shared one is kept.
  DELETE FROM addresses a
   WHERE a.company_id = company AND a.id = ANY (address_ids)
     AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.company_id = company AND c.address_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM properties p WHERE p.company_id = company AND p.address_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM offices o WHERE o.company_id = company AND o.address_id = a.id);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN counts := counts || jsonb_build_object('addresses', n); END IF;

  SELECT coalesce(array_agg(id), '{}') INTO method_ids FROM contact_methods WHERE company_id = company AND contact_id = ANY (subjects);
  DELETE FROM contact_methods WHERE company_id = company AND id = ANY (method_ids);
  IF cardinality(method_ids) > 0 THEN counts := counts || jsonb_build_object('contact_methods', cardinality(method_ids)); END IF;
  touched := touched || method_ids;

  -- Records about the person keep their facts and lose personal data.
  UPDATE consents SET evidence = '[Erased]' WHERE company_id = company AND contact_id = ANY (subjects) AND evidence IS NOT NULL;
  UPDATE identity_documents
     SET number_encrypted = NULL, number_hash = NULL, number_last4 = NULL, erased_at = now(),
         archived_reason = CASE WHEN archived_reason IS NULL THEN NULL ELSE '[Erased]' END
   WHERE company_id = company AND contact_id = ANY (subjects) AND erased_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN counts := counts || jsonb_build_object('identity_documents', n); END IF;
  touched := touched || coalesce((SELECT array_agg(id) FROM identity_documents WHERE company_id = company AND contact_id = ANY (subjects)), '{}');

  UPDATE kyc_checks
     SET notes = CASE WHEN notes IS NULL THEN NULL ELSE '[Erased]' END,
         decision_reason = CASE WHEN decision_reason IS NULL THEN NULL ELSE '[Erased]' END
   WHERE company_id = company AND contact_id = ANY (subjects) AND (notes IS NOT NULL OR decision_reason IS NOT NULL);
  touched := touched || coalesce((SELECT array_agg(id) FROM kyc_checks WHERE company_id = company AND contact_id = ANY (subjects)), '{}');

  UPDATE requirements SET notes = NULL WHERE company_id = company AND contact_id = ANY (subjects) AND notes IS NOT NULL;
  touched := touched || coalesce((SELECT array_agg(id) FROM requirements WHERE company_id = company AND contact_id = ANY (subjects)), '{}');
  UPDATE requirement_exclusions e SET reason = '[Erased]'
    FROM requirements r
   WHERE e.company_id = company AND r.company_id = company AND r.id = e.requirement_id
     AND r.contact_id = ANY (subjects) AND e.reason IS NOT NULL;

  UPDATE leads
     SET message = CASE WHEN message IS NULL THEN NULL ELSE '[Erased]' END,
         source_detail = CASE WHEN source_detail IS NULL THEN NULL ELSE '[Erased]' END,
         custom_fields = '{}'::jsonb,
         archived_reason = CASE WHEN archived_reason IS NULL THEN NULL ELSE '[Erased]' END
   WHERE company_id = company AND id = ANY (lead_ids);
  IF cardinality(lead_ids) > 0 THEN counts := counts || jsonb_build_object('leads', cardinality(lead_ids)); END IF;
  UPDATE lead_status_history SET note = '[Erased]' WHERE company_id = company AND lead_id = ANY (lead_ids) AND note IS NOT NULL;
  UPDATE lead_assignments SET note = '[Erased]' WHERE company_id = company AND lead_id = ANY (lead_ids) AND note IS NOT NULL;

  UPDATE activities
     SET subject = CASE WHEN subject IS NULL THEN NULL ELSE '[Erased]' END,
         body = CASE WHEN body IS NULL THEN NULL ELSE '[Erased]' END,
         archived_reason = CASE WHEN archived_reason IS NULL THEN NULL ELSE '[Erased]' END
   WHERE company_id = company AND id = ANY (activity_ids);
  IF cardinality(activity_ids) > 0 THEN counts := counts || jsonb_build_object('activities', cardinality(activity_ids)); END IF;
  UPDATE activity_revisions
     SET subject = CASE WHEN subject IS NULL THEN NULL ELSE '[Erased]' END,
         body = CASE WHEN body IS NULL THEN NULL ELSE '[Erased]' END
   WHERE company_id = company AND activity_id = ANY (activity_ids) AND (subject IS NOT NULL OR body IS NOT NULL);

  UPDATE tasks
     SET title = '[Erased]',
         description = CASE WHEN description IS NULL THEN NULL ELSE '[Erased]' END,
         cancel_reason = CASE WHEN cancel_reason IS NULL THEN NULL ELSE '[Erased]' END
   WHERE company_id = company
     AND ((entity_type = 'contact' AND entity_id = ANY (subjects)) OR (entity_type = 'lead' AND entity_id = ANY (lead_ids)));
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN counts := counts || jsonb_build_object('tasks', n); END IF;
  touched := touched || coalesce((SELECT array_agg(id) FROM tasks WHERE company_id = company
     AND ((entity_type = 'contact' AND entity_id = ANY (subjects)) OR (entity_type = 'lead' AND entity_id = ANY (lead_ids)))), '{}');

  -- Sales pipeline (ADR-008): free text anonymised; amounts, dates, stages and statuses kept.
  sales := app.erase_contact_sales(company, subjects, lead_ids);
  counts := counts || (sales - 'touched');
  touched := touched || ARRAY(SELECT jsonb_array_elements_text(sales -> 'touched')::uuid);

  -- Lettings (ADR-009): free text anonymised; amounts, dates, terms and statuses kept.
  tenancy := app.erase_contact_tenancy(company, subjects);
  counts := counts || (tenancy - 'touched');
  touched := touched || ARRAY(SELECT jsonb_array_elements_text(tenancy -> 'touched')::uuid);

  -- Audit rows and outbox events about these records keep their shape, not values.
  UPDATE audit_logs
     SET changes = app.redact_json(changes), metadata = app.redact_json(metadata)
   WHERE company_id = company AND entity_id = ANY (touched)
     AND (changes IS DISTINCT FROM app.redact_json(changes) OR metadata IS DISTINCT FROM app.redact_json(metadata));
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN counts := counts || jsonb_build_object('audit_logs', n); END IF;
  UPDATE outbox_events SET payload = app.redact_json(payload)
   WHERE company_id = company AND aggregate_id = ANY (touched) AND payload IS DISTINCT FROM app.redact_json(payload);

  PERFORM set_config('app.erasure', 'off', true);
  RETURN counts || jsonb_build_object('erasedContactIds', to_jsonb(subjects));
END;
$$;

