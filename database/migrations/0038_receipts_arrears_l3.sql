-- =============================================================================
-- EstatePro · Migration 0038 · Receipts, bank-file import, arrears (L3)
-- =============================================================================
-- Phase 7 milestone L3 (readiness report §5.3, §5.4; P7-D7, P7-D8, P7-D10;
-- wireframes RP-1 to RP-7, AR-1, AR-2, ST-2):
--
--  1. Maintained balances (P7-0 R1). rent_charges.allocated_amount and
--     adjusted_amount, and payments.allocated_amount, are kept by triggers on
--     the append-only allocation and adjustment tables (in the same
--     transaction, under the row locks the allocation rule already takes).
--     Only those triggers may change them. rent_charge_balances reads them,
--     so balances, arrears and erasure blockers no longer total every
--     allocation of the company.
--  2. Bank-file import (P7-D7): payment_imports (one per checked file, kept as
--     a scanned document of the bank account) and payment_import_lines (each
--     line, its match, and its stable key so a file imported twice adds
--     nothing). Unmatched lines wait in a queue until a person matches them.
--  3. Arrears actions are append-only (notes erasable, ADR-009).
--  4. Payment plans: instalments checked (dates ascending, amounts positive,
--     summing to the total); one active plan per lease; active → completed,
--     broken or cancelled, then final.
--  5. Documents may belong to a bank account (bank statements, text/csv).
--  6. Erasure (ADR-009) also anonymises bank-file line texts and payment-plan
--     reasons of the person.
-- The database tests are database/tests/21_receipts_arrears_l3.sql.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Maintained balances
-- -----------------------------------------------------------------------------
ALTER TABLE rent_charges ADD COLUMN allocated_amount numeric(19,4) NOT NULL DEFAULT 0;
ALTER TABLE rent_charges ADD COLUMN adjusted_amount numeric(19,4) NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN allocated_amount numeric(19,4) NOT NULL DEFAULT 0;
COMMENT ON COLUMN rent_charges.allocated_amount IS 'Net allocated from receipts; kept by app.maintain_allocation_balances';
COMMENT ON COLUMN rent_charges.adjusted_amount IS 'Sum of adjustments; kept by app.maintain_adjustment_balance';
COMMENT ON COLUMN payments.allocated_amount IS 'Net allocated to charges; kept by app.maintain_allocation_balances';

CREATE FUNCTION app.maintain_allocation_balances() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.maintaining_balances', 'on', true);
  UPDATE rent_charges SET allocated_amount = allocated_amount + NEW.amount WHERE company_id = NEW.company_id AND id = NEW.rent_charge_id;
  UPDATE payments SET allocated_amount = allocated_amount + NEW.amount WHERE company_id = NEW.company_id AND id = NEW.payment_id;
  PERFORM set_config('app.maintaining_balances', 'off', true);
  RETURN NEW;
END
$$;
CREATE TRIGGER payment_allocations_balances AFTER INSERT ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION app.maintain_allocation_balances();

CREATE FUNCTION app.maintain_adjustment_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.maintaining_balances', 'on', true);
  UPDATE rent_charges SET adjusted_amount = adjusted_amount + NEW.amount WHERE company_id = NEW.company_id AND id = NEW.rent_charge_id;
  PERFORM set_config('app.maintaining_balances', 'off', true);
  RETURN NEW;
END
$$;
CREATE TRIGGER rent_charge_adjustments_balance AFTER INSERT ON rent_charge_adjustments
  FOR EACH ROW EXECUTE FUNCTION app.maintain_adjustment_balance();

-- Posted charges keep their terms (migration 0035); the balance columns are not terms.
CREATE OR REPLACE FUNCTION app.rent_charges_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  net numeric;
  ignored text[] := ARRAY['status', 'waived_reason', 'updated_at', 'version', 'total_amount', 'allocated_amount', 'adjusted_amount'];
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
  IF (to_jsonb(OLD) - ignored) IS DISTINCT FROM (to_jsonb(NEW) - ignored) THEN
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

-- Existing rows take their balances from the allocations and adjustments already recorded.
UPDATE rent_charges c SET allocated_amount = a.net
  FROM (SELECT company_id, rent_charge_id, sum(amount) AS net FROM payment_allocations GROUP BY company_id, rent_charge_id) a
 WHERE a.company_id = c.company_id AND a.rent_charge_id = c.id AND a.net <> 0;
UPDATE rent_charges c SET adjusted_amount = j.net
  FROM (SELECT company_id, rent_charge_id, sum(amount) AS net FROM rent_charge_adjustments GROUP BY company_id, rent_charge_id) j
 WHERE j.company_id = c.company_id AND j.rent_charge_id = c.id AND j.net <> 0;
UPDATE payments p SET allocated_amount = a.net
  FROM (SELECT company_id, payment_id, sum(amount) AS net FROM payment_allocations GROUP BY company_id, payment_id) a
 WHERE a.company_id = p.company_id AND a.payment_id = p.id AND a.net <> 0;

-- Only the maintenance triggers change the balance columns.
CREATE FUNCTION app.balances_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Inside the maintenance triggers (nested trigger depth, flag set by them) only.
  IF pg_trigger_depth() > 1 AND coalesce(current_setting('app.maintaining_balances', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  IF NEW.allocated_amount IS DISTINCT FROM OLD.allocated_amount
     OR (TG_TABLE_NAME = 'rent_charges' AND (to_jsonb(NEW) -> 'adjusted_amount') IS DISTINCT FROM (to_jsonb(OLD) -> 'adjusted_amount')) THEN
    RAISE EXCEPTION 'balances on % are kept from allocations and adjustments only', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER rent_charges_balances_guard BEFORE UPDATE ON rent_charges
  FOR EACH ROW EXECUTE FUNCTION app.balances_guard();
CREATE TRIGGER payments_balances_guard BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION app.balances_guard();
CREATE FUNCTION app.balances_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.allocated_amount <> 0 OR (TG_TABLE_NAME = 'rent_charges' AND (to_jsonb(NEW) ->> 'adjusted_amount')::numeric <> 0) THEN
    RAISE EXCEPTION 'balances on % start at zero', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER rent_charges_balances_insert BEFORE INSERT ON rent_charges
  FOR EACH ROW EXECUTE FUNCTION app.balances_insert_guard();
CREATE TRIGGER payments_balances_insert BEFORE INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION app.balances_insert_guard();

-- Same columns as migration 0035; read from the maintained balances.
CREATE OR REPLACE VIEW rent_charge_balances WITH (security_invoker = true) AS
SELECT c.company_id,
       c.id AS rent_charge_id,
       c.lease_id,
       c.charge_type,
       c.due_date,
       c.currency_code,
       c.total_amount,
       c.allocated_amount::numeric AS paid_amount,
       (c.total_amount + c.adjusted_amount - c.allocated_amount)::numeric AS outstanding_amount,
       c.adjusted_amount::numeric AS adjustment_amount,
       (c.total_amount + c.adjusted_amount)::numeric AS adjusted_total_amount
  FROM rent_charges c
 WHERE c.status = 'posted';

-- Posted charges with money owed, and cleared receipts with money unallocated.
CREATE INDEX rent_charges_open_idx ON rent_charges (company_id, lease_id, due_date)
  WHERE status = 'posted' AND allocated_amount <> amount + tax_amount + adjusted_amount;
CREATE INDEX payments_unallocated_idx ON payments (company_id, received_on, id)
  WHERE status = 'cleared' AND allocated_amount < amount;
CREATE INDEX payments_received_idx ON payments (company_id, received_on, id);
-- Allocations and adjustments after a date (arrears as of a past date).
CREATE INDEX payment_allocations_on_idx ON payment_allocations (company_id, allocated_on);
CREATE INDEX rent_charge_adjustments_on_idx ON rent_charge_adjustments (company_id, adjusted_on);

-- -----------------------------------------------------------------------------
-- 2. Bank-file import
-- -----------------------------------------------------------------------------
CREATE TABLE payment_imports (
  id               uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id       uuid         NOT NULL,
  bank_account_id  uuid         NOT NULL,
  document_id      uuid         NOT NULL,
  format           text         NOT NULL DEFAULT 'estatepro_csv_v1' CHECK (format IN ('estatepro_csv_v1')),
  status           text         NOT NULL DEFAULT 'checked' CHECK (status IN ('checked', 'committed', 'cancelled')),
  line_count       integer      NOT NULL CHECK (line_count >= 0),
  created_by       uuid,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  committed_by     uuid,
  committed_at     timestamptz,
  updated_at       timestamptz  NOT NULL DEFAULT now(),
  version          integer      NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, bank_account_id) REFERENCES bank_accounts (company_id, id),
  FOREIGN KEY (company_id, document_id) REFERENCES documents (company_id, id),
  FOREIGN KEY (company_id, created_by) REFERENCES company_memberships (company_id, id),
  FOREIGN KEY (company_id, committed_by) REFERENCES company_memberships (company_id, id),
  CHECK ((status = 'committed') = (committed_at IS NOT NULL))
);
COMMENT ON TABLE payment_imports IS 'Bank files checked for import (P7-D7); the file is a scanned document of the bank account';
CREATE INDEX payment_imports_account_idx ON payment_imports (company_id, bank_account_id, created_at DESC);
CREATE INDEX payment_imports_document_idx ON payment_imports (company_id, document_id);
CREATE INDEX payment_imports_created_by_idx ON payment_imports (company_id, created_by);
CREATE INDEX payment_imports_committed_by_idx ON payment_imports (company_id, committed_by);

CREATE TABLE payment_import_lines (
  id                uuid           PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id        uuid           NOT NULL,
  import_id         uuid           NOT NULL,
  line_no           integer        NOT NULL CHECK (line_no >= 1),
  txn_date          date,
  amount            numeric(19,4),
  currency_code     char(3),
  reference         text           CHECK (char_length(reference) <= 200),
  description       text           CHECK (char_length(description) <= 500),
  transaction_id    text           CHECK (char_length(transaction_id) <= 100),
  idempotency_key   text           NOT NULL,
  status            text           NOT NULL CHECK (status IN ('matched', 'unmatched', 'duplicate', 'error', 'imported', 'queued')),
  error_code        text,
  error_message     text,
  lease_id          uuid,
  payer_contact_id  uuid,
  payment_id        uuid,
  resolved_by       uuid,
  created_at        timestamptz    NOT NULL DEFAULT now(),
  updated_at        timestamptz    NOT NULL DEFAULT now(),
  version           integer        NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  UNIQUE (company_id, import_id, line_no),
  FOREIGN KEY (company_id, import_id) REFERENCES payment_imports (company_id, id),
  FOREIGN KEY (company_id, lease_id) REFERENCES leases (company_id, id),
  FOREIGN KEY (company_id, payer_contact_id) REFERENCES contacts (company_id, id),
  FOREIGN KEY (company_id, payment_id) REFERENCES payments (company_id, id),
  FOREIGN KEY (company_id, resolved_by) REFERENCES company_memberships (company_id, id),
  CHECK ((status = 'imported') = (payment_id IS NOT NULL)),
  CHECK (status <> 'error' OR error_code IS NOT NULL),
  CHECK (status IN ('error') OR (txn_date IS NOT NULL AND amount > 0 AND currency_code IS NOT NULL))
);
COMMENT ON TABLE payment_import_lines IS 'Lines of a bank file: matched, queued for a person, imported (with the receipt), duplicate or in error';
-- A line already imported or waiting in the queue is not imported or queued again (any file).
CREATE UNIQUE INDEX payment_import_lines_key_idx ON payment_import_lines (company_id, idempotency_key) WHERE status IN ('imported', 'queued');
CREATE INDEX payment_import_lines_queue_idx ON payment_import_lines (company_id, txn_date) WHERE status = 'queued';
CREATE INDEX payment_import_lines_lease_idx ON payment_import_lines (company_id, lease_id);
CREATE INDEX payment_import_lines_payer_idx ON payment_import_lines (company_id, payer_contact_id);
CREATE INDEX payment_import_lines_payment_idx ON payment_import_lines (company_id, payment_id);
CREATE INDEX payment_import_lines_resolved_idx ON payment_import_lines (company_id, resolved_by);

-- Checked lines are decided once: matched or unmatched lines are imported or
-- queued at commit, queued lines are imported when matched, and imported,
-- duplicate and error lines are final. The line's bank data never changes
-- (an erasure may blank its texts, ADR-009).
CREATE FUNCTION app.payment_import_lines_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  bank_data text[] := ARRAY['import_id', 'line_no', 'txn_date', 'amount', 'currency_code', 'transaction_id', 'idempotency_key', 'created_at'];
  col text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bank-file lines are not deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOREACH col IN ARRAY bank_data LOOP
    IF to_jsonb(OLD) -> col IS DISTINCT FROM to_jsonb(NEW) -> col THEN
      RAISE EXCEPTION 'the bank data of a file line is fixed' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;
  IF (NEW.reference IS DISTINCT FROM OLD.reference OR NEW.description IS DISTINCT FROM OLD.description)
     AND NOT (app.erasure_in_progress() AND coalesce(NEW.reference, '[Erased]') = '[Erased]' AND coalesce(NEW.description, '[Erased]') = '[Erased]') THEN
    RAISE EXCEPTION 'the bank data of a file line is fixed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status IN ('matched', 'unmatched') AND NEW.status IN ('imported', 'queued'))
    OR (OLD.status = 'queued' AND NEW.status = 'imported')) THEN
    RAISE EXCEPTION 'a % file line cannot become %', OLD.status, NEW.status USING ERRCODE = 'check_violation', DETAIL = 'import-line-transition';
  END IF;
  IF OLD.status IN ('imported', 'duplicate', 'error') AND (NEW.lease_id IS DISTINCT FROM OLD.lease_id OR NEW.payer_contact_id IS DISTINCT FROM OLD.payer_contact_id
                                                          OR NEW.payment_id IS DISTINCT FROM OLD.payment_id) THEN
    RAISE EXCEPTION 'a % file line is final', OLD.status USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER payment_import_lines_guard BEFORE UPDATE OR DELETE ON payment_import_lines
  FOR EACH ROW EXECUTE FUNCTION app.payment_import_lines_guard();

CREATE FUNCTION app.payment_imports_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bank-file imports are not deleted; cancel the import instead' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.bank_account_id <> OLD.bank_account_id OR NEW.document_id <> OLD.document_id OR NEW.line_count <> OLD.line_count OR NEW.format <> OLD.format THEN
    RAISE EXCEPTION 'the file of an import is fixed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'checked' AND NEW.status IN ('committed', 'cancelled')) THEN
    RAISE EXCEPTION 'a % import cannot become %', OLD.status, NEW.status USING ERRCODE = 'check_violation', DETAIL = 'import-transition';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER payment_imports_guard BEFORE UPDATE OR DELETE ON payment_imports
  FOR EACH ROW EXECUTE FUNCTION app.payment_imports_guard();

ALTER TABLE payment_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_imports FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON payment_imports FOR ALL TO estatepro_app
  USING (company_id = app.current_company_id()) WITH CHECK (company_id = app.current_company_id());
ALTER TABLE payment_import_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_import_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON payment_import_lines FOR ALL TO estatepro_app
  USING (company_id = app.current_company_id()) WITH CHECK (company_id = app.current_company_id());
GRANT SELECT, INSERT, UPDATE ON payment_imports, payment_import_lines TO estatepro_app;
GRANT SELECT ON payment_imports, payment_import_lines TO estatepro_platform;
CREATE TRIGGER payment_imports_touch BEFORE UPDATE ON payment_imports FOR EACH ROW EXECUTE FUNCTION app.touch_row();
CREATE TRIGGER payment_import_lines_touch BEFORE UPDATE ON payment_import_lines FOR EACH ROW EXECUTE FUNCTION app.touch_row();

-- -----------------------------------------------------------------------------
-- 3. Arrears actions are append-only
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.arrears_actions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND app.erasure_in_progress() AND NEW.notes = '[Erased]'
     AND (to_jsonb(OLD) - 'notes') = (to_jsonb(NEW) - 'notes') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% on arrears_actions is not allowed: actions are a history; record a further action', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
CREATE TRIGGER arrears_actions_guard BEFORE UPDATE OR DELETE ON arrears_actions
  FOR EACH ROW EXECUTE FUNCTION app.arrears_actions_guard();

-- -----------------------------------------------------------------------------
-- 4. Payment plans
-- -----------------------------------------------------------------------------
ALTER TABLE payment_plans ADD COLUMN closed_on date;
ALTER TABLE payment_plans ADD COLUMN closed_reason text CHECK (char_length(closed_reason) <= 500);
ALTER TABLE payment_plans ADD COLUMN closed_by uuid;
ALTER TABLE payment_plans ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE payment_plans ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE payment_plans ADD CONSTRAINT payment_plans_company_id_id_key UNIQUE (company_id, id);
ALTER TABLE payment_plans ADD CONSTRAINT payment_plans_closed_by_fkey FOREIGN KEY (company_id, closed_by) REFERENCES company_memberships (company_id, id);
ALTER TABLE payment_plans ADD CONSTRAINT payment_plans_closed CHECK ((status = 'active') = (closed_on IS NULL));
CREATE UNIQUE INDEX payment_plans_one_active_idx ON payment_plans (company_id, lease_id) WHERE status = 'active';
CREATE INDEX payment_plans_lease_idx ON payment_plans (company_id, lease_id, agreed_on DESC);
CREATE INDEX payment_plans_closed_by_idx ON payment_plans (company_id, closed_by);
CREATE TRIGGER payment_plans_touch BEFORE UPDATE ON payment_plans FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE FUNCTION app.payment_plans_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  l leases%ROWTYPE;
  item jsonb;
  total numeric := 0;
  previous date;
  due date;
  amount numeric;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment plans are not deleted; cancel the plan instead' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO l FROM leases WHERE company_id = NEW.company_id AND id = NEW.lease_id;
    IF l.status NOT IN ('active', 'periodic', 'notice_given', 'ended') THEN
      RAISE EXCEPTION 'lease % is %: payment plans are agreed on a live or ended lease', l.reference, l.status
        USING ERRCODE = 'check_violation', DETAIL = 'plan-lease-status';
    END IF;
    IF NEW.currency_code <> l.currency_code THEN
      RAISE EXCEPTION 'a payment plan on lease % is in %', l.reference, l.currency_code USING ERRCODE = 'check_violation', DETAIL = 'plan-currency';
    END IF;
    IF NEW.status <> 'active' THEN
      RAISE EXCEPTION 'a payment plan starts active' USING ERRCODE = 'check_violation', DETAIL = 'plan-start-status';
    END IF;
    IF jsonb_typeof(NEW.instalments) <> 'array' OR jsonb_array_length(NEW.instalments) = 0 OR jsonb_array_length(NEW.instalments) > 60 THEN
      RAISE EXCEPTION 'a payment plan has 1 to 60 instalments' USING ERRCODE = 'check_violation', DETAIL = 'plan-instalments';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(NEW.instalments) LOOP
      BEGIN
        due := (item ->> 'due_date')::date;
        amount := (item ->> 'amount')::numeric;
      EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'each instalment has a due_date and an amount' USING ERRCODE = 'check_violation', DETAIL = 'plan-instalments';
      END;
      IF due IS NULL OR amount IS NULL OR amount <= 0 OR due < NEW.agreed_on OR (previous IS NOT NULL AND due <= previous) THEN
        RAISE EXCEPTION 'instalments are positive and due in order, from the day the plan is agreed' USING ERRCODE = 'check_violation', DETAIL = 'plan-instalments';
      END IF;
      previous := due;
      total := total + amount;
    END LOOP;
    IF total <> NEW.total_amount THEN
      RAISE EXCEPTION 'the instalments add up to %, not the plan total %', total, NEW.total_amount USING ERRCODE = 'check_violation', DETAIL = 'plan-total';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'active' THEN
    IF (to_jsonb(OLD) - ARRAY['closed_reason', 'updated_at', 'version']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['closed_reason', 'updated_at', 'version'])
       OR (NEW.closed_reason IS DISTINCT FROM OLD.closed_reason AND NOT (app.erasure_in_progress() AND NEW.closed_reason = '[Erased]')) THEN
      RAISE EXCEPTION 'a % payment plan is final', OLD.status USING ERRCODE = 'insufficient_privilege', DETAIL = 'plan-final';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(OLD) - ARRAY['status', 'closed_on', 'closed_reason', 'closed_by', 'updated_at', 'version'])
     IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['status', 'closed_on', 'closed_reason', 'closed_by', 'updated_at', 'version']) THEN
    RAISE EXCEPTION 'the terms of a payment plan are fixed; cancel it and agree another' USING ERRCODE = 'insufficient_privilege', DETAIL = 'plan-terms';
  END IF;
  IF NEW.status NOT IN ('active', 'completed', 'broken', 'cancelled') OR (NEW.status <> 'active' AND NEW.closed_on < OLD.agreed_on) THEN
    RAISE EXCEPTION 'a plan closes on or after the day it was agreed' USING ERRCODE = 'check_violation', DETAIL = 'plan-closed-on';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER payment_plans_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_plans
  FOR EACH ROW EXECUTE FUNCTION app.payment_plans_guard();

-- -----------------------------------------------------------------------------
-- 5. Bank statements as documents of a bank account
-- -----------------------------------------------------------------------------
ALTER TABLE document_upload_sessions DROP CONSTRAINT document_upload_sessions_entity_type_check;
ALTER TABLE document_upload_sessions ADD CONSTRAINT document_upload_sessions_entity_type_check
  CHECK (entity_type IN ('lease', 'management_agreement', 'bank_account'));
ALTER TABLE document_links DROP CONSTRAINT document_links_entity_type_check;
ALTER TABLE document_links ADD CONSTRAINT document_links_entity_type_check
  CHECK (entity_type IN ('property', 'unit', 'listing', 'development', 'contact', 'lead', 'deal',
                         'sales_transaction', 'lease', 'management_agreement', 'deposit',
                         'inspection', 'maintenance_request', 'supplier_invoice', 'statement', 'payout', 'bank_account'));
INSERT INTO picklist_values (list_key, code, label, country_code, sort_order) VALUES
  ('document_type', 'bank_statement', 'Bank statement file', NULL, 17);

-- -----------------------------------------------------------------------------
-- 6. Erasure of lettings free text (migration 0035), with bank-file lines and plans
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.erase_contact_tenancy(company uuid, subjects uuid[]) RETURNS jsonb
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
  UPDATE payment_plans SET closed_reason = '[Erased]' WHERE company_id = company AND lease_id = ANY (lease_ids) AND closed_reason IS NOT NULL;

  UPDATE payments
     SET notes = CASE WHEN notes IS NULL THEN NULL ELSE '[Erased]' END,
         status_reason = CASE WHEN status_reason IS NULL THEN NULL ELSE '[Erased]' END,
         instrument_number = NULL, instrument_bank = NULL
   WHERE company_id = company AND id = ANY (payment_ids)
     AND (notes IS NOT NULL OR status_reason IS NOT NULL OR instrument_number IS NOT NULL OR instrument_bank IS NOT NULL);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN counts := counts || jsonb_build_object('payments', n); END IF;

  -- Bank-file lines carry the payer's words (reference, description): erased; date and amount kept.
  UPDATE payment_import_lines
     SET reference = CASE WHEN reference IS NULL THEN NULL ELSE '[Erased]' END,
         description = CASE WHEN description IS NULL THEN NULL ELSE '[Erased]' END
   WHERE company_id = company
     AND (payer_contact_id = ANY (subjects) OR lease_id = ANY (lease_ids) OR payment_id = ANY (payment_ids))
     AND (reference IS DISTINCT FROM '[Erased]' OR description IS DISTINCT FROM '[Erased]')
     AND (reference IS NOT NULL OR description IS NOT NULL);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN counts := counts || jsonb_build_object('bank_file_lines', n); END IF;

  RETURN counts || jsonb_build_object('touched', to_jsonb(lease_ids || payment_ids || deposit_ids || inspection_ids || charge_ids));
END;
$$;
REVOKE ALL ON FUNCTION app.erase_contact_tenancy(uuid, uuid[]) FROM PUBLIC;
