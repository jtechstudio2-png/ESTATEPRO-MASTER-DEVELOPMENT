-- =============================================================================
-- EstatePro · Migration 0037 · Rent schedule, charges and rent reviews (L2)
-- =============================================================================
-- Phase 7 milestone L2 (readiness report §5.2, §5.6, P7-D6; wireframes RL-1,
-- RC-1 to RC-4, RR-1, ST-2):
--
--  1. Rent schedule. A lease's rent periods follow its frequency, from the
--     start date or, with pro-rating and a due day, from the first due day
--     after it (the first, shorter period pro-rated by actual days). The final
--     period is cut at the end date and pro-rated the same way. The rent of a
--     period is the rent in force on its first day (applied rent reviews).
--     The first period and `advance_periods` further periods are due on the
--     start date (charged at signing). app.post_rent_charges creates the
--     uncharged periods up to a date, once each: a period that has a charge
--     of any status is never charged again. `leases.rent_schedule_from` says
--     from when a lease is charged (set at activation; for an imported live
--     lease, set once by a person), and is then fixed.
--  2. Charges. Inserted only for a lease that is live (or ended, for
--     recharges), in the lease's currency, and only where the agency collects
--     the rent: never under a let-only agreement or one that is not active
--     (readiness §5.1). A charge is never dated in a locked financial period,
--     and is not waived or cancelled there.
--  3. Rent reviews: scheduled → proposed → agreed → applied (disputed and
--     cancelled on the way); one open review per lease; agreed terms are
--     fixed; applied and cancelled reviews are final; a review is applied
--     only from a date no rent has been charged for yet, so a charge already
--     raised never changes (adjust it instead).
-- Tax on a charge, when it names a tax code, is computed from the code's
-- configured components in force on the charge's first day (app.tax_amount).
-- The database tests are database/tests/20_rent_schedule_l2.sql.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Rent schedule
-- -----------------------------------------------------------------------------
ALTER TABLE leases ADD COLUMN rent_schedule_from date;
COMMENT ON COLUMN leases.rent_schedule_from IS 'First day rent periods are charged from (set at activation, or once for an imported lease); fixed once set.';

CREATE FUNCTION app.leases_rent_schedule_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.rent_schedule_from IS NOT DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.rent_schedule_from END) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.rent_schedule_from IS NOT NULL THEN
    RAISE EXCEPTION 'lease %: the rent schedule start is fixed once set', NEW.reference
      USING ERRCODE = 'insufficient_privilege', DETAIL = 'schedule-fixed';
  END IF;
  IF NEW.status NOT IN ('active', 'periodic', 'notice_given') THEN
    RAISE EXCEPTION 'lease % is %: rent is scheduled only for a live lease', NEW.reference, NEW.status
      USING ERRCODE = 'check_violation', DETAIL = 'schedule-not-live';
  END IF;
  IF NEW.rent_schedule_from < NEW.start_date OR (NEW.end_date IS NOT NULL AND NEW.status <> 'periodic' AND NEW.rent_schedule_from > NEW.end_date) THEN
    RAISE EXCEPTION 'lease %: the rent schedule starts within the lease dates', NEW.reference
      USING ERRCODE = 'check_violation', DETAIL = 'schedule-dates';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER leases_rent_schedule_guard BEFORE INSERT OR UPDATE OF rent_schedule_from ON leases
  FOR EACH ROW EXECUTE FUNCTION app.leases_rent_schedule_guard();

CREATE INDEX leases_rent_schedule_idx ON leases (company_id, id)
  WHERE rent_schedule_from IS NOT NULL AND status IN ('active', 'periodic', 'notice_given');
-- Periods already charged, whatever the charge's status (the job's "once each").
CREATE INDEX rent_charges_lease_period_idx ON rent_charges (company_id, lease_id, charge_type, period_start);

-- Tax from a code's components in force on a date: simple components on the
-- amount, compound ones on the amount plus the components before them, each
-- rounded to the currency's minor units. No code, no tax.
CREATE FUNCTION app.tax_amount(p_tax_code uuid, p_amount numeric, p_on date, p_minor_units integer) RETURNS numeric
LANGUAGE plpgsql STABLE AS $$
DECLARE
  comp record;
  total numeric := 0;
  part numeric;
BEGIN
  IF p_tax_code IS NULL THEN
    RETURN 0;
  END IF;
  FOR comp IN
    SELECT rate_percent, is_compound FROM tax_code_components
     WHERE tax_code_id = p_tax_code AND effective_from <= p_on AND (effective_to IS NULL OR effective_to > p_on)
     ORDER BY sequence, id
  LOOP
    part := round((p_amount + CASE WHEN comp.is_compound THEN total ELSE 0 END) * comp.rate_percent / 100, p_minor_units);
    total := total + part;
  END LOOP;
  RETURN total;
END
$$;

-- The rent in force on a date: the latest applied review effective by then,
-- otherwise the lease's rent.
CREATE FUNCTION app.rent_in_force(p_company uuid, p_lease uuid, p_on date) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT r.agreed_amount FROM rent_reviews r
      WHERE r.company_id = p_company AND r.lease_id = p_lease AND r.status = 'applied' AND r.effective_from <= p_on
      ORDER BY r.effective_from DESC, r.id DESC LIMIT 1),
    (SELECT l.rent_amount FROM leases l WHERE l.company_id = p_company AND l.id = p_lease))
$$;

-- The day of month `p_day` (clamped to the month's length) of the month
-- `p_months` after the month of `p_base`.
CREATE FUNCTION app.month_day(p_base date, p_months integer, p_day integer) RETURNS date
LANGUAGE sql IMMUTABLE AS $$
  SELECT m + (least(p_day, extract(day FROM (m + interval '1 month' - interval '1 day'))::integer) - 1)
    FROM (SELECT (date_trunc('month', p_base) + make_interval(months => p_months))::date AS m) s
$$;

-- Rent periods of a lease not yet charged, up to `p_through` (periods
-- starting on or before it), plus the periods due at signing. Returns nothing
-- for a lease that is not live, has no schedule start, or whose rent the
-- agency does not collect.
CREATE FUNCTION app.lease_rent_due(p_company uuid, p_lease uuid, p_through date)
RETURNS TABLE (period_start date, period_end date, due_date date, amount numeric, tax_amount numeric, currency_code char(3))
LANGUAGE plpgsql STABLE AS $$
DECLARE
  l leases%ROWTYPE;
  months integer;
  day_no integer;
  first_full date;      -- first day of full period 0
  bound date;           -- last day charged (NULL: open-ended)
  minor integer;
  k integer;
  k_hi integer;
  full_start date;
  full_end date;
  eff_start date;
  eff_end date;
  rent numeric;
  charged date;
  lower_bound date;
  is_advance boolean;
BEGIN
  SELECT * INTO l FROM leases WHERE company_id = p_company AND id = p_lease;
  IF NOT FOUND OR l.rent_schedule_from IS NULL OR l.status NOT IN ('active', 'periodic', 'notice_given') THEN
    RETURN;
  END IF;
  IF l.management_agreement_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM management_agreements m
        WHERE m.company_id = p_company AND m.id = l.management_agreement_id
          AND m.status = 'active' AND m.service_level IN ('rent_collection', 'fully_managed')) THEN
    RETURN;
  END IF;
  SELECT c.minor_units INTO minor FROM currencies c WHERE c.code = l.currency_code;
  months := CASE l.rent_frequency WHEN 'monthly' THEN 1 WHEN 'quarterly' THEN 3 WHEN 'semi_annual' THEN 6 WHEN 'annual' THEN 12 ELSE 0 END;
  bound := CASE WHEN l.status = 'periodic' THEN NULL ELSE l.end_date END;
  IF months = 0 THEN
    first_full := l.start_date;  -- weekly: periods of 7 days from the start date
  ELSIF l.prorate_first_period AND l.rent_due_day IS NOT NULL THEN
    day_no := l.rent_due_day;
    first_full := app.month_day(l.start_date, 0, day_no);
    IF first_full < l.start_date THEN
      first_full := app.month_day(l.start_date, 1, day_no);
    END IF;
  ELSE
    day_no := extract(day FROM l.start_date)::integer;
    first_full := l.start_date;
  END IF;

  -- Skip the periods charged already: start one period before the latest
  -- charged period or the schedule start, whichever is later.
  SELECT max(rc.period_start) INTO charged FROM rent_charges rc
   WHERE rc.company_id = p_company AND rc.lease_id = p_lease AND rc.charge_type = 'rent';
  lower_bound := greatest(l.rent_schedule_from, coalesce(charged, l.rent_schedule_from));
  IF months = 0 THEN
    k := greatest(-1, floor((lower_bound - first_full) / 7.0)::integer - 1);
  ELSE
    k := greatest(-1, floor(((extract(year FROM lower_bound) - extract(year FROM first_full)) * 12
                             + extract(month FROM lower_bound) - extract(month FROM first_full)) / months)::integer - 1);
  END IF;
  -- Always reach the periods due at signing.
  k_hi := greatest(l.advance_periods - 1, -1);

  LOOP
    IF months = 0 THEN
      full_start := first_full + 7 * k;
      full_end := full_start + 6;
    ELSE
      full_start := app.month_day(first_full, k * months, day_no);
      full_end := app.month_day(first_full, (k + 1) * months, day_no) - 1;
    END IF;
    eff_start := greatest(full_start, l.start_date);
    eff_end := CASE WHEN bound IS NULL THEN full_end ELSE least(full_end, bound) END;
    EXIT WHEN bound IS NOT NULL AND eff_start > bound;
    EXIT WHEN eff_start > p_through AND k > k_hi;
    is_advance := k <= k_hi;
    IF full_end >= l.start_date AND eff_start >= l.rent_schedule_from
       AND (eff_start <= p_through OR is_advance)
       AND NOT EXISTS (SELECT 1 FROM rent_charges rc
                        WHERE rc.company_id = p_company AND rc.lease_id = p_lease
                          AND rc.charge_type = 'rent' AND rc.period_start = eff_start) THEN
      rent := app.rent_in_force(p_company, p_lease, eff_start);
      amount := round(rent * (eff_end - eff_start + 1) / (full_end - full_start + 1), minor);
      IF amount > 0 THEN
        period_start := eff_start;
        period_end := eff_end;
        due_date := CASE WHEN is_advance THEN l.start_date ELSE eff_start END;
        tax_amount := app.tax_amount(l.rent_tax_code_id, amount, eff_start, minor);
        currency_code := l.currency_code;
        RETURN NEXT;
      END IF;
    END IF;
    k := k + 1;
  END LOOP;
END
$$;

-- Creates (posts) a lease's uncharged rent up to `p_through` and returns the
-- new charges. Safe to run again and alongside another run: the period index
-- rejects a second charge for the same period, and those rows are skipped.
CREATE FUNCTION app.post_rent_charges(p_company uuid, p_lease uuid, p_through date, p_actor uuid)
RETURNS SETOF rent_charges
LANGUAGE sql AS $$
  INSERT INTO rent_charges (company_id, lease_id, charge_type, description, period_start, period_end, due_date,
                            currency_code, amount, tax_code_id, tax_amount, status, source, posted_at, created_by)
  SELECT p_company, p_lease, 'rent', format('Rent %s to %s', d.period_start, d.period_end), d.period_start, d.period_end, d.due_date,
         d.currency_code, d.amount, l.rent_tax_code_id, d.tax_amount, 'posted', 'schedule', now(), p_actor
    FROM app.lease_rent_due(p_company, p_lease, p_through) d
    JOIN leases l ON l.company_id = p_company AND l.id = p_lease
  ON CONFLICT (company_id, lease_id, charge_type, period_start) WHERE status IN ('scheduled', 'posted') AND period_start IS NOT NULL
  DO NOTHING
  RETURNING *
$$;

-- -----------------------------------------------------------------------------
-- 2. Charges: where and when they may be raised
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.rent_charges_insert_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  l leases%ROWTYPE;
  agreement management_agreements%ROWTYPE;
BEGIN
  SELECT * INTO l FROM leases WHERE company_id = NEW.company_id AND id = NEW.lease_id;
  IF l.status NOT IN ('active', 'periodic', 'notice_given', 'ended') THEN
    RAISE EXCEPTION 'lease % is %: charges are raised only on a live or ended lease', l.reference, l.status
      USING ERRCODE = 'check_violation', DETAIL = 'charge-lease-status';
  END IF;
  IF NEW.currency_code <> l.currency_code THEN
    RAISE EXCEPTION 'a charge on lease % is in %', l.reference, l.currency_code
      USING ERRCODE = 'check_violation', DETAIL = 'charge-currency';
  END IF;
  IF l.management_agreement_id IS NOT NULL THEN
    SELECT * INTO agreement FROM management_agreements WHERE company_id = NEW.company_id AND id = l.management_agreement_id;
    IF agreement.service_level = 'let_only' THEN
      RAISE EXCEPTION 'management agreement % is let only: the agency does not collect this lease''s rent', agreement.reference
        USING ERRCODE = 'check_violation', DETAIL = 'charge-let-only';
    END IF;
    IF agreement.status IN ('draft', 'suspended') THEN
      RAISE EXCEPTION 'management agreement % is %: no charges are raised under it', agreement.reference, agreement.status
        USING ERRCODE = 'check_violation', DETAIL = 'charge-agreement-status';
    END IF;
  END IF;
  IF NEW.status NOT IN ('scheduled', 'posted') THEN
    RAISE EXCEPTION 'a charge starts scheduled or posted' USING ERRCODE = 'check_violation', DETAIL = 'charge-start-status';
  END IF;
  IF NEW.status = 'posted' AND NEW.posted_at IS NULL THEN
    NEW.posted_at := now();
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER rent_charges_insert_rules BEFORE INSERT ON rent_charges
  FOR EACH ROW EXECUTE FUNCTION app.rent_charges_insert_rules();

-- A charge is never raised in, or waived or cancelled out of, a locked period.
CREATE FUNCTION app.rent_charges_open_period() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM app.assert_period_open(NEW.company_id, NEW.due_date);
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'scheduled' AND NEW.status = 'posted' AND NEW.posted_at IS NULL THEN
    NEW.posted_at := now();
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER rent_charges_open_period BEFORE INSERT OR UPDATE ON rent_charges
  FOR EACH ROW EXECUTE FUNCTION app.rent_charges_open_period();

-- -----------------------------------------------------------------------------
-- 3. Rent reviews
-- -----------------------------------------------------------------------------
ALTER TABLE rent_reviews ADD COLUMN due_notified_at timestamptz;
COMMENT ON COLUMN rent_reviews.due_notified_at IS 'When the "review due" notice was written to the outbox (once).';
ALTER TABLE rent_reviews ADD CONSTRAINT rent_reviews_amounts_positive
  CHECK ((proposed_amount IS NULL OR proposed_amount > 0) AND (agreed_amount IS NULL OR agreed_amount > 0) AND old_amount > 0);
CREATE UNIQUE INDEX rent_reviews_one_open_idx ON rent_reviews (company_id, lease_id)
  WHERE status IN ('scheduled', 'proposed', 'agreed', 'disputed');
CREATE INDEX rent_reviews_lease_idx ON rent_reviews (company_id, lease_id, review_date DESC);

CREATE FUNCTION app.rent_reviews_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  l leases%ROWTYPE;
  ok boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'rent reviews are not deleted; cancel the review instead' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO l FROM leases WHERE company_id = NEW.company_id AND id = NEW.lease_id;
  IF TG_OP = 'INSERT' THEN
    IF l.status NOT IN ('pending_signature', 'active', 'periodic', 'notice_given') THEN
      RAISE EXCEPTION 'lease % is %: reviews are scheduled for a signed or live lease', l.reference, l.status
        USING ERRCODE = 'check_violation', DETAIL = 'review-lease-status';
    END IF;
    IF NEW.status NOT IN ('scheduled', 'proposed') THEN
      RAISE EXCEPTION 'a rent review starts scheduled or proposed' USING ERRCODE = 'check_violation', DETAIL = 'review-start-status';
    END IF;
    IF NEW.review_date < l.start_date THEN
      RAISE EXCEPTION 'a rent review falls within the lease' USING ERRCODE = 'check_violation', DETAIL = 'review-date';
    END IF;
    RETURN NEW;
  END IF;

  -- Never changed: the lease, the rent before the review, when it was created.
  IF NEW.lease_id <> OLD.lease_id OR NEW.old_amount <> OLD.old_amount OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'the lease and starting rent of a review are fixed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.due_notified_at IS NOT NULL AND NEW.due_notified_at IS DISTINCT FROM OLD.due_notified_at THEN
    RAISE EXCEPTION 'the review notice time is recorded once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Applied and cancelled reviews are final (an erasure may blank the notes, ADR-009).
  IF OLD.status IN ('applied', 'cancelled') THEN
    IF (to_jsonb(OLD) - ARRAY['notes', 'updated_at', 'version']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['notes', 'updated_at', 'version'])
       OR (NEW.notes IS DISTINCT FROM OLD.notes AND NOT (app.erasure_in_progress() AND NEW.notes = '[Erased]')) THEN
      RAISE EXCEPTION 'a % rent review is final', OLD.status USING ERRCODE = 'insufficient_privilege', DETAIL = 'review-final';
    END IF;
    RETURN NEW;
  END IF;
  -- Agreed terms are fixed: an agreed review is applied or cancelled.
  IF OLD.status = 'agreed' AND (NEW.agreed_amount IS DISTINCT FROM OLD.agreed_amount OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
                                OR NEW.proposed_amount IS DISTINCT FROM OLD.proposed_amount OR NEW.review_date IS DISTINCT FROM OLD.review_date
                                OR NEW.method IS DISTINCT FROM OLD.method) THEN
    RAISE EXCEPTION 'the agreed terms of a rent review are fixed; cancel it and schedule another' USING ERRCODE = 'insufficient_privilege', DETAIL = 'review-agreed-fixed';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    ok := (OLD.status = 'scheduled' AND NEW.status IN ('proposed', 'agreed', 'cancelled'))
       OR (OLD.status = 'proposed' AND NEW.status IN ('agreed', 'disputed', 'cancelled'))
       OR (OLD.status = 'disputed' AND NEW.status IN ('proposed', 'agreed', 'cancelled'))
       OR (OLD.status = 'agreed' AND NEW.status IN ('applied', 'cancelled'));
    IF NOT ok THEN
      RAISE EXCEPTION 'a % rent review cannot become %', OLD.status, NEW.status USING ERRCODE = 'check_violation', DETAIL = 'review-transition';
    END IF;
  END IF;
  IF NEW.status = 'proposed' AND NEW.proposed_amount IS NULL THEN
    RAISE EXCEPTION 'a proposed review names the proposed rent' USING ERRCODE = 'check_violation', DETAIL = 'review-proposed-amount';
  END IF;
  IF NEW.status = 'agreed' AND OLD.status <> 'agreed' AND NEW.effective_from < l.start_date THEN
    RAISE EXCEPTION 'the new rent takes effect within the lease' USING ERRCODE = 'check_violation', DETAIL = 'review-effective-date';
  END IF;
  IF NEW.status = 'applied' THEN
    IF l.status NOT IN ('active', 'periodic', 'notice_given') THEN
      RAISE EXCEPTION 'lease % is %: a review is applied to a live lease', l.reference, l.status
        USING ERRCODE = 'check_violation', DETAIL = 'review-lease-status';
    END IF;
    IF EXISTS (SELECT 1 FROM rent_charges rc
                WHERE rc.company_id = NEW.company_id AND rc.lease_id = NEW.lease_id AND rc.charge_type = 'rent'
                  AND rc.status IN ('scheduled', 'posted') AND rc.period_start >= NEW.effective_from) THEN
      RAISE EXCEPTION 'rent is already charged from %; apply the review from a later date or adjust those charges', NEW.effective_from
        USING ERRCODE = 'check_violation', DETAIL = 'review-already-charged';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER rent_reviews_guard BEFORE INSERT OR UPDATE OR DELETE ON rent_reviews
  FOR EACH ROW EXECUTE FUNCTION app.rent_reviews_guard();
