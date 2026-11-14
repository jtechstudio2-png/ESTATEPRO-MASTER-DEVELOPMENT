-- =============================================================================
-- EstatePro · Migration 0032 · Offers (Phase 6 milestone S2)
-- =============================================================================
-- Recording and answering offers (SAL-03, journey steps 8–9; readiness report
-- §4.2, §4.3 and §5). Migration 0030 already makes offer terms immutable,
-- limits the status moves, checks the counter-offer chain and forbids
-- deletes; migration 0007 allows one accepted offer per listing. This
-- migration ties offers to their deal and listing, for every path:
--
--  1. A deal is at "offer accepted" only while one of its offers is
--     accepted, and an accepted offer's deal is at "offer accepted" or later
--     (checked at commit, so the offer and the deal change together).
--  2. An offer is accepted only while its listing is available or reserved.
--  3. A listing with an accepted offer changes status only through the
--     pipeline (P6-D5): accepting reserves it, withdrawing the accepted offer
--     makes it available again; a manual change is refused, except
--     withdrawing the listing (the accepted offer is then withdrawn too).
--  4. Offers past their expiry time are found by an index (worker job).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Deal stage and accepted offers agree (checked at commit)
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.deal_offer_agreement(p_company uuid, p_deal uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  stage text;
  accepted boolean;
BEGIN
  SELECT stage_class INTO stage FROM deals WHERE company_id = p_company AND id = p_deal;
  SELECT EXISTS (SELECT 1 FROM offers WHERE company_id = p_company AND deal_id = p_deal AND status = 'accepted') INTO accepted;
  IF stage = 'offer_accepted' AND NOT accepted THEN
    RAISE EXCEPTION 'a deal is at "offer accepted" only while one of its offers is accepted'
      USING ERRCODE = 'check_violation', DETAIL = 'offer-accepted-stage';
  END IF;
  IF accepted AND stage NOT IN ('offer_accepted', 'contract', 'closed_won') THEN
    RAISE EXCEPTION 'a deal with an accepted offer is at "offer accepted" or later'
      USING ERRCODE = 'check_violation', DETAIL = 'accepted-offer-stage';
  END IF;
END;
$$;

CREATE FUNCTION app.deals_offer_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.deal_offer_agreement(NEW.company_id, NEW.id);
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER deals_offer_check AFTER INSERT OR UPDATE OF stage_id ON deals
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.deals_offer_check();

CREATE FUNCTION app.offers_deal_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM app.deal_offer_agreement(NEW.company_id, NEW.deal_id);
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER offers_deal_check AFTER INSERT OR UPDATE OF status ON offers
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.offers_deal_check();

-- -----------------------------------------------------------------------------
-- 2. An offer is accepted while its listing is on the market
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.offers_accept_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  listing_status text;
BEGIN
  IF NEW.status = 'accepted' AND OLD.status IS DISTINCT FROM 'accepted' THEN
    SELECT status INTO listing_status FROM listings WHERE company_id = NEW.company_id AND id = NEW.listing_id;
    IF listing_status NOT IN ('available', 'reserved') THEN
      RAISE EXCEPTION 'an offer is accepted while its listing is available or reserved'
        USING ERRCODE = 'check_violation', DETAIL = 'listing-not-available';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER offers_accept_guard BEFORE UPDATE OF status ON offers FOR EACH ROW EXECUTE FUNCTION app.offers_accept_guard();

-- -----------------------------------------------------------------------------
-- 3. A listing with an accepted offer moves only through the pipeline (P6-D5)
-- -----------------------------------------------------------------------------
-- The pipeline actions set app.pipeline_action for their own transaction. The
-- flag marks the application's own offer and deal actions; it guards against
-- a manual status change slipping past them, not against the application.
CREATE FUNCTION app.listings_offer_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'withdrawn'
     AND coalesce(current_setting('app.pipeline_action', true), '') <> 'on'
     AND EXISTS (SELECT 1 FROM offers o WHERE o.company_id = NEW.company_id AND o.listing_id = NEW.id AND o.status = 'accepted') THEN
    RAISE EXCEPTION 'a listing with an accepted offer changes status through its deal'
      USING ERRCODE = 'check_violation', DETAIL = 'listing-has-accepted-offer';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER listings_offer_guard BEFORE UPDATE OF status ON listings FOR EACH ROW EXECUTE FUNCTION app.listings_offer_guard();

-- -----------------------------------------------------------------------------
-- 4. Expiry (worker job offer.expire) and open offers per listing
-- -----------------------------------------------------------------------------
CREATE INDEX offers_expiry_idx ON offers (expires_at) WHERE status = 'submitted' AND expires_at IS NOT NULL;
CREATE INDEX offers_submitted_idx ON offers (company_id, submitted_at DESC, id DESC);
