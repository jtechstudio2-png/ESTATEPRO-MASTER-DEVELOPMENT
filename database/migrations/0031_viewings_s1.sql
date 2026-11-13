-- =============================================================================
-- EstatePro · Migration 0031 · Viewings (Phase 6 milestone S1)
-- =============================================================================
-- Booking and recording viewings (SAL-02, journey step 7; readiness report
-- §4.1). Migration 0030 already makes viewings final once finished, limits
-- the status moves and forbids deletes. This migration adds what booking and
-- recording need, enforced for every path:
--
--  1. Booking: a viewing is for a live listing (available, reserved or under
--     contract, not archived) and that listing's unit; the unit is not under
--     maintenance; a deal, when given, is open and for the same listing.
--  2. Recording: a viewing is completed or marked no-show only once it has
--     started.
--  3. Attendees: at least one, except for an open house (checked at commit,
--     so the viewing and its attendees are written in one transaction);
--     attendees of a finished viewing never change.
--  4. Rescheduling: the old viewing points at its replacement, written in the
--     same transaction (the link is checked at commit).
--  5. Keys: a key check-out may record the viewing it is for.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Booking rules
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.viewings_book_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  listing record;
  unit_availability text;
  deal record;
BEGIN
  SELECT unit_id, status, archived_at INTO listing FROM listings WHERE company_id = NEW.company_id AND id = NEW.listing_id;
  IF listing.status NOT IN ('available', 'reserved', 'under_contract') OR listing.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'viewings are booked on live listings' USING ERRCODE = 'check_violation', DETAIL = 'listing-not-live';
  END IF;
  IF listing.unit_id <> NEW.unit_id THEN
    RAISE EXCEPTION 'a viewing is of its listing''s unit' USING ERRCODE = 'check_violation', DETAIL = 'unit-mismatch';
  END IF;
  SELECT availability INTO unit_availability FROM units WHERE company_id = NEW.company_id AND id = NEW.unit_id;
  IF unit_availability = 'under_maintenance' THEN
    RAISE EXCEPTION 'the unit is under maintenance' USING ERRCODE = 'check_violation', DETAIL = 'unit-under-maintenance';
  END IF;
  IF NEW.deal_id IS NOT NULL THEN
    SELECT listing_id, status INTO deal FROM deals WHERE company_id = NEW.company_id AND id = NEW.deal_id;
    IF deal.status IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION 'viewings are booked on open deals' USING ERRCODE = 'check_violation', DETAIL = 'deal-closed';
    END IF;
    IF deal.listing_id IS NOT NULL AND deal.listing_id <> NEW.listing_id THEN
      RAISE EXCEPTION 'a deal''s viewings are of its listing' USING ERRCODE = 'check_violation', DETAIL = 'deal-listing-mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER viewings_book_guard BEFORE INSERT ON viewings FOR EACH ROW EXECUTE FUNCTION app.viewings_book_guard();

-- -----------------------------------------------------------------------------
-- 2. An outcome or a no-show is recorded once the viewing has started
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.viewings_timing_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('completed', 'no_show') AND OLD.status IN ('scheduled', 'confirmed') AND NEW.scheduled_start > now() THEN
    RAISE EXCEPTION 'a viewing is recorded once it has started' USING ERRCODE = 'check_violation', DETAIL = 'not-started';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER viewings_timing_guard BEFORE UPDATE OF status ON viewings FOR EACH ROW EXECUTE FUNCTION app.viewings_timing_guard();

-- -----------------------------------------------------------------------------
-- 3. Attendees
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.viewings_attendee_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v record;
BEGIN
  SELECT viewing_type INTO v FROM viewings WHERE company_id = NEW.company_id AND id = NEW.id;
  IF v.viewing_type IS NOT NULL AND v.viewing_type <> 'open_house'
     AND NOT EXISTS (SELECT 1 FROM viewing_attendees a WHERE a.company_id = NEW.company_id AND a.viewing_id = NEW.id) THEN
    RAISE EXCEPTION 'a viewing has at least one attendee, except an open house' USING ERRCODE = 'check_violation', DETAIL = 'attendee-required';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER viewings_attendee_check AFTER INSERT OR UPDATE OF viewing_type ON viewings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.viewings_attendee_check();

CREATE FUNCTION app.viewing_attendees_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  row_company uuid := coalesce(NEW.company_id, OLD.company_id);
  row_viewing uuid := coalesce(NEW.viewing_id, OLD.viewing_id);
  viewing_status text;
BEGIN
  SELECT status INTO viewing_status FROM viewings WHERE company_id = row_company AND id = row_viewing;
  IF viewing_status IN ('completed', 'cancelled', 'no_show', 'rescheduled') THEN
    RAISE EXCEPTION 'the attendees of a finished viewing are fixed' USING ERRCODE = 'check_violation', DETAIL = 'viewing-finished';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;  -- the viewing must keep an attendee: checked at commit (viewing_attendees_removed_check)
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.company_id, NEW.viewing_id, NEW.contact_id) IS DISTINCT FROM (OLD.company_id, OLD.viewing_id, OLD.contact_id) THEN
    RAISE EXCEPTION 'an attendee row keeps its viewing and contact' USING ERRCODE = 'check_violation', DETAIL = 'attendee-fixed';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER viewing_attendees_guard BEFORE INSERT OR UPDATE OR DELETE ON viewing_attendees
  FOR EACH ROW EXECUTE FUNCTION app.viewing_attendees_guard();

-- Removing attendees is checked at commit too: the viewing must keep one (except an open house).
CREATE FUNCTION app.viewing_attendees_removed_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v record;
BEGIN
  SELECT viewing_type INTO v FROM viewings WHERE company_id = OLD.company_id AND id = OLD.viewing_id;
  IF v.viewing_type IS NOT NULL AND v.viewing_type <> 'open_house'
     AND NOT EXISTS (SELECT 1 FROM viewing_attendees a WHERE a.company_id = OLD.company_id AND a.viewing_id = OLD.viewing_id) THEN
    RAISE EXCEPTION 'a viewing has at least one attendee, except an open house' USING ERRCODE = 'check_violation', DETAIL = 'attendee-required';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER viewing_attendees_removed_check AFTER DELETE ON viewing_attendees
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.viewing_attendees_removed_check();

-- -----------------------------------------------------------------------------
-- 4. Rescheduling: the replacement is written in the same transaction
-- -----------------------------------------------------------------------------
ALTER TABLE viewings ALTER CONSTRAINT viewings_company_id_rescheduled_to_id_fkey DEFERRABLE INITIALLY DEFERRED;

-- -----------------------------------------------------------------------------
-- 5. Key check-out for a viewing
-- -----------------------------------------------------------------------------
ALTER TABLE key_movements ADD COLUMN viewing_id uuid;
ALTER TABLE key_movements ADD CONSTRAINT key_movements_viewing_fkey FOREIGN KEY (company_id, viewing_id) REFERENCES viewings (company_id, id);
ALTER TABLE key_movements ADD CONSTRAINT key_movements_viewing_check CHECK (viewing_id IS NULL OR movement = 'check_out');
CREATE INDEX key_movements_viewing_idx ON key_movements (company_id, viewing_id) WHERE viewing_id IS NOT NULL;
COMMENT ON COLUMN key_movements.viewing_id IS 'The viewing a check-out is for (S1).';

-- -----------------------------------------------------------------------------
-- 6. Read paths: team calendar by time, and the "No viewing in 21 days" flag
-- -----------------------------------------------------------------------------
CREATE INDEX viewings_start_idx ON viewings (company_id, scheduled_start, id);
CREATE INDEX viewings_listing_recent_idx ON viewings (company_id, listing_id, scheduled_start DESC)
  WHERE status IN ('scheduled', 'confirmed', 'completed');
