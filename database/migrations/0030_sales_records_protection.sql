-- =============================================================================
-- EstatePro · Migration 0030 · Sales records: integrity, erasure, retention (P6-0)
-- =============================================================================
-- Governance for the sales-pipeline tables of migration 0007 before any
-- viewing, offer or deal is written (ADR-008):
--
--  1. Transaction-history integrity. Deal stage history is written by the
--     database on every stage change and is append-only. Offers keep their
--     terms, move through allowed statuses only and form a valid counter-offer
--     chain. Viewings, milestones and sales transactions become final when
--     finished. Closed deals do not reopen. A converted lead points at the one
--     deal made from it. Nothing in the pipeline is deleted by the runtime role.
--  2. Erasure (ADR-007 §8). app.erase_contact also anonymises the free text of
--     the pipeline: viewing feedback, cancellation reasons and meeting points;
--     offer conditions; deal lost notes, stage-change notes and milestone notes;
--     fall-through reasons. Amounts, dates, stages and statuses are kept.
--  3. Erasure blockers. A person cannot be erased while a party to an active
--     deal, or to a recorded sale that is still open or within its retention
--     period (jurisdiction rule sales_records_retention_years; while no value
--     is set, recorded sales are kept and erasure stays blocked).
--  4. Accountants read viewings and offers, as the specification states.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Jurisdiction rules readable in SQL (the API resolves the same chain)
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.jurisdiction_rule(p_code text, p_key text, p_on date) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT s.value
       FROM jurisdictions j
       JOIN jurisdiction_settings s
         ON s.key = p_key AND s.jurisdiction_code IN (j.code, j.parent_code)
        AND s.effective_from <= p_on AND (s.effective_to IS NULL OR s.effective_to > p_on)
      WHERE j.code = p_code
      ORDER BY (s.jurisdiction_code = j.code) DESC, s.effective_from DESC
      LIMIT 1),
    (SELECT d.default_value FROM jurisdiction_setting_definitions d WHERE d.key = p_key))
$$;
GRANT EXECUTE ON FUNCTION app.jurisdiction_rule(text, text, date) TO estatepro_app, estatepro_platform;

INSERT INTO jurisdiction_setting_definitions (key, data_type, description, default_value) VALUES
  ('sales_records_retention_years', 'integer',
   'Years a completed sale''s records are kept after completion before its parties may be erased (ADR-008). No value: kept, erasure blocked', NULL);

-- -----------------------------------------------------------------------------
-- 1. Deals: stage history written by the database; closed deals are final
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.deals_record_stage() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO deal_stage_history (company_id, deal_id, from_stage_id, to_stage_id, changed_by, note)
  VALUES (NEW.company_id, NEW.id,
          CASE WHEN TG_OP = 'UPDATE' THEN OLD.stage_id END,
          NEW.stage_id,
          (SELECT m.id FROM company_memberships m
            WHERE m.company_id = NEW.company_id AND m.user_id = app.current_user_id()
            ORDER BY m.created_at LIMIT 1),
          nullif(current_setting('app.stage_note', true), ''));
  RETURN NULL;
END;
$$;
CREATE TRIGGER deals_record_stage_insert AFTER INSERT ON deals
  FOR EACH ROW EXECUTE FUNCTION app.deals_record_stage();
CREATE TRIGGER deals_record_stage_update AFTER UPDATE OF stage_id ON deals
  FOR EACH ROW WHEN (OLD.stage_id IS DISTINCT FROM NEW.stage_id) EXECUTE FUNCTION app.deals_record_stage();

CREATE FUNCTION app.deals_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.stage_class IN ('closed_won', 'closed_lost') THEN
    IF (NEW.stage_id, NEW.deal_type, NEW.listing_id, NEW.unit_id, NEW.currency_code, NEW.closed_at, NEW.lost_reason_code)
       IS DISTINCT FROM
       (OLD.stage_id, OLD.deal_type, OLD.listing_id, OLD.unit_id, OLD.currency_code, OLD.closed_at, OLD.lost_reason_code) THEN
      RAISE EXCEPTION 'deal % is closed and cannot change stage or terms', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.lost_notes IS DISTINCT FROM OLD.lost_notes
       AND NOT (app.erasure_in_progress() AND NEW.lost_notes = '[Erased]') THEN
      RAISE EXCEPTION 'the notes of closed deal % cannot be changed', OLD.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER deals_guard BEFORE UPDATE ON deals FOR EACH ROW EXECUTE FUNCTION app.deals_guard();

CREATE TRIGGER deal_stage_history_append_only BEFORE UPDATE OR DELETE ON deal_stage_history
  FOR EACH ROW EXECUTE FUNCTION app.history_erasure_guard('note');

-- A lead converts to one deal, and the deal points back at it.
CREATE UNIQUE INDEX deals_one_per_lead_idx ON deals (company_id, lead_id) WHERE lead_id IS NOT NULL;

CREATE FUNCTION app.leads_conversion_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.converted_deal_id IS DISTINCT FROM OLD.converted_deal_id AND OLD.converted_deal_id IS NOT NULL THEN
    RAISE EXCEPTION 'lead % is already converted to deal %', OLD.id, OLD.converted_deal_id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.converted_deal_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM deals d WHERE d.company_id = NEW.company_id AND d.id = NEW.converted_deal_id AND d.lead_id = NEW.id) THEN
    RAISE EXCEPTION 'lead % can only point at the deal made from it', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER leads_conversion_guard BEFORE UPDATE OF converted_deal_id, status ON leads
  FOR EACH ROW EXECUTE FUNCTION app.leads_conversion_guard();

-- -----------------------------------------------------------------------------
-- 2. Offers: immutable terms, allowed statuses, valid counter-offer chain
-- -----------------------------------------------------------------------------
DROP TRIGGER offers_protect_terms ON offers;
DROP FUNCTION app.offers_protect_terms();

CREATE FUNCTION app.offers_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  deal record;
  parent record;
BEGIN
  IF NEW.status <> 'submitted' OR NEW.responded_at IS NOT NULL THEN
    RAISE EXCEPTION 'an offer is recorded as submitted' USING ERRCODE = 'check_violation';
  END IF;
  SELECT listing_id, currency_code, stage_class INTO deal FROM deals WHERE company_id = NEW.company_id AND id = NEW.deal_id;
  IF deal.stage_class IN ('closed_won', 'closed_lost') THEN
    RAISE EXCEPTION 'deal % is closed', NEW.deal_id USING ERRCODE = 'check_violation';
  END IF;
  IF deal.listing_id IS NOT NULL AND deal.listing_id <> NEW.listing_id THEN
    RAISE EXCEPTION 'an offer is for the listing of its deal' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.currency_code <> deal.currency_code THEN
    RAISE EXCEPTION 'an offer is in the currency of its deal' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.parent_offer_id IS NOT NULL THEN
    SELECT deal_id, direction, status INTO parent FROM offers WHERE company_id = NEW.company_id AND id = NEW.parent_offer_id;
    IF parent.deal_id <> NEW.deal_id OR parent.direction = NEW.direction OR parent.status NOT IN ('submitted', 'countered') THEN
      RAISE EXCEPTION 'a counter-offer answers an open offer of the other side in the same deal' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER offers_insert_guard BEFORE INSERT ON offers FOR EACH ROW EXECUTE FUNCTION app.offers_insert_guard();

CREATE FUNCTION app.offers_update_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'offers are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.amount, NEW.currency_code, NEW.rent_frequency, NEW.financing_code, NEW.deal_id, NEW.listing_id,
      NEW.offered_by_contact_id, NEW.direction, NEW.parent_offer_id, NEW.submitted_at, NEW.expires_at, NEW.recorded_by, NEW.entry_no)
     IS DISTINCT FROM
     (OLD.amount, OLD.currency_code, OLD.rent_frequency, OLD.financing_code, OLD.deal_id, OLD.listing_id,
      OLD.offered_by_contact_id, OLD.direction, OLD.parent_offer_id, OLD.submitted_at, OLD.expires_at, OLD.recorded_by, OLD.entry_no) THEN
    RAISE EXCEPTION 'offer terms are immutable; record a counter-offer instead' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.conditions IS DISTINCT FROM OLD.conditions
     AND NOT (app.erasure_in_progress() AND NEW.conditions = '[Erased]') THEN
    RAISE EXCEPTION 'offer conditions are immutable; record a counter-offer instead' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'submitted' AND NEW.status IN ('countered', 'accepted', 'rejected', 'withdrawn', 'expired'))
         OR (OLD.status = 'accepted' AND NEW.status = 'withdrawn')) THEN
      RAISE EXCEPTION 'an offer cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.responded_at IS DISTINCT FROM OLD.responded_at THEN
    RAISE EXCEPTION 'the response time changes only with the status' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER offers_update_guard BEFORE UPDATE OR DELETE ON offers FOR EACH ROW EXECUTE FUNCTION app.offers_update_guard();

-- -----------------------------------------------------------------------------
-- 3. Viewings: allowed statuses; finished viewings are final
-- -----------------------------------------------------------------------------
ALTER TABLE viewings
  ADD CONSTRAINT viewings_cancel_reason CHECK (status <> 'cancelled' OR cancelled_reason IS NOT NULL),
  ADD CONSTRAINT viewings_rescheduled_link CHECK (status <> 'rescheduled' OR rescheduled_to_id IS NOT NULL);

CREATE FUNCTION app.viewings_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_row jsonb;
  new_row jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'viewings are never deleted; cancel them' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('scheduled', 'confirmed') THEN
      RAISE EXCEPTION 'a viewing is booked as scheduled or confirmed' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('completed', 'cancelled', 'no_show', 'rescheduled') THEN
    -- Finished: only sharing the feedback with the landlord may change, and an erasure may redact text.
    old_row := to_jsonb(OLD) - ARRAY['updated_at', 'version', 'seller_feedback_shared'];
    new_row := to_jsonb(NEW) - ARRAY['updated_at', 'version', 'seller_feedback_shared'];
    IF app.erasure_in_progress() THEN
      old_row := old_row - ARRAY['feedback', 'cancelled_reason', 'meeting_point'];
      new_row := new_row - ARRAY['feedback', 'cancelled_reason', 'meeting_point'];
    END IF;
    IF new_row IS DISTINCT FROM old_row THEN
      RAISE EXCEPTION 'viewing % is % and cannot change', OLD.id, OLD.status USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'scheduled' AND NEW.status IN ('confirmed', 'completed', 'cancelled', 'no_show', 'rescheduled'))
    OR (OLD.status = 'confirmed' AND NEW.status IN ('completed', 'cancelled', 'no_show', 'rescheduled'))) THEN
    RAISE EXCEPTION 'a viewing cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER viewings_guard BEFORE INSERT OR UPDATE OR DELETE ON viewings FOR EACH ROW EXECUTE FUNCTION app.viewings_guard();

-- -----------------------------------------------------------------------------
-- 4. Milestones: completion is final
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.deal_milestones_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'milestones are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.deal_id, NEW.code, NEW.name, NEW.sort_order, NEW.is_required, NEW.milestone_template_id)
     IS DISTINCT FROM (OLD.deal_id, OLD.code, OLD.name, OLD.sort_order, OLD.is_required, OLD.milestone_template_id) THEN
    RAISE EXCEPTION 'a milestone keeps what it is' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.completed_at IS NOT NULL AND (NEW.completed_at, NEW.completed_by, NEW.due_date) IS DISTINCT FROM (OLD.completed_at, OLD.completed_by, OLD.due_date) THEN
    RAISE EXCEPTION 'milestone % is complete', OLD.code USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.completed_at IS NOT NULL AND NEW.notes IS DISTINCT FROM OLD.notes
     AND NOT (app.erasure_in_progress() AND NEW.notes = '[Erased]') THEN
    RAISE EXCEPTION 'the notes of completed milestone % cannot be changed', OLD.code USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER deal_milestones_guard BEFORE UPDATE OR DELETE ON deal_milestones FOR EACH ROW EXECUTE FUNCTION app.deal_milestones_guard();

-- -----------------------------------------------------------------------------
-- 5. Sales transactions: valid accepted offer; allowed statuses; fixed terms
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.sales_transactions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  offer record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sales records are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT deal_id, listing_id, currency_code, status INTO offer
      FROM offers WHERE company_id = NEW.company_id AND id = NEW.accepted_offer_id;
    IF offer.status <> 'accepted' OR offer.deal_id <> NEW.deal_id OR offer.listing_id <> NEW.listing_id OR offer.currency_code <> NEW.currency_code THEN
      RAISE EXCEPTION 'a sale records the accepted offer of its own deal and listing, in its currency' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'a sale is recorded as pending' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'pending'   AND NEW.status IN ('exchanged', 'fallen_through', 'rescinded'))
    OR (OLD.status = 'exchanged' AND NEW.status IN ('completed', 'fallen_through', 'rescinded'))
    OR (OLD.status = 'completed' AND NEW.status = 'rescinded')) THEN
    RAISE EXCEPTION 'a sale cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'pending' AND (NEW.deal_id, NEW.listing_id, NEW.unit_id, NEW.accepted_offer_id, NEW.currency_code, NEW.agreed_price, NEW.reference)
     IS DISTINCT FROM (OLD.deal_id, OLD.listing_id, OLD.unit_id, OLD.accepted_offer_id, OLD.currency_code, OLD.agreed_price, OLD.reference) THEN
    RAISE EXCEPTION 'the terms of sale % are fixed once contracts are exchanged', OLD.reference USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.contract_signed_on IS NOT NULL AND NEW.contract_signed_on IS DISTINCT FROM OLD.contract_signed_on)
     OR (OLD.completed_on IS NOT NULL AND NEW.completed_on IS DISTINCT FROM OLD.completed_on) THEN
    RAISE EXCEPTION 'recorded contract and completion dates of sale % are fixed', OLD.reference USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('fallen_through', 'rescinded') AND to_jsonb(NEW) - ARRAY['updated_at', 'version', 'fallen_through_reason']
     IS DISTINCT FROM to_jsonb(OLD) - ARRAY['updated_at', 'version', 'fallen_through_reason'] THEN
    RAISE EXCEPTION 'sale % is closed', OLD.reference USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.fallen_through_reason IS DISTINCT FROM OLD.fallen_through_reason AND OLD.fallen_through_reason IS NOT NULL
     AND NOT (app.erasure_in_progress() AND NEW.fallen_through_reason = '[Erased]') THEN
    RAISE EXCEPTION 'the fall-through reason of sale % is fixed', OLD.reference USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sales_transactions_guard BEFORE INSERT OR UPDATE OR DELETE ON sales_transactions
  FOR EACH ROW EXECUTE FUNCTION app.sales_transactions_guard();

-- The runtime role never deletes pipeline records, and never writes stage history itself.
REVOKE DELETE ON deals, deal_stage_history, offers, viewings, deal_milestones, sales_transactions FROM estatepro_app;
REVOKE INSERT, UPDATE ON deal_stage_history FROM estatepro_app;

-- -----------------------------------------------------------------------------
-- 6. Erasure blockers: active deals and recorded sales
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.contact_erasure_blockers(p_contact uuid) RETURNS text[]
LANGUAGE plpgsql STABLE AS $$
DECLARE
  company uuid := app.current_company_id();
  kind text;
  blockers text[] := '{}';
  subjects uuid[];
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
    FROM unnest(subjects) AS s(id) CROSS JOIN LATERAL unnest(app.contact_merge_blockers(s.id)) AS b;
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
  RETURN blockers;
END;
$$;

-- -----------------------------------------------------------------------------
-- 7. Erasure of pipeline free text (called by app.erase_contact)
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.erase_contact_sales(company uuid, subjects uuid[], lead_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  deal_ids uuid[];
  offer_ids uuid[];
  viewing_ids uuid[];
  milestone_ids uuid[];
  sale_ids uuid[];
  n bigint;
  counts jsonb := '{}'::jsonb;
BEGIN
  IF NOT app.erasure_in_progress() THEN
    RAISE EXCEPTION 'only an erasure may call this' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT coalesce(array_agg(d.id), '{}') INTO deal_ids FROM deals d
   WHERE d.company_id = company
     AND (d.primary_contact_id = ANY (subjects) OR d.lead_id = ANY (lead_ids)
          OR EXISTS (SELECT 1 FROM deal_parties p WHERE p.company_id = company AND p.deal_id = d.id AND p.contact_id = ANY (subjects)));
  SELECT coalesce(array_agg(o.id), '{}') INTO offer_ids FROM offers o
   WHERE o.company_id = company AND (o.offered_by_contact_id = ANY (subjects) OR o.deal_id = ANY (deal_ids));
  SELECT coalesce(array_agg(v.id), '{}') INTO viewing_ids FROM viewings v
   WHERE v.company_id = company
     AND (v.lead_id = ANY (lead_ids) OR v.deal_id = ANY (deal_ids)
          OR EXISTS (SELECT 1 FROM viewing_attendees a WHERE a.company_id = company AND a.viewing_id = v.id AND a.contact_id = ANY (subjects)));
  SELECT coalesce(array_agg(m.id), '{}') INTO milestone_ids FROM deal_milestones m WHERE m.company_id = company AND m.deal_id = ANY (deal_ids);
  SELECT coalesce(array_agg(t.id), '{}') INTO sale_ids FROM sales_transactions t WHERE t.company_id = company AND t.deal_id = ANY (deal_ids);

  UPDATE deals
     SET lost_notes = CASE WHEN lost_notes IS NULL THEN NULL ELSE '[Erased]' END, custom_fields = '{}'::jsonb
   WHERE company_id = company AND id = ANY (deal_ids) AND (lost_notes IS NOT NULL OR custom_fields <> '{}'::jsonb);
  IF cardinality(deal_ids) > 0 THEN counts := counts || jsonb_build_object('deals', cardinality(deal_ids)); END IF;
  UPDATE deal_stage_history SET note = '[Erased]' WHERE company_id = company AND deal_id = ANY (deal_ids) AND note IS NOT NULL;
  UPDATE deal_milestones SET notes = '[Erased]' WHERE company_id = company AND id = ANY (milestone_ids) AND notes IS NOT NULL;

  UPDATE offers SET conditions = '[Erased]' WHERE company_id = company AND id = ANY (offer_ids) AND conditions IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN counts := counts || jsonb_build_object('offers', n); END IF;

  UPDATE viewings
     SET feedback = CASE WHEN feedback IS NULL THEN NULL ELSE '[Erased]' END,
         cancelled_reason = CASE WHEN cancelled_reason IS NULL THEN NULL ELSE '[Erased]' END,
         meeting_point = CASE WHEN meeting_point IS NULL THEN NULL ELSE '[Erased]' END
   WHERE company_id = company AND id = ANY (viewing_ids)
     AND (feedback IS NOT NULL OR cancelled_reason IS NOT NULL OR meeting_point IS NOT NULL);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN counts := counts || jsonb_build_object('viewings', n); END IF;

  UPDATE sales_transactions SET fallen_through_reason = '[Erased]'
   WHERE company_id = company AND id = ANY (sale_ids) AND fallen_through_reason IS NOT NULL;

  RETURN counts || jsonb_build_object('touched', to_jsonb(deal_ids || offer_ids || viewing_ids || milestone_ids || sale_ids));
END;
$$;
REVOKE ALL ON FUNCTION app.erase_contact_sales(uuid, uuid[], uuid[]) FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- 8. app.erase_contact (E6) now also erases the sales pipeline's free text
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

-- -----------------------------------------------------------------------------
-- 9. Accountants read viewings and offers (specification §11.2: R (all))
-- -----------------------------------------------------------------------------
INSERT INTO role_permissions (role_id, permission_key, scope)
SELECT r.id, g.permission_key, 'all'
  FROM (VALUES ('viewing.view'), ('offer.view')) AS g (permission_key)
  JOIN roles r ON r.key = 'accountant' AND r.company_id IS NULL
ON CONFLICT DO NOTHING;
