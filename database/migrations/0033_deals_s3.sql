-- =============================================================================
-- EstatePro · Migration 0033 · Deals (Phase 6 milestone S3)
-- =============================================================================
-- Deals, lead conversion, milestones, exchange and completion (SAL-01,
-- SAL-04 to SAL-07, journey steps 6–11; readiness report §4.3, §4.4, §5;
-- P6-D2, P6-D5 to P6-D8, P6-D11). Migrations 0007, 0030 and 0032 already
-- write stage history, keep closed deals final, guard sales records and tie
-- offers to the deal stage. This migration adds, for every path:
--
--  1. Stage moves follow the deal life cycle (§4.3). A deal starts before
--     "offer accepted". Letting deals stop at "terms agreed" until leases
--     exist (P6-D2, Phase 7).
--  2. A sale deal reaches contract only with every buyer's identity verified
--     where the jurisdiction rule sales_kyc_required applies (P6-D6), and is
--     won only with its required milestones complete (P6-D7).
--  3. The deal stage and its sales record agree (checked at commit):
--     contract = contracts exchanged, won = completed, a fallen-through sale
--     = a lost deal.
--  4. Co-agent splits add up to 100 % (checked at commit); a closed deal's
--     agents and milestones do not change.
--  5. Owner (responsible agent) changes are history written by the database,
--     like stage changes (SAL-05).
--  6. A listing whose sale has exchanged contracts is not withdrawn by hand:
--     the sale falls through on the deal first.
--  7. Where a deal came from (lead source), and indexes for the pipeline
--     board, the stalled flag, the forecast and the deal list.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Stage moves follow the life cycle
-- -----------------------------------------------------------------------------
-- Moves within a class are allowed (a company may have several stages of one
-- class). Automatic moves are included: a booked viewing (lead or
-- qualification → viewing), a recorded offer (→ negotiation), accepting and
-- withdrawing an accepted offer, exchange, completion and losing a deal.
CREATE FUNCTION app.deal_stage_change_allowed(from_class text, to_class text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT from_class = to_class OR CASE from_class
    WHEN 'lead'           THEN to_class IN ('qualification', 'viewing', 'negotiation', 'closed_lost')
    WHEN 'qualification'  THEN to_class IN ('viewing', 'negotiation', 'closed_lost')
    WHEN 'viewing'        THEN to_class IN ('qualification', 'negotiation', 'closed_lost')
    WHEN 'negotiation'    THEN to_class IN ('offer_accepted', 'closed_lost')
    WHEN 'offer_accepted' THEN to_class IN ('negotiation', 'contract', 'closed_lost')
    WHEN 'contract'       THEN to_class IN ('closed_won', 'closed_lost')
    ELSE false
  END
$$;

-- Whether a contact's identity is verified now: the latest check of the type
-- that applies (identity for a person, company ownership for an organisation)
-- is verified and not past its expiry date; erased contacts never are. The
-- same reading as the API (properties/owner-identity.ts, H-D3).
CREATE FUNCTION app.contact_identity_verified(p_company uuid, p_contact uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce((
    SELECT NOT c.is_anonymised AND latest.status = 'verified' AND (latest.expires_on IS NULL OR latest.expires_on >= current_date)
      FROM contacts c
      LEFT JOIN LATERAL (
        SELECT k.status, k.expires_on FROM kyc_checks k
         WHERE k.company_id = c.company_id AND k.contact_id = c.id
           AND k.check_type = CASE c.contact_type WHEN 'organisation' THEN 'company_ownership' ELSE 'identity' END
         ORDER BY k.created_at DESC, k.entry_no DESC
         LIMIT 1) latest ON true
     WHERE c.company_id = p_company AND c.id = p_contact), false)
$$;

-- The buyer side of a deal: its primary contact and its buyer or tenant parties.
CREATE FUNCTION app.deal_buyer_contacts(p_company uuid, p_deal uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE AS $$
  SELECT d.primary_contact_id FROM deals d WHERE d.company_id = p_company AND d.id = p_deal
  UNION
  SELECT p.contact_id FROM deal_parties p
   WHERE p.company_id = p_company AND p.deal_id = p_deal AND p.party_role IN ('buyer', 'tenant')
$$;

-- Whether a sale deal needs verified buyers before contracts (P6-D6): the
-- jurisdiction rule sales_kyc_required of the deal's property (default on).
CREATE FUNCTION app.deal_identity_required(p_company uuid, p_deal uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce((
    SELECT d.deal_type = 'sale'
           AND coalesce(app.jurisdiction_rule(pr.jurisdiction_code, 'sales_kyc_required', current_date)::text, 'true') = 'true'
      FROM deals d
      JOIN units u ON u.company_id = d.company_id AND u.id = d.unit_id
      JOIN properties pr ON pr.company_id = u.company_id AND pr.id = u.property_id
     WHERE d.company_id = p_company AND d.id = p_deal), true)
$$;

CREATE FUNCTION app.deals_stage_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  from_class text;
  to_class text;
BEGIN
  SELECT stage_class INTO to_class FROM pipeline_stages WHERE id = NEW.stage_id;
  IF TG_OP = 'INSERT' THEN
    IF to_class NOT IN ('lead', 'qualification', 'viewing', 'negotiation') THEN
      RAISE EXCEPTION 'a deal starts at a stage before "offer accepted"' USING ERRCODE = 'check_violation', DETAIL = 'start-stage';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.stage_id IS NOT DISTINCT FROM OLD.stage_id THEN
    RETURN NEW;
  END IF;
  SELECT stage_class INTO from_class FROM pipeline_stages WHERE id = OLD.stage_id;
  IF NOT app.deal_stage_change_allowed(from_class, to_class) THEN
    RAISE EXCEPTION 'a deal cannot move from % to %', from_class, to_class USING ERRCODE = 'check_violation', DETAIL = 'stage-change';
  END IF;
  IF NEW.deal_type = 'letting' AND to_class IN ('contract', 'closed_won') THEN
    RAISE EXCEPTION 'letting deals stop at "terms agreed" until leases are available (P6-D2)'
      USING ERRCODE = 'check_violation', DETAIL = 'letting-terms-agreed';
  END IF;
  IF to_class = 'contract' AND app.deal_identity_required(NEW.company_id, NEW.id)
     AND EXISTS (SELECT 1 FROM app.deal_buyer_contacts(NEW.company_id, NEW.id) AS b(contact_id)
                  WHERE NOT app.contact_identity_verified(NEW.company_id, b.contact_id)) THEN
    RAISE EXCEPTION 'every buyer''s identity is verified before contracts are exchanged (P6-D6)'
      USING ERRCODE = 'check_violation', DETAIL = 'buyer-identity-unverified';
  END IF;
  IF to_class = 'closed_won' AND EXISTS (
       SELECT 1 FROM deal_milestones m
        WHERE m.company_id = NEW.company_id AND m.deal_id = NEW.id AND m.is_required AND m.completed_at IS NULL) THEN
    RAISE EXCEPTION 'a deal is completed once its required milestones are done (P6-D7)'
      USING ERRCODE = 'check_violation', DETAIL = 'milestones-incomplete';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER deals_stage_rules BEFORE INSERT OR UPDATE OF stage_id ON deals
  FOR EACH ROW EXECUTE FUNCTION app.deals_stage_rules();

-- -----------------------------------------------------------------------------
-- 3. The deal stage and its sales record agree (checked at commit)
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.deal_sale_agreement(p_company uuid, p_deal uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  deal record;
  sale_status text;
BEGIN
  SELECT stage_class, deal_type INTO deal FROM deals WHERE company_id = p_company AND id = p_deal;
  SELECT status INTO sale_status FROM sales_transactions WHERE company_id = p_company AND deal_id = p_deal;
  IF deal.deal_type = 'sale' AND deal.stage_class = 'contract' AND sale_status IS DISTINCT FROM 'exchanged' THEN
    RAISE EXCEPTION 'a sale deal is at contract stage while its contracts are exchanged'
      USING ERRCODE = 'check_violation', DETAIL = 'contract-stage';
  END IF;
  IF deal.deal_type = 'sale' AND deal.stage_class = 'closed_won' AND sale_status IS DISTINCT FROM 'completed' THEN
    RAISE EXCEPTION 'a sale deal is won when its sale is completed' USING ERRCODE = 'check_violation', DETAIL = 'won-stage';
  END IF;
  IF (sale_status = 'pending' AND deal.stage_class <> 'offer_accepted')
     OR (sale_status = 'exchanged' AND deal.stage_class <> 'contract')
     OR (sale_status = 'completed' AND deal.stage_class <> 'closed_won')
     OR (sale_status = 'fallen_through' AND deal.stage_class <> 'closed_lost') THEN
    RAISE EXCEPTION 'the sale of deal % is % but the deal is at %', p_deal, sale_status, deal.stage_class
      USING ERRCODE = 'check_violation', DETAIL = 'sale-stage';
  END IF;
END;
$$;

CREATE FUNCTION app.deals_sale_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.deal_sale_agreement(NEW.company_id, NEW.id);
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER deals_sale_check AFTER UPDATE OF stage_id ON deals
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.deals_sale_check();

CREATE FUNCTION app.sales_transactions_deal_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.deal_sale_agreement(NEW.company_id, NEW.deal_id);
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER sales_transactions_deal_check AFTER INSERT OR UPDATE OF status ON sales_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.sales_transactions_deal_check();

-- -----------------------------------------------------------------------------
-- 4. Agents and splits; closed deals keep their agents and milestones
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.deal_agent_splits(p_company uuid, p_deal uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  n bigint;
  total numeric;
BEGIN
  SELECT count(*), coalesce(sum(split_percent), 0) INTO n, total FROM deal_agents WHERE company_id = p_company AND deal_id = p_deal;
  IF n > 0 AND total <> 100 THEN
    RAISE EXCEPTION 'the agents'' splits on deal % add up to % %%, not 100 %%', p_deal, total
      USING ERRCODE = 'check_violation', DETAIL = 'splits-total';
  END IF;
END;
$$;

CREATE FUNCTION app.deal_agents_splits_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM app.deal_agent_splits(OLD.company_id, OLD.deal_id);
  ELSE
    PERFORM app.deal_agent_splits(NEW.company_id, NEW.deal_id);
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER deal_agents_splits_check AFTER INSERT OR UPDATE OR DELETE ON deal_agents
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.deal_agents_splits_check();

CREATE FUNCTION app.deal_open_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  company uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.company_id ELSE NEW.company_id END;
  deal uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.deal_id ELSE NEW.deal_id END;
BEGIN
  IF app.erasure_in_progress() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF EXISTS (SELECT 1 FROM deals d WHERE d.company_id = company AND d.id = deal AND d.stage_class IN ('closed_won', 'closed_lost')) THEN
    RAISE EXCEPTION 'deal % is closed: its % do not change', deal, replace(TG_TABLE_NAME, 'deal_', '')
      USING ERRCODE = 'check_violation', DETAIL = 'deal-closed';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER deal_agents_open_guard BEFORE INSERT OR UPDATE OR DELETE ON deal_agents
  FOR EACH ROW EXECUTE FUNCTION app.deal_open_guard();
CREATE TRIGGER deal_milestones_open_guard BEFORE INSERT OR UPDATE ON deal_milestones
  FOR EACH ROW EXECUTE FUNCTION app.deal_open_guard();

CREATE INDEX deal_agents_membership_idx ON deal_agents (company_id, membership_id, deal_id);

-- -----------------------------------------------------------------------------
-- 5. Owner changes are history written by the database (SAL-05)
-- -----------------------------------------------------------------------------
CREATE TABLE deal_assignments (
  id                  uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id          uuid         NOT NULL,
  deal_id             uuid         NOT NULL,
  from_membership_id  uuid,
  to_membership_id    uuid         NOT NULL,
  assigned_by         uuid,
  assigned_at         timestamptz  NOT NULL DEFAULT now(),
  note                text         CHECK (char_length(note) <= 1000),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, deal_id) REFERENCES deals (company_id, id),
  FOREIGN KEY (company_id, from_membership_id) REFERENCES company_memberships (company_id, id),
  FOREIGN KEY (company_id, to_membership_id) REFERENCES company_memberships (company_id, id),
  FOREIGN KEY (company_id, assigned_by) REFERENCES company_memberships (company_id, id)
);
CREATE SEQUENCE deal_assignments_entry_no_seq;
ALTER TABLE deal_assignments ADD COLUMN entry_no bigint NOT NULL DEFAULT nextval('deal_assignments_entry_no_seq');
ALTER SEQUENCE deal_assignments_entry_no_seq OWNED BY deal_assignments.entry_no;
COMMENT ON COLUMN deal_assignments.entry_no IS
  'Insertion order (#15): breaks ties between rows written at the same time, so this history never reorders.';
CREATE UNIQUE INDEX deal_assignments_entry_no_idx ON deal_assignments (entry_no);
CREATE INDEX deal_assignments_deal_idx ON deal_assignments (company_id, deal_id, assigned_at, entry_no);
CREATE INDEX deal_assignments_from_fk_idx ON deal_assignments (company_id, from_membership_id) WHERE from_membership_id IS NOT NULL;
CREATE INDEX deal_assignments_to_fk_idx ON deal_assignments (company_id, to_membership_id);
CREATE INDEX deal_assignments_by_fk_idx ON deal_assignments (company_id, assigned_by) WHERE assigned_by IS NOT NULL;

ALTER TABLE deal_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON deal_assignments FOR ALL TO estatepro_app
  USING (company_id = app.current_company_id()) WITH CHECK (company_id = app.current_company_id());
GRANT SELECT ON deal_assignments TO estatepro_app, estatepro_platform;

CREATE TRIGGER deal_assignments_entry_no_fixed BEFORE UPDATE OF entry_no ON deal_assignments FOR EACH ROW
  WHEN (OLD.entry_no IS DISTINCT FROM NEW.entry_no) EXECUTE FUNCTION app.entry_no_fixed();
CREATE TRIGGER deal_assignments_append_only BEFORE UPDATE OR DELETE ON deal_assignments
  FOR EACH ROW EXECUTE FUNCTION app.history_erasure_guard('note');

-- The note (app.assignment_note) belongs to one change and is cleared after use, like app.stage_note.
CREATE FUNCTION app.deals_record_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO deal_assignments (company_id, deal_id, from_membership_id, to_membership_id, assigned_by, note)
  VALUES (NEW.company_id, NEW.id,
          CASE WHEN TG_OP = 'UPDATE' THEN OLD.owner_membership_id END,
          NEW.owner_membership_id,
          (SELECT m.id FROM company_memberships m
            WHERE m.company_id = NEW.company_id AND m.user_id = app.current_user_id()
            ORDER BY m.created_at LIMIT 1),
          nullif(current_setting('app.assignment_note', true), ''));
  PERFORM set_config('app.assignment_note', '', true);
  RETURN NULL;
END;
$$;
CREATE TRIGGER deals_record_owner_insert AFTER INSERT ON deals
  FOR EACH ROW EXECUTE FUNCTION app.deals_record_owner();
CREATE TRIGGER deals_record_owner_update AFTER UPDATE OF owner_membership_id ON deals
  FOR EACH ROW WHEN (OLD.owner_membership_id IS DISTINCT FROM NEW.owner_membership_id) EXECUTE FUNCTION app.deals_record_owner();

-- A closed deal keeps its owner too (closed deals are final, S-D7).
CREATE FUNCTION app.deals_closed_owner_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.stage_class IN ('closed_won', 'closed_lost') AND NEW.owner_membership_id IS DISTINCT FROM OLD.owner_membership_id THEN
    RAISE EXCEPTION 'deal % is closed and keeps its owner', OLD.id USING ERRCODE = 'check_violation', DETAIL = 'deal-closed';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER deals_closed_owner_guard BEFORE UPDATE OF owner_membership_id ON deals
  FOR EACH ROW EXECUTE FUNCTION app.deals_closed_owner_guard();

-- Existing deals (tests only before S3) get their first owner entry.
INSERT INTO deal_assignments (company_id, deal_id, to_membership_id, assigned_at)
SELECT company_id, id, owner_membership_id, created_at FROM deals ORDER BY created_at, id;

-- Erasure anonymises assignment notes with the rest of the deal's free text (ADR-008 §3).
CREATE OR REPLACE FUNCTION app.erase_contact_sales(company uuid, subjects uuid[], lead_ids uuid[]) RETURNS jsonb
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
  UPDATE deal_assignments SET note = '[Erased]' WHERE company_id = company AND deal_id = ANY (deal_ids) AND note IS NOT NULL;
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
-- 6. A listing whose sale has exchanged contracts is not withdrawn by hand
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.listings_offer_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND coalesce(current_setting('app.pipeline_action', true), '') <> 'on' THEN
    IF NEW.status = 'withdrawn' AND EXISTS (
         SELECT 1 FROM sales_transactions t WHERE t.company_id = NEW.company_id AND t.listing_id = NEW.id AND t.status = 'exchanged') THEN
      RAISE EXCEPTION 'contracts are exchanged on this listing: the sale falls through on its deal first'
        USING ERRCODE = 'check_violation', DETAIL = 'listing-sale-exchanged';
    END IF;
    IF NEW.status <> 'withdrawn'
       AND EXISTS (SELECT 1 FROM offers o WHERE o.company_id = NEW.company_id AND o.listing_id = NEW.id AND o.status = 'accepted') THEN
      RAISE EXCEPTION 'a listing with an accepted offer changes status through its deal'
        USING ERRCODE = 'check_violation', DETAIL = 'listing-has-accepted-offer';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- 7. Source, free-text limits and indexes
-- -----------------------------------------------------------------------------
ALTER TABLE deals
  ADD COLUMN source_code text CHECK (source_code IS NULL OR source_code ~ '^[a-z][a-z0-9_]*$'),
  ADD CONSTRAINT deals_lost_notes_length CHECK (char_length(lost_notes) <= 2000);
COMMENT ON COLUMN deals.source_code IS 'Where the deal came from (picklist lead_source), carried over from its lead on conversion (§4.4).';
ALTER TABLE deal_milestones ADD CONSTRAINT deal_milestones_notes_length CHECK (char_length(notes) <= 2000);
ALTER TABLE sales_transactions ADD CONSTRAINT sales_transactions_reason_length CHECK (char_length(fallen_through_reason) <= 2000);

-- Pipeline board and stalled flag (stage, time in stage); deal list (newest change first).
CREATE INDEX deals_stage_entered_idx ON deals (company_id, stage_id, stage_entered_at)
  WHERE stage_class NOT IN ('closed_won', 'closed_lost') AND archived_at IS NULL;
CREATE INDEX deals_updated_idx ON deals (company_id, updated_at DESC, id DESC);
CREATE INDEX deals_owner_idx ON deals (company_id, owner_membership_id, updated_at DESC);
