-- =============================================================================
-- EstatePro · Migration 0039 · Deposits, inspections, notice, ending, renewal (L4)
-- =============================================================================
-- Phase 7 milestone L4 (readiness report §5.5 to §5.7; LET-06, LET-07,
-- LET-09; P7-D3, P7-D11; wireframes LS-6, LS-7, DP-1, IN-1 to IN-3, ST-2;
-- W7-S1):
--
--  1. Leases. A lease ends only once it has an end date (fixed term, or the
--     date its notice gives). A renewal lease follows the lease it renews on
--     the same unit, at most one per lease. renewal_mark records the last
--     renewal reminder written (90, 60 or 30 days before the end date).
--  2. Deposits. The life cycle is enforced here: expected → held (received)
--     → protected → returned, partly returned or forfeited, with "return
--     pending" and "disputed" on the way. A deposit the agency collects is
--     held when its deposit charge is paid in full (and expected again if that
--     payment is reversed before protection). Where a reviewed jurisdiction
--     value exists, the protection deadline is computed from the date received
--     (P7-D3, P7-D11); otherwise a person may enter it. The amount returned is
--     the amount held less the settled deductions; deposits are never deleted.
--     A held deposit moves to the renewal lease of its lease.
--  3. Deposit deductions: proposed → agreed, disputed or withdrawn; disputed
--     → agreed, adjudicated (with the amount decided) or withdrawn. Their
--     total never exceeds the deposit; they are never deleted.
--  4. Inspections: scheduled → in progress → completed (overall condition and
--     every item's condition recorded), or cancelled with a reason. A
--     completed inspection is final except the tenant's acknowledgement (once).
--     Items change only before completion. One move-in and one move-out
--     inspection per lease.
--  5. Inspection item photos (W7-S1): scanned documents of the inspection
--     linked to one of its items, with a caption.
--  6. Documents may belong to an inspection; photo document type.
--  7. Erasure (ADR-009) also blanks inspection cancellation reasons and photo
--     captions of the person's tenancies.
-- The database tests are database/tests/22_deposits_inspections_l4.sql.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Leases: ending, renewal chain, renewal reminders
-- -----------------------------------------------------------------------------
ALTER TABLE leases ADD COLUMN renewal_mark smallint CHECK (renewal_mark IN (90, 60, 30));
COMMENT ON COLUMN leases.renewal_mark IS 'Days before the end date of the last renewal reminder written by the renewal job (90, 60, 30)';
CREATE UNIQUE INDEX leases_one_renewal_idx ON leases (company_id, previous_lease_id)
  WHERE previous_lease_id IS NOT NULL AND status <> 'cancelled';
-- The renewal job's read: fixed-term live leases by end date.
CREATE INDEX leases_renewal_due_idx ON leases (company_id, end_date)
  WHERE status IN ('active', 'notice_given') AND end_date IS NOT NULL AND renewal_status IN ('not_due', 'pending_decision');

CREATE OR REPLACE FUNCTION app.leases_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  fixed text[] := ARRAY['reference', 'unit_id', 'listing_id', 'previous_lease_id', 'deal_id', 'jurisdiction_code', 'lease_type', 'usage',
                        'start_date', 'currency_code', 'rent_amount', 'rent_frequency', 'rent_due_day', 'advance_periods',
                        'prorate_first_period', 'rent_tax_code_id', 'deposit_amount', 'notice_period_days', 'break_clause_date',
                        'break_notice_days', 'template_id', 'governing_locale_code', 'signed_at', 'document_id', 'created_by', 'created_at'];
  col text;
  agreement management_agreements%ROWTYPE;
  unit_property uuid;
  previous leases%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'lease % is % and cannot be deleted; cancel or end it instead', OLD.reference, OLD.status
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status NOT IN ('draft', 'pending_signature') THEN
      FOREACH col IN ARRAY fixed LOOP
        IF to_jsonb(OLD) -> col IS DISTINCT FROM to_jsonb(NEW) -> col THEN
          RAISE EXCEPTION 'lease % is %: % cannot change; use a rent review, a renewal or notice', OLD.reference, OLD.status, col
            USING ERRCODE = 'insufficient_privilege';
        END IF;
      END LOOP;
      -- The end date moves only with notice (L4).
      IF NEW.end_date IS DISTINCT FROM OLD.end_date AND NOT (NEW.status = 'notice_given' AND OLD.status IN ('active', 'periodic')) THEN
        RAISE EXCEPTION 'lease % is %: the end date changes only when notice is given', OLD.reference, OLD.status
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
         (OLD.status = 'draft' AND NEW.status IN ('pending_signature', 'cancelled'))
      OR (OLD.status = 'pending_signature' AND NEW.status IN ('draft', 'active', 'cancelled'))
      OR (OLD.status = 'active' AND NEW.status IN ('periodic', 'notice_given', 'ended'))
      OR (OLD.status = 'periodic' AND NEW.status IN ('notice_given', 'ended'))
      OR (OLD.status = 'notice_given' AND NEW.status IN ('active', 'periodic', 'ended'))
      OR (OLD.status = 'ended' AND NEW.status = 'closed')) THEN
      RAISE EXCEPTION 'a % lease cannot become %', OLD.status, NEW.status USING ERRCODE = 'check_violation', DETAIL = 'lease-transition';
    END IF;
    -- L4: a lease ends on a known date (its fixed term, or the date its notice gives).
    IF NEW.status = 'ended' AND OLD.status <> 'ended' AND NEW.end_date IS NULL THEN
      RAISE EXCEPTION 'lease % has no end date: record notice first', OLD.reference
        USING ERRCODE = 'check_violation', DETAIL = 'lease-no-end-date';
    END IF;
    -- The move-out date is kept once the lease has ended.
    IF OLD.status IN ('ended', 'closed') AND NEW.move_out_date IS DISTINCT FROM OLD.move_out_date THEN
      RAISE EXCEPTION 'lease % has ended: its move-out date is kept', OLD.reference USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  -- L4: a renewal follows the lease it renews, on the same unit, in the same currency.
  IF NEW.previous_lease_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.previous_lease_id IS DISTINCT FROM OLD.previous_lease_id) THEN
    SELECT * INTO previous FROM leases WHERE company_id = NEW.company_id AND id = NEW.previous_lease_id;
    IF previous.unit_id IS DISTINCT FROM NEW.unit_id OR previous.status IN ('draft', 'pending_signature', 'cancelled') THEN
      RAISE EXCEPTION 'a renewal follows a signed lease of the same unit' USING ERRCODE = 'check_violation', DETAIL = 'renewal-previous';
    END IF;
    IF previous.end_date IS NULL OR NEW.start_date <= previous.end_date THEN
      RAISE EXCEPTION 'a renewal starts after lease % ends', previous.reference USING ERRCODE = 'check_violation', DETAIL = 'renewal-dates';
    END IF;
  END IF;
  -- The agreement, if any, covers the lease's unit.
  IF NEW.management_agreement_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.management_agreement_id IS DISTINCT FROM OLD.management_agreement_id OR NEW.unit_id IS DISTINCT FROM OLD.unit_id) THEN
    SELECT * INTO agreement FROM management_agreements WHERE company_id = NEW.company_id AND id = NEW.management_agreement_id;
    SELECT property_id INTO unit_property FROM units WHERE company_id = NEW.company_id AND id = NEW.unit_id;
    IF agreement.property_id IS DISTINCT FROM unit_property OR (agreement.unit_id IS NOT NULL AND agreement.unit_id <> NEW.unit_id) THEN
      RAISE EXCEPTION 'the management agreement does not cover this unit' USING ERRCODE = 'check_violation', DETAIL = 'agreement-unit';
    END IF;
    IF agreement.status = 'ended' THEN
      RAISE EXCEPTION 'management agreement % has ended', agreement.reference USING ERRCODE = 'check_violation', DETAIL = 'agreement-ended';
    END IF;
  END IF;
  -- Activation, or an imported live lease: the same checks.
  IF (TG_OP = 'UPDATE' AND NEW.status = 'active' AND OLD.status = 'pending_signature')
     OR (TG_OP = 'INSERT' AND NEW.status IN ('active', 'periodic', 'notice_given')) THEN
    IF NEW.management_agreement_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM management_agreements m WHERE m.company_id = NEW.company_id AND m.id = NEW.management_agreement_id AND m.status = 'active') THEN
      RAISE EXCEPTION 'the management agreement is not active' USING ERRCODE = 'check_violation', DETAIL = 'agreement-not-active';
    END IF;
    IF NEW.document_id IS NOT NULL AND NOT app.document_is_clean(NEW.company_id, NEW.document_id) THEN
      RAISE EXCEPTION 'the signed lease has not passed the security scan' USING ERRCODE = 'check_violation', DETAIL = 'document-not-clean';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- -----------------------------------------------------------------------------
-- 2. Deposits
-- -----------------------------------------------------------------------------
ALTER TABLE deposits ADD COLUMN received_on date;
ALTER TABLE deposits ADD COLUMN protection_deadline_source text CHECK (protection_deadline_source IN ('jurisdiction', 'entered'));
ALTER TABLE deposits ADD COLUMN created_by uuid;
ALTER TABLE deposits ADD CONSTRAINT deposits_created_by_fkey FOREIGN KEY (company_id, created_by) REFERENCES company_memberships (company_id, id);
ALTER TABLE deposits ADD CONSTRAINT deposits_deadline_source CHECK ((protection_deadline IS NULL) = (protection_deadline_source IS NULL));
ALTER TABLE deposits ADD CONSTRAINT deposits_returned_at CHECK ((status IN ('returned', 'partially_returned', 'forfeited')) = (returned_at IS NOT NULL));
COMMENT ON COLUMN deposits.received_on IS 'The date the deposit was received: the receipt that paid its deposit charge in full, or entered when the agency does not collect';
COMMENT ON COLUMN deposits.protection_deadline_source IS 'jurisdiction: computed from a reviewed value (P7-D11); entered: given by a person where no reviewed rule exists';
CREATE INDEX deposits_created_by_idx ON deposits (company_id, created_by);
CREATE INDEX deposits_received_payment_idx ON deposits (company_id, received_payment_id);
CREATE INDEX deposits_holding_account_idx ON deposits (company_id, holding_account_id);

-- Whether a lease's deposit charges (if it has any) are paid in full, and the
-- latest allocation that paid them.
CREATE FUNCTION app.deposit_charge_state(p_company uuid, p_lease uuid)
RETURNS TABLE (has_charge boolean, paid boolean, payment_id uuid, paid_on date)
LANGUAGE sql STABLE AS $$
  SELECT count(*) > 0,
         count(*) > 0 AND bool_and(c.allocated_amount = c.amount + c.tax_amount + c.adjusted_amount),
         (SELECT a.payment_id FROM payment_allocations a JOIN rent_charges c2 ON c2.id = a.rent_charge_id
           WHERE c2.company_id = p_company AND c2.lease_id = p_lease AND c2.charge_type = 'deposit' AND c2.status = 'posted' AND a.amount > 0
           ORDER BY a.allocated_on DESC, a.created_at DESC LIMIT 1),
         (SELECT max(a.allocated_on) FROM payment_allocations a JOIN rent_charges c2 ON c2.id = a.rent_charge_id
           WHERE c2.company_id = p_company AND c2.lease_id = p_lease AND c2.charge_type = 'deposit' AND c2.status = 'posted' AND a.amount > 0)
    FROM rent_charges c
   WHERE c.company_id = p_company AND c.lease_id = p_lease AND c.charge_type = 'deposit' AND c.status = 'posted'
$$;

CREATE FUNCTION app.deposits_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  l leases%ROWTYPE;
  target leases%ROWTYPE;
  charge record;
  settled numeric;
  open_deductions integer;
  rule jsonb;
  final_states text[] := ARRAY['returned', 'partially_returned', 'forfeited'];
  col text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'deposits are kept: a deposit is returned or forfeited, never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO l FROM leases WHERE company_id = NEW.company_id AND id = NEW.lease_id;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('expected', 'held', 'protected') OR NEW.returned_amount <> 0 THEN
      RAISE EXCEPTION 'a deposit is registered as expected, held or protected' USING ERRCODE = 'check_violation', DETAIL = 'deposit-start-status';
    END IF;
    IF l.status IN ('cancelled', 'closed') THEN
      RAISE EXCEPTION 'lease % is %: no deposit is registered on it', l.reference, l.status USING ERRCODE = 'check_violation', DETAIL = 'deposit-lease-status';
    END IF;
    IF NEW.currency_code <> l.currency_code THEN
      RAISE EXCEPTION 'the deposit of lease % is in %', l.reference, l.currency_code USING ERRCODE = 'check_violation', DETAIL = 'deposit-currency';
    END IF;
  ELSE
    -- Final deposits do not change (an identical write is accepted).
    IF OLD.status = ANY (final_states) THEN
      IF (to_jsonb(OLD) - 'updated_at' - 'version') IS DISTINCT FROM (to_jsonb(NEW) - 'updated_at' - 'version') THEN
        RAISE EXCEPTION 'deposit of lease % is %: it no longer changes', l.reference, OLD.status
          USING ERRCODE = 'check_violation', DETAIL = 'deposit-final';
      END IF;
      RETURN NEW;
    END IF;
    FOREACH col IN ARRAY ARRAY['company_id', 'amount', 'currency_code', 'created_by', 'created_at'] LOOP
      IF to_jsonb(OLD) -> col IS DISTINCT FROM to_jsonb(NEW) -> col THEN
        RAISE EXCEPTION 'the % of a deposit is fixed', col USING ERRCODE = 'insufficient_privilege';
      END IF;
    END LOOP;
    -- A held deposit moves to the renewal of its lease (L4).
    IF NEW.lease_id IS DISTINCT FROM OLD.lease_id THEN
      SELECT * INTO target FROM leases WHERE company_id = NEW.company_id AND id = NEW.lease_id;
      IF OLD.status NOT IN ('held', 'protected') OR target.previous_lease_id IS DISTINCT FROM OLD.lease_id
         OR target.currency_code <> OLD.currency_code THEN
        RAISE EXCEPTION 'a held deposit moves only to the renewal of its lease' USING ERRCODE = 'check_violation', DETAIL = 'deposit-carry-over';
      END IF;
    END IF;
    IF NEW.returned_amount IS DISTINCT FROM OLD.returned_amount AND NOT (NEW.status = ANY (final_states)) THEN
      RAISE EXCEPTION 'the amount returned is recorded with the return' USING ERRCODE = 'check_violation', DETAIL = 'deposit-returned-amount';
    END IF;
    -- Received and protection details are fixed once recorded (until a reversed receipt sends a held deposit back to expected).
    IF OLD.status <> 'expected' AND NEW.status <> 'expected'
       AND (NEW.received_on IS DISTINCT FROM OLD.received_on OR NEW.received_payment_id IS DISTINCT FROM OLD.received_payment_id) THEN
      RAISE EXCEPTION 'the receipt of a deposit is fixed once recorded' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.protected_at IS NOT NULL
       AND (NEW.protected_at IS DISTINCT FROM OLD.protected_at OR NEW.scheme_reference IS DISTINCT FROM OLD.scheme_reference
            OR NEW.scheme_name IS DISTINCT FROM OLD.scheme_name) THEN
      RAISE EXCEPTION 'the protection of a deposit is fixed once recorded' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NOT ((OLD.status = 'expected' AND NEW.status = 'held')
           OR (OLD.status = 'held' AND NEW.status IN ('expected', 'protected', 'return_pending', 'disputed'))
           OR (OLD.status = 'protected' AND NEW.status IN ('return_pending', 'disputed'))
           OR (OLD.status = 'return_pending' AND NEW.status = 'disputed')
           OR (OLD.status = 'disputed' AND NEW.status IN ('held', 'protected', 'return_pending'))
           OR (OLD.status IN ('held', 'protected', 'return_pending') AND NEW.status = ANY (final_states))) THEN
        RAISE EXCEPTION 'a % deposit cannot become %', OLD.status, NEW.status USING ERRCODE = 'check_violation', DETAIL = 'deposit-transition';
      END IF;
      SELECT * INTO charge FROM app.deposit_charge_state(NEW.company_id, NEW.lease_id);
      IF NEW.status = 'held' AND OLD.status = 'expected' THEN
        IF charge.has_charge AND NOT charge.paid THEN
          RAISE EXCEPTION 'the deposit charge of lease % is not paid in full', l.reference USING ERRCODE = 'check_violation', DETAIL = 'deposit-not-paid';
        END IF;
        IF NEW.received_on IS NULL THEN
          RAISE EXCEPTION 'a held deposit records the date it was received' USING ERRCODE = 'check_violation', DETAIL = 'deposit-received-on';
        END IF;
      END IF;
      IF NEW.status = 'expected' THEN
        IF NOT charge.has_charge OR charge.paid OR OLD.protected_at IS NOT NULL THEN
          RAISE EXCEPTION 'a deposit goes back to expected only when the receipt that paid it is reversed'
            USING ERRCODE = 'check_violation', DETAIL = 'deposit-transition';
        END IF;
        NEW.received_on := NULL;
        NEW.received_payment_id := NULL;
        IF NEW.protection_deadline_source = 'jurisdiction' THEN
          NEW.protection_deadline := NULL;
          NEW.protection_deadline_source := NULL;
        END IF;
      END IF;
      IF NEW.status = 'protected' AND (NEW.protected_at IS NULL OR NEW.scheme_reference IS NULL) THEN
        RAISE EXCEPTION 'a protected deposit records its scheme reference and date' USING ERRCODE = 'check_violation', DETAIL = 'deposit-protection';
      END IF;
      IF NEW.status = ANY (final_states) THEN
        SELECT coalesce(sum(settled_amount) FILTER (WHERE status IN ('agreed', 'adjudicated')), 0),
               count(*) FILTER (WHERE status IN ('proposed', 'disputed'))
          INTO settled, open_deductions
          FROM deposit_deductions WHERE company_id = NEW.company_id AND deposit_id = NEW.id;
        IF open_deductions > 0 THEN
          RAISE EXCEPTION 'deductions are still proposed or disputed' USING ERRCODE = 'check_violation', DETAIL = 'deposit-open-deductions';
        END IF;
        IF NEW.returned_amount <> NEW.amount - settled
           OR (NEW.status = 'returned' AND NEW.returned_amount <> NEW.amount)
           OR (NEW.status = 'forfeited' AND NEW.returned_amount <> 0)
           OR (NEW.status = 'partially_returned' AND (NEW.returned_amount = 0 OR NEW.returned_amount = NEW.amount)) THEN
          RAISE EXCEPTION 'the amount returned is the deposit less its settled deductions (%)', NEW.amount - settled
            USING ERRCODE = 'check_violation', DETAIL = 'deposit-return-amount';
        END IF;
      END IF;
    END IF;
  END IF;
  -- P7-D11: with a reviewed protection period for the lease's jurisdiction, the deadline follows from the date received.
  IF NEW.received_on IS NOT NULL AND NEW.protected_at IS NULL THEN
    rule := app.jurisdiction_rule(l.jurisdiction_code, 'deposit_protection_deadline_days', NEW.received_on);
    IF rule IS NOT NULL AND jsonb_typeof(rule) = 'number' THEN
      NEW.protection_deadline := NEW.received_on + (rule #>> '{}')::integer;
      NEW.protection_deadline_source := 'jurisdiction';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER deposits_guard BEFORE INSERT OR UPDATE OR DELETE ON deposits
  FOR EACH ROW EXECUTE FUNCTION app.deposits_guard();

-- A deposit the agency collects is held once its deposit charge is paid in
-- full, and expected again if that payment is reversed before protection.
CREATE FUNCTION app.deposits_follow_charge() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  charge record;
BEGIN
  SELECT * INTO charge FROM app.deposit_charge_state(NEW.company_id, NEW.lease_id);
  IF charge.paid THEN
    UPDATE deposits SET status = 'held', received_on = charge.paid_on, received_payment_id = charge.payment_id
     WHERE company_id = NEW.company_id AND lease_id = NEW.lease_id AND status = 'expected';
  ELSIF charge.has_charge THEN
    UPDATE deposits SET status = 'expected'
     WHERE company_id = NEW.company_id AND lease_id = NEW.lease_id AND status = 'held' AND protected_at IS NULL;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER rent_charges_deposit_follow AFTER UPDATE OF allocated_amount, adjusted_amount, status ON rent_charges
  FOR EACH ROW WHEN (NEW.charge_type = 'deposit') EXECUTE FUNCTION app.deposits_follow_charge();

-- -----------------------------------------------------------------------------
-- 3. Deposit deductions
-- -----------------------------------------------------------------------------
ALTER TABLE deposit_deductions ADD COLUMN settled_amount numeric(19,4) CHECK (settled_amount >= 0);
ALTER TABLE deposit_deductions ADD COLUMN decided_at timestamptz;
ALTER TABLE deposit_deductions ADD COLUMN decided_by uuid;
ALTER TABLE deposit_deductions ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE deposit_deductions ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE deposit_deductions ADD CONSTRAINT deposit_deductions_company_id_id_key UNIQUE (company_id, id);
ALTER TABLE deposit_deductions ADD CONSTRAINT deposit_deductions_decided_by_fkey FOREIGN KEY (company_id, decided_by) REFERENCES company_memberships (company_id, id);
ALTER TABLE deposit_deductions ADD CONSTRAINT deposit_deductions_created_by_fkey FOREIGN KEY (company_id, created_by) REFERENCES company_memberships (company_id, id);
ALTER TABLE deposit_deductions ADD CONSTRAINT deposit_deductions_evidence_fkey FOREIGN KEY (company_id, evidence_document_id) REFERENCES documents (company_id, id);
ALTER TABLE deposit_deductions ADD CONSTRAINT deposit_deductions_settled
  CHECK ((status IN ('agreed', 'adjudicated')) = (settled_amount IS NOT NULL) AND (settled_amount IS NULL OR settled_amount <= amount));
ALTER TABLE deposit_deductions ADD CONSTRAINT deposit_deductions_description_length CHECK (char_length(description) BETWEEN 1 AND 500);
CREATE INDEX deposit_deductions_deposit_idx ON deposit_deductions (company_id, deposit_id, created_at);
CREATE INDEX deposit_deductions_decided_by_idx ON deposit_deductions (company_id, decided_by);
CREATE INDEX deposit_deductions_created_by_idx ON deposit_deductions (company_id, created_by);
CREATE INDEX deposit_deductions_evidence_idx ON deposit_deductions (company_id, evidence_document_id);
CREATE TRIGGER deposit_deductions_touch BEFORE UPDATE ON deposit_deductions FOR EACH ROW EXECUTE FUNCTION app.touch_row();

CREATE FUNCTION app.deposit_deductions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  d deposits%ROWTYPE;
  total numeric;
  col text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'deposit deductions are kept: withdraw one instead' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Erasure (ADR-009) blanks the description and nothing else.
  IF TG_OP = 'UPDATE' AND app.erasure_in_progress() AND NEW.description = '[Erased]'
     AND (to_jsonb(OLD) - 'description' - 'updated_at' - 'version') = (to_jsonb(NEW) - 'description' - 'updated_at' - 'version') THEN
    RETURN NEW;
  END IF;
  SELECT * INTO d FROM deposits WHERE company_id = NEW.company_id AND id = NEW.deposit_id FOR UPDATE;
  IF d.status NOT IN ('held', 'protected', 'return_pending', 'disputed') THEN
    RAISE EXCEPTION 'the deposit is %: deductions are made from a deposit held and not yet returned', d.status
      USING ERRCODE = 'check_violation', DETAIL = 'deduction-deposit-status';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'proposed' OR NEW.settled_amount IS NOT NULL THEN
      RAISE EXCEPTION 'a deduction starts as proposed' USING ERRCODE = 'check_violation', DETAIL = 'deduction-start-status';
    END IF;
  ELSE
    FOREACH col IN ARRAY ARRAY['company_id', 'deposit_id', 'reason_code', 'description', 'amount', 'created_by', 'created_at'] LOOP
      IF to_jsonb(OLD) -> col IS DISTINCT FROM to_jsonb(NEW) -> col THEN
        RAISE EXCEPTION 'the % of a deduction is fixed', col USING ERRCODE = 'insufficient_privilege';
      END IF;
    END LOOP;
    IF OLD.status IN ('agreed', 'adjudicated', 'withdrawn') THEN
      RAISE EXCEPTION 'a % deduction is final', OLD.status USING ERRCODE = 'check_violation', DETAIL = 'deduction-final';
    END IF;
    IF NEW.evidence_document_id IS DISTINCT FROM OLD.evidence_document_id AND OLD.status <> 'proposed' THEN
      RAISE EXCEPTION 'evidence is added while the deduction is proposed' USING ERRCODE = 'check_violation', DETAIL = 'deduction-evidence';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
         (OLD.status = 'proposed' AND NEW.status IN ('agreed', 'disputed', 'withdrawn'))
      OR (OLD.status = 'disputed' AND NEW.status IN ('agreed', 'adjudicated', 'withdrawn'))) THEN
      RAISE EXCEPTION 'a % deduction cannot become %', OLD.status, NEW.status USING ERRCODE = 'check_violation', DETAIL = 'deduction-transition';
    END IF;
    IF NEW.status = 'agreed' AND NEW.settled_amount IS DISTINCT FROM NEW.amount THEN
      RAISE EXCEPTION 'an agreed deduction settles at its amount' USING ERRCODE = 'check_violation', DETAIL = 'deduction-settled';
    END IF;
  END IF;
  -- Deductions never take more than the deposit.
  SELECT coalesce(sum(amount), 0) INTO total FROM deposit_deductions
   WHERE company_id = NEW.company_id AND deposit_id = NEW.deposit_id AND status <> 'withdrawn' AND id <> NEW.id;
  IF NEW.status <> 'withdrawn' AND total + coalesce(NEW.settled_amount, NEW.amount) > d.amount THEN
    RAISE EXCEPTION 'deductions would exceed the deposit of %', d.amount USING ERRCODE = 'check_violation', DETAIL = 'deduction-total';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER deposit_deductions_guard BEFORE INSERT OR UPDATE OR DELETE ON deposit_deductions
  FOR EACH ROW EXECUTE FUNCTION app.deposit_deductions_guard();

-- -----------------------------------------------------------------------------
-- 4. Inspections
-- -----------------------------------------------------------------------------
ALTER TABLE inspections ADD COLUMN started_at timestamptz;
ALTER TABLE inspections ADD COLUMN cancelled_reason text CHECK (char_length(cancelled_reason) BETWEEN 1 AND 500);
ALTER TABLE inspections ADD COLUMN created_by uuid;
ALTER TABLE inspections ADD CONSTRAINT inspections_created_by_fkey FOREIGN KEY (company_id, created_by) REFERENCES company_memberships (company_id, id);
ALTER TABLE inspections ADD CONSTRAINT inspections_report_document_fkey FOREIGN KEY (company_id, report_document_id) REFERENCES documents (company_id, id);
ALTER TABLE inspections ADD CONSTRAINT inspections_cancelled CHECK ((status = 'cancelled') = (cancelled_reason IS NOT NULL));
ALTER TABLE inspections ADD CONSTRAINT inspections_started CHECK (status NOT IN ('in_progress', 'completed') OR started_at IS NOT NULL);
ALTER TABLE inspections ADD CONSTRAINT inspections_summary_length CHECK (char_length(summary) <= 4000);
ALTER TABLE inspections ADD CONSTRAINT inspections_tenant_signed CHECK (tenant_signed_at IS NULL OR status = 'completed');
CREATE UNIQUE INDEX inspections_one_per_lease_idx ON inspections (company_id, lease_id, inspection_type)
  WHERE lease_id IS NOT NULL AND inspection_type IN ('move_in', 'move_out') AND status <> 'cancelled';
CREATE INDEX inspections_list_idx ON inspections (company_id, scheduled_at DESC, id DESC);
CREATE INDEX inspections_unit_idx ON inspections (company_id, unit_id, completed_at DESC) WHERE status = 'completed';
CREATE INDEX inspections_lease_idx ON inspections (company_id, lease_id);
CREATE INDEX inspections_created_by_idx ON inspections (company_id, created_by);
CREATE INDEX inspections_report_document_idx ON inspections (company_id, report_document_id);
ALTER TABLE inspection_items ADD CONSTRAINT inspection_items_company_id_id_key UNIQUE (company_id, id);
ALTER TABLE inspection_items ADD CONSTRAINT inspection_items_text_length
  CHECK (char_length(area) BETWEEN 1 AND 100 AND char_length(item) BETWEEN 1 AND 100 AND char_length(notes) <= 2000);

CREATE FUNCTION app.inspections_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  l leases%ROWTYPE;
  unit_property uuid;
  col text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inspections are kept: cancel one instead' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Erasure (ADR-009) blanks the summary and the cancellation reason.
  IF TG_OP = 'UPDATE' AND app.erasure_in_progress()
     AND (NEW.summary IS NOT DISTINCT FROM OLD.summary OR NEW.summary = '[Erased]')
     AND (NEW.cancelled_reason IS NOT DISTINCT FROM OLD.cancelled_reason OR NEW.cancelled_reason = '[Erased]')
     AND (to_jsonb(OLD) - 'summary' - 'cancelled_reason' - 'updated_at' - 'version')
       = (to_jsonb(NEW) - 'summary' - 'cancelled_reason' - 'updated_at' - 'version') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'scheduled' THEN
      RAISE EXCEPTION 'an inspection starts scheduled' USING ERRCODE = 'check_violation', DETAIL = 'inspection-start-status';
    END IF;
    SELECT property_id INTO unit_property FROM units WHERE company_id = NEW.company_id AND id = NEW.unit_id;
    IF NEW.unit_id IS NOT NULL AND unit_property IS DISTINCT FROM NEW.property_id THEN
      RAISE EXCEPTION 'the unit is not in this property' USING ERRCODE = 'check_violation', DETAIL = 'inspection-unit';
    END IF;
    IF NEW.inspection_type IN ('move_in', 'move_out') AND NEW.lease_id IS NULL THEN
      RAISE EXCEPTION 'a % inspection is of a lease', NEW.inspection_type USING ERRCODE = 'check_violation', DETAIL = 'inspection-lease';
    END IF;
    IF NEW.lease_id IS NOT NULL THEN
      SELECT * INTO l FROM leases WHERE company_id = NEW.company_id AND id = NEW.lease_id;
      IF l.unit_id IS DISTINCT FROM NEW.unit_id THEN
        RAISE EXCEPTION 'lease % is of another unit', l.reference USING ERRCODE = 'check_violation', DETAIL = 'inspection-lease';
      END IF;
      IF l.status IN ('draft', 'cancelled', 'closed')
         OR (NEW.inspection_type = 'move_out' AND l.status NOT IN ('active', 'periodic', 'notice_given', 'ended')) THEN
        RAISE EXCEPTION 'lease % is %: no % inspection is scheduled for it', l.reference, l.status, NEW.inspection_type
          USING ERRCODE = 'check_violation', DETAIL = 'inspection-lease-status';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  FOREACH col IN ARRAY ARRAY['company_id', 'reference', 'property_id', 'unit_id', 'lease_id', 'inspection_type', 'created_by', 'created_at'] LOOP
    IF to_jsonb(OLD) -> col IS DISTINCT FROM to_jsonb(NEW) -> col THEN
      RAISE EXCEPTION 'the % of an inspection is fixed', col USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'inspection % is cancelled', OLD.reference USING ERRCODE = 'check_violation', DETAIL = 'inspection-final';
  END IF;
  IF OLD.status = 'completed' THEN
    -- Only the tenant's acknowledgement is added, once.
    IF OLD.tenant_signed_at IS NOT NULL OR NEW.tenant_signed_at IS NULL
       OR (to_jsonb(OLD) - 'tenant_signed_at' - 'updated_at' - 'version') IS DISTINCT FROM (to_jsonb(NEW) - 'tenant_signed_at' - 'updated_at' - 'version') THEN
      RAISE EXCEPTION 'inspection % is completed: only the tenant''s acknowledgement is added, once', OLD.reference
        USING ERRCODE = 'check_violation', DETAIL = 'inspection-final';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'scheduled' AND NEW.status IN ('in_progress', 'cancelled'))
    OR (OLD.status = 'in_progress' AND NEW.status IN ('completed', 'cancelled'))) THEN
    RAISE EXCEPTION 'a % inspection cannot become %', OLD.status, NEW.status USING ERRCODE = 'check_violation', DETAIL = 'inspection-transition';
  END IF;
  IF NEW.status = 'completed' THEN
    IF NEW.overall_condition IS NULL THEN
      RAISE EXCEPTION 'a completed inspection records the overall condition' USING ERRCODE = 'check_violation', DETAIL = 'inspection-condition';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM inspection_items WHERE company_id = NEW.company_id AND inspection_id = NEW.id)
       OR EXISTS (SELECT 1 FROM inspection_items WHERE company_id = NEW.company_id AND inspection_id = NEW.id AND condition_code IS NULL) THEN
      RAISE EXCEPTION 'a completed inspection records the condition of every item' USING ERRCODE = 'check_violation', DETAIL = 'inspection-items';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER inspections_guard BEFORE INSERT OR UPDATE OR DELETE ON inspections
  FOR EACH ROW EXECUTE FUNCTION app.inspections_guard();

-- Items change only while the inspection is scheduled or in progress.
CREATE FUNCTION app.inspection_items_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_status text;
  row_company uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.company_id ELSE NEW.company_id END;
  row_inspection uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.inspection_id ELSE NEW.inspection_id END;
BEGIN
  IF TG_OP = 'UPDATE' AND app.erasure_in_progress() AND NEW.notes = '[Erased]'
     AND (to_jsonb(OLD) - 'notes') = (to_jsonb(NEW) - 'notes') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.inspection_id IS DISTINCT FROM OLD.inspection_id THEN
    RAISE EXCEPTION 'an item stays with its inspection' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT status INTO parent_status FROM inspections WHERE company_id = row_company AND id = row_inspection;
  IF parent_status NOT IN ('scheduled', 'in_progress') THEN
    RAISE EXCEPTION 'the inspection is %: its items no longer change', parent_status
      USING ERRCODE = 'check_violation', DETAIL = 'inspection-items-final';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER inspection_items_guard BEFORE INSERT OR UPDATE OR DELETE ON inspection_items
  FOR EACH ROW EXECUTE FUNCTION app.inspection_items_guard();

-- -----------------------------------------------------------------------------
-- 5. Inspection item photos (W7-S1)
-- -----------------------------------------------------------------------------
CREATE TABLE inspection_item_documents (
  company_id          uuid         NOT NULL,
  inspection_item_id  uuid         NOT NULL,
  document_id         uuid         NOT NULL,
  caption             text         CHECK (char_length(caption) BETWEEN 1 AND 200),
  created_by          uuid,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, inspection_item_id, document_id),
  FOREIGN KEY (company_id, inspection_item_id) REFERENCES inspection_items (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, document_id) REFERENCES documents (company_id, id),
  FOREIGN KEY (company_id, created_by) REFERENCES company_memberships (company_id, id)
);
COMMENT ON TABLE inspection_item_documents IS 'Photos of an inspection item (W7-S1): scanned documents of the inspection, linked to one item';
CREATE INDEX inspection_item_documents_document_idx ON inspection_item_documents (company_id, document_id);
CREATE INDEX inspection_item_documents_created_by_idx ON inspection_item_documents (company_id, created_by);
ALTER TABLE inspection_item_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection_item_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON inspection_item_documents FOR ALL TO estatepro_app
  USING (company_id = app.current_company_id()) WITH CHECK (company_id = app.current_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON inspection_item_documents TO estatepro_app;
GRANT SELECT ON inspection_item_documents TO estatepro_platform;

CREATE FUNCTION app.inspection_item_documents_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  inspection uuid;
  parent_status text;
  row_company uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.company_id ELSE NEW.company_id END;
  row_item uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.inspection_item_id ELSE NEW.inspection_item_id END;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF app.erasure_in_progress() AND NEW.caption = '[Erased]' AND (to_jsonb(OLD) - 'caption') = (to_jsonb(NEW) - 'caption') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'a photo link is added or removed, not changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT i.inspection_id, s.status INTO inspection, parent_status
    FROM inspection_items i JOIN inspections s ON s.company_id = i.company_id AND s.id = i.inspection_id
   WHERE i.company_id = row_company AND i.id = row_item;
  -- An item removed with its photos (cascade) is checked by the item guard.
  IF TG_OP = 'DELETE' AND inspection IS NULL THEN
    RETURN OLD;
  END IF;
  IF parent_status NOT IN ('scheduled', 'in_progress') THEN
    RAISE EXCEPTION 'the inspection is %: its photos no longer change', parent_status
      USING ERRCODE = 'check_violation', DETAIL = 'inspection-items-final';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (
       SELECT 1 FROM document_links dl
        WHERE dl.company_id = NEW.company_id AND dl.document_id = NEW.document_id
          AND dl.entity_type = 'inspection' AND dl.entity_id = inspection) THEN
    RAISE EXCEPTION 'the photo is not a document of this inspection' USING ERRCODE = 'check_violation', DETAIL = 'inspection-photo-document';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER inspection_item_documents_guard BEFORE INSERT OR UPDATE OR DELETE ON inspection_item_documents
  FOR EACH ROW EXECUTE FUNCTION app.inspection_item_documents_guard();

-- -----------------------------------------------------------------------------
-- 6. Documents of an inspection
-- -----------------------------------------------------------------------------
ALTER TABLE document_upload_sessions DROP CONSTRAINT document_upload_sessions_entity_type_check;
ALTER TABLE document_upload_sessions ADD CONSTRAINT document_upload_sessions_entity_type_check
  CHECK (entity_type IN ('lease', 'management_agreement', 'bank_account', 'inspection'));
INSERT INTO picklist_values (list_key, code, label, country_code, sort_order) VALUES
  ('document_type', 'inspection_photo', 'Inspection photo', NULL, 18);

-- -----------------------------------------------------------------------------
-- 7. Erasure of lettings free text (migration 0038), with inspection reasons and photo captions
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
  UPDATE inspections
     SET summary = CASE WHEN summary IS NULL THEN NULL ELSE '[Erased]' END,
         cancelled_reason = CASE WHEN cancelled_reason IS NULL THEN NULL ELSE '[Erased]' END
   WHERE company_id = company AND id = ANY (inspection_ids)
     AND (summary IS DISTINCT FROM '[Erased]' OR cancelled_reason IS DISTINCT FROM '[Erased]')
     AND (summary IS NOT NULL OR cancelled_reason IS NOT NULL);
  UPDATE inspection_items SET notes = '[Erased]' WHERE company_id = company AND inspection_id = ANY (inspection_ids) AND notes IS NOT NULL AND notes <> '[Erased]';
  UPDATE inspection_item_documents d SET caption = '[Erased]'
    FROM inspection_items i
   WHERE d.company_id = company AND i.company_id = company AND i.id = d.inspection_item_id AND i.inspection_id = ANY (inspection_ids)
     AND d.caption IS NOT NULL AND d.caption <> '[Erased]';
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
