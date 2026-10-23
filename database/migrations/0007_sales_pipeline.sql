-- =============================================================================
-- EstatePro · Migration 0007 · Viewings, deals, offers, milestones and sales
-- =============================================================================
-- Pipeline stages are configurable per company, but each stage maps to a fixed
-- stage_class that the system logic understands. Companies rename, reorder or
-- add stages without breaking forecasting or reporting.
-- =============================================================================

CREATE TABLE pipeline_stages (
  id                   uuid          PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id           uuid          REFERENCES companies (id),     -- NULL = platform default
  deal_type            text          NOT NULL CHECK (deal_type IN ('sale', 'letting')),
  stage_class          text          NOT NULL
                         CHECK (stage_class IN ('lead', 'qualification', 'viewing', 'negotiation',
                                                'offer_accepted', 'contract', 'closed_won', 'closed_lost')),
  code                 text          NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  name                 text          NOT NULL,
  sort_order           smallint      NOT NULL,
  default_probability  numeric(5,2)  NOT NULL CHECK (default_probability BETWEEN 0 AND 100),
  stall_after_days     smallint      CHECK (stall_after_days > 0),   -- flag deals idle longer than this
  is_active            boolean       NOT NULL DEFAULT true,
  created_at           timestamptz   NOT NULL DEFAULT now(),
  updated_at           timestamptz   NOT NULL DEFAULT now(),
  version              integer       NOT NULL DEFAULT 1,
  UNIQUE NULLS NOT DISTINCT (company_id, deal_type, code),
  CHECK (stage_class <> 'closed_won' OR default_probability = 100),
  CHECK (stage_class <> 'closed_lost' OR default_probability = 0)
);

-- Progression steps after an offer is accepted, per jurisdiction and deal type
-- (e.g. KYC complete, deposit received, contract exchanged, title transfer
-- registered). Copied onto each deal as deal_milestones.
CREATE TABLE milestone_templates (
  id                 uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id         uuid         REFERENCES companies (id),
  jurisdiction_code  text         REFERENCES jurisdictions (code),     -- NULL = any jurisdiction
  deal_type          text         NOT NULL CHECK (deal_type IN ('sale', 'letting')),
  code               text         NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  name               text         NOT NULL,
  sort_order         smallint     NOT NULL,
  is_required        boolean      NOT NULL DEFAULT true,
  due_offset_days    smallint,    -- days after offer acceptance
  is_active          boolean      NOT NULL DEFAULT true,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (company_id, jurisdiction_code, deal_type, code)
);

CREATE TABLE deals (
  id                    uuid           PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id            uuid           NOT NULL,
  reference             text           NOT NULL,
  deal_type             text           NOT NULL CHECK (deal_type IN ('sale', 'letting')),
  stage_id              uuid           NOT NULL REFERENCES pipeline_stages (id),
  stage_class           text           NOT NULL,     -- copied from stage for constraints and fast filters
  status                text           NOT NULL GENERATED ALWAYS AS (
                                         CASE stage_class WHEN 'closed_won' THEN 'won'
                                                          WHEN 'closed_lost' THEN 'lost'
                                                          ELSE 'open' END) STORED,
  listing_id            uuid,
  unit_id               uuid,
  lead_id               uuid,
  primary_contact_id    uuid           NOT NULL,    -- buyer / tenant applicant
  office_id             uuid           NOT NULL,
  owner_membership_id   uuid           NOT NULL,
  currency_code         char(3)        NOT NULL REFERENCES currencies (code),
  expected_value        numeric(19,4)  CHECK (expected_value >= 0),     -- expected price / annual rent
  expected_fee          numeric(19,4)  CHECK (expected_fee >= 0),       -- expected agency income
  probability_override  numeric(5,2)   CHECK (probability_override BETWEEN 0 AND 100),
  expected_close_date   date,
  stage_entered_at      timestamptz    NOT NULL DEFAULT now(),
  closed_at             timestamptz,
  lost_reason_code      text,
  lost_notes            text,
  custom_fields         jsonb          NOT NULL DEFAULT '{}'::jsonb,
  archived_at           timestamptz,
  created_by            uuid,
  created_at            timestamptz    NOT NULL DEFAULT now(),
  updated_at            timestamptz    NOT NULL DEFAULT now(),
  version               integer        NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  UNIQUE (company_id, reference),
  FOREIGN KEY (company_id, listing_id) REFERENCES listings (company_id, id),
  FOREIGN KEY (company_id, unit_id) REFERENCES units (company_id, id),
  FOREIGN KEY (company_id, lead_id) REFERENCES leads (company_id, id),
  FOREIGN KEY (company_id, primary_contact_id) REFERENCES contacts (company_id, id),
  FOREIGN KEY (company_id, office_id) REFERENCES offices (company_id, id),
  FOREIGN KEY (company_id, owner_membership_id) REFERENCES company_memberships (company_id, id),
  CHECK (stage_class IN ('lead', 'qualification', 'viewing', 'negotiation', 'offer_accepted', 'contract', 'closed_won', 'closed_lost')),
  CHECK ((stage_class IN ('closed_won', 'closed_lost')) = (closed_at IS NOT NULL)),
  CHECK (stage_class <> 'closed_lost' OR lost_reason_code IS NOT NULL),
  CHECK (stage_class NOT IN ('offer_accepted', 'contract', 'closed_won') OR listing_id IS NOT NULL OR unit_id IS NOT NULL)
);
CREATE INDEX deals_pipeline_idx ON deals (company_id, deal_type, stage_class, owner_membership_id) WHERE archived_at IS NULL;
CREATE INDEX deals_forecast_idx ON deals (company_id, expected_close_date) WHERE stage_class NOT IN ('closed_won', 'closed_lost');
CREATE INDEX deals_listing_idx ON deals (company_id, listing_id);
CREATE INDEX deals_contact_idx ON deals (company_id, primary_contact_id);

-- Keep deals.stage_class in step with the chosen stage.
CREATE OR REPLACE FUNCTION app.deals_sync_stage_class() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE
  stage_deal_type text;
BEGIN
  SELECT stage_class, deal_type INTO NEW.stage_class, stage_deal_type FROM pipeline_stages WHERE id = NEW.stage_id;
  IF stage_deal_type IS DISTINCT FROM NEW.deal_type THEN
    RAISE EXCEPTION 'pipeline stage % is not a % stage', NEW.stage_id, NEW.deal_type
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    NEW.stage_entered_at := now();
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER deals_sync_stage_class BEFORE INSERT OR UPDATE OF stage_id ON deals
  FOR EACH ROW EXECUTE FUNCTION app.deals_sync_stage_class();

ALTER TABLE leads ADD FOREIGN KEY (company_id, listing_id) REFERENCES listings (company_id, id);
ALTER TABLE leads ADD FOREIGN KEY (company_id, converted_deal_id) REFERENCES deals (company_id, id);
ALTER TABLE kyc_checks ADD FOREIGN KEY (company_id, deal_id) REFERENCES deals (company_id, id);

CREATE TABLE deal_stage_history (
  id             uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id     uuid         NOT NULL,
  deal_id        uuid         NOT NULL,
  from_stage_id  uuid,
  to_stage_id    uuid         NOT NULL,
  changed_at     timestamptz  NOT NULL DEFAULT now(),
  changed_by     uuid,
  note           text,
  FOREIGN KEY (company_id, deal_id) REFERENCES deals (company_id, id) ON DELETE CASCADE
);
CREATE INDEX deal_stage_history_idx ON deal_stage_history (company_id, deal_id, changed_at);

CREATE TABLE deal_parties (
  company_id   uuid     NOT NULL,
  deal_id      uuid     NOT NULL,
  contact_id   uuid     NOT NULL,
  party_role   text     NOT NULL CHECK (party_role IN ('buyer', 'seller', 'tenant', 'landlord', 'guarantor',
                                                       'buyer_lawyer', 'seller_lawyer', 'lender', 'other_agent', 'other')),
  is_primary   boolean  NOT NULL DEFAULT false,
  PRIMARY KEY (company_id, deal_id, contact_id, party_role),
  FOREIGN KEY (company_id, deal_id) REFERENCES deals (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts (company_id, id)
);
CREATE INDEX deal_parties_contact_idx ON deal_parties (company_id, contact_id);

-- Agents credited on a deal and their share of the commission.
CREATE TABLE deal_agents (
  company_id     uuid          NOT NULL,
  deal_id        uuid          NOT NULL,
  membership_id  uuid          NOT NULL,
  agent_role     text          NOT NULL CHECK (agent_role IN ('lister', 'seller_agent', 'co_agent', 'referrer')),
  split_percent  numeric(7,4)  NOT NULL CHECK (split_percent >= 0 AND split_percent <= 100),
  PRIMARY KEY (company_id, deal_id, membership_id, agent_role),
  FOREIGN KEY (company_id, deal_id) REFERENCES deals (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, membership_id) REFERENCES company_memberships (company_id, id)
);

CREATE TABLE viewings (
  id                     uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id             uuid         NOT NULL,
  listing_id             uuid         NOT NULL,
  unit_id                uuid         NOT NULL,
  lead_id                uuid,
  deal_id                uuid,
  agent_membership_id    uuid         NOT NULL,
  viewing_type           text         NOT NULL DEFAULT 'in_person' CHECK (viewing_type IN ('in_person', 'virtual', 'open_house')),
  scheduled_start        timestamptz  NOT NULL,
  scheduled_end          timestamptz  NOT NULL,
  timezone               text         NOT NULL,    -- property timezone, for confirmations
  status                 text         NOT NULL DEFAULT 'scheduled'
                           CHECK (status IN ('scheduled', 'confirmed', 'completed', 'cancelled', 'no_show', 'rescheduled')),
  outcome                text         CHECK (outcome IN ('interested', 'not_interested', 'second_viewing', 'offer_expected', 'offer_made')),
  feedback               text,
  seller_feedback_shared boolean      NOT NULL DEFAULT false,
  cancelled_reason       text,
  rescheduled_to_id      uuid,
  meeting_point          text,
  created_by             uuid,
  created_at             timestamptz  NOT NULL DEFAULT now(),
  updated_at             timestamptz  NOT NULL DEFAULT now(),
  version                integer      NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, listing_id) REFERENCES listings (company_id, id),
  FOREIGN KEY (company_id, unit_id) REFERENCES units (company_id, id),
  FOREIGN KEY (company_id, lead_id) REFERENCES leads (company_id, id),
  FOREIGN KEY (company_id, deal_id) REFERENCES deals (company_id, id),
  FOREIGN KEY (company_id, agent_membership_id) REFERENCES company_memberships (company_id, id),
  FOREIGN KEY (company_id, rescheduled_to_id) REFERENCES viewings (company_id, id),
  CHECK (scheduled_end > scheduled_start),
  CHECK (status <> 'completed' OR outcome IS NOT NULL),
  -- An agent cannot be booked into two overlapping live viewings.
  EXCLUDE USING gist (company_id WITH =, agent_membership_id WITH =,
                      tstzrange(scheduled_start, scheduled_end) WITH &&)
    WHERE (status IN ('scheduled', 'confirmed'))
);
CREATE INDEX viewings_calendar_idx ON viewings (company_id, agent_membership_id, scheduled_start);
CREATE INDEX viewings_listing_idx ON viewings (company_id, listing_id, scheduled_start);
CREATE INDEX viewings_feedback_due_idx ON viewings (company_id, scheduled_end)
  WHERE status IN ('scheduled', 'confirmed');

CREATE TABLE viewing_attendees (
  company_id   uuid  NOT NULL,
  viewing_id   uuid  NOT NULL,
  contact_id   uuid  NOT NULL,
  attendance   text  NOT NULL DEFAULT 'expected' CHECK (attendance IN ('expected', 'attended', 'absent')),
  PRIMARY KEY (company_id, viewing_id, contact_id),
  FOREIGN KEY (company_id, viewing_id) REFERENCES viewings (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts (company_id, id)
);

-- Offers are an immutable negotiation record: amounts are never edited; a
-- counter-offer is a new row pointing to the previous one.
CREATE TABLE offers (
  id                  uuid           PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id          uuid           NOT NULL,
  deal_id             uuid           NOT NULL,
  listing_id          uuid           NOT NULL,
  offered_by_contact_id uuid         NOT NULL,
  direction           text           NOT NULL CHECK (direction IN ('from_buyer', 'from_seller')),
  parent_offer_id     uuid,
  currency_code       char(3)        NOT NULL REFERENCES currencies (code),
  amount              numeric(19,4)  NOT NULL CHECK (amount > 0),
  rent_frequency      text           CHECK (rent_frequency IN ('weekly', 'monthly', 'quarterly', 'semi_annual', 'annual')),
  conditions          text,
  financing_code      text,          -- picklist: cash, mortgage, part_exchange, developer_plan
  status              text           NOT NULL DEFAULT 'submitted'
                        CHECK (status IN ('submitted', 'countered', 'accepted', 'rejected', 'withdrawn', 'expired')),
  submitted_at        timestamptz    NOT NULL DEFAULT now(),
  expires_at          timestamptz,
  responded_at        timestamptz,
  recorded_by         uuid           NOT NULL,
  created_at          timestamptz    NOT NULL DEFAULT now(),
  updated_at          timestamptz    NOT NULL DEFAULT now(),
  version             integer        NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, deal_id) REFERENCES deals (company_id, id),
  FOREIGN KEY (company_id, listing_id) REFERENCES listings (company_id, id),
  FOREIGN KEY (company_id, offered_by_contact_id) REFERENCES contacts (company_id, id),
  FOREIGN KEY (company_id, parent_offer_id) REFERENCES offers (company_id, id),
  FOREIGN KEY (company_id, recorded_by) REFERENCES company_memberships (company_id, id),
  CHECK (status = 'submitted' OR responded_at IS NOT NULL)
);
CREATE INDEX offers_deal_idx ON offers (company_id, deal_id, submitted_at);
CREATE INDEX offers_listing_idx ON offers (company_id, listing_id, status);
-- Only one accepted offer per listing at a time.
CREATE UNIQUE INDEX offers_one_accepted_idx ON offers (company_id, listing_id) WHERE status = 'accepted';

CREATE OR REPLACE FUNCTION app.offers_protect_terms() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.amount, NEW.currency_code, NEW.conditions, NEW.deal_id, NEW.offered_by_contact_id, NEW.submitted_at)
     IS DISTINCT FROM
     (OLD.amount, OLD.currency_code, OLD.conditions, OLD.deal_id, OLD.offered_by_contact_id, OLD.submitted_at) THEN
    RAISE EXCEPTION 'offer terms are immutable; record a counter-offer instead'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER offers_protect_terms BEFORE UPDATE ON offers
  FOR EACH ROW EXECUTE FUNCTION app.offers_protect_terms();

CREATE TABLE deal_milestones (
  id                    uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id            uuid         NOT NULL,
  deal_id               uuid         NOT NULL,
  milestone_template_id uuid         REFERENCES milestone_templates (id),
  code                  text         NOT NULL,
  name                  text         NOT NULL,
  sort_order            smallint     NOT NULL,
  is_required           boolean      NOT NULL DEFAULT true,
  due_date              date,
  completed_at          timestamptz,
  completed_by          uuid,
  notes                 text,
  UNIQUE (company_id, id),
  UNIQUE (company_id, deal_id, code),
  FOREIGN KEY (company_id, deal_id) REFERENCES deals (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, completed_by) REFERENCES company_memberships (company_id, id),
  CHECK ((completed_at IS NULL) = (completed_by IS NULL))
);
CREATE INDEX deal_milestones_due_idx ON deal_milestones (company_id, due_date) WHERE completed_at IS NULL;

-- The completed (or completing) sale: price, contract and completion facts.
CREATE TABLE sales_transactions (
  id                     uuid           PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id             uuid           NOT NULL,
  reference              text           NOT NULL,
  deal_id                uuid           NOT NULL,
  listing_id             uuid           NOT NULL,
  unit_id                uuid           NOT NULL,
  accepted_offer_id      uuid           NOT NULL,
  currency_code          char(3)        NOT NULL REFERENCES currencies (code),
  agreed_price           numeric(19,4)  NOT NULL CHECK (agreed_price > 0),
  agency_fee             numeric(19,4)  CHECK (agency_fee >= 0),       -- invoiced to seller/buyer per mandate
  agency_fee_tax_code_id uuid           REFERENCES tax_codes (id),
  status                 text           NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'exchanged', 'completed', 'fallen_through', 'rescinded')),
  contract_signed_on     date,
  completion_due_on      date,
  completed_on           date,
  title_transfer_ref     text,
  contract_document_id   uuid,
  fallen_through_reason  text,
  created_at             timestamptz    NOT NULL DEFAULT now(),
  updated_at             timestamptz    NOT NULL DEFAULT now(),
  version                integer        NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  UNIQUE (company_id, reference),
  UNIQUE (company_id, deal_id),
  FOREIGN KEY (company_id, deal_id) REFERENCES deals (company_id, id),
  FOREIGN KEY (company_id, listing_id) REFERENCES listings (company_id, id),
  FOREIGN KEY (company_id, unit_id) REFERENCES units (company_id, id),
  FOREIGN KEY (company_id, accepted_offer_id) REFERENCES offers (company_id, id),
  CHECK (status <> 'completed' OR completed_on IS NOT NULL),
  CHECK (status <> 'fallen_through' OR fallen_through_reason IS NOT NULL)
);
CREATE INDEX sales_transactions_completion_idx ON sales_transactions (company_id, status, completed_on);
