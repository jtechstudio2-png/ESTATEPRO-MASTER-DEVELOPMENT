-- =============================================================================
-- EstatePro · Migration 0008 · Bank accounts, financial periods, management
-- agreements, leases, rent charges, payments, allocations, deposits, arrears,
-- inspections
-- =============================================================================
-- Rent design:
--   rent_charges      what is owed (generated from the lease; fixed records)
--   payments          money received (cash, transfer, cheque, card, mobile money)
--   payment_allocations  which payment paid which charge (append-only)
-- Balances and arrears are DERIVED from these rows (views at the end), so they
-- are always reproducible and auditable.
-- =============================================================================

CREATE TABLE bank_accounts (
  id                        uuid           PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id                uuid           NOT NULL,
  office_id                 uuid,
  name                      text           NOT NULL,
  account_purpose           text           NOT NULL CHECK (account_purpose IN ('client_money', 'deposit_holding', 'operating')),
  account_type              text           NOT NULL DEFAULT 'bank' CHECK (account_type IN ('bank', 'mobile_money', 'cash', 'payment_provider')),
  provider_name             text,
  country_code              char(2)        NOT NULL REFERENCES countries (code),
  currency_code             char(3)        NOT NULL REFERENCES currencies (code),
  account_number_encrypted  bytea,
  last4                     text,
  opening_balance           numeric(19,4)  NOT NULL DEFAULT 0,
  opening_balance_date      date,
  is_active                 boolean        NOT NULL DEFAULT true,
  created_at                timestamptz    NOT NULL DEFAULT now(),
  updated_at                timestamptz    NOT NULL DEFAULT now(),
  version                   integer        NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, office_id) REFERENCES offices (company_id, id)
);

-- Locked periods reject new or changed financial entries dated inside them.
CREATE TABLE financial_periods (
  id            uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id    uuid         NOT NULL,
  period_start  date         NOT NULL,
  period_end    date         NOT NULL,
  status        text         NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'locked')),
  locked_by     uuid,
  locked_at     timestamptz,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, locked_by) REFERENCES company_memberships (company_id, id),
  CHECK (period_end >= period_start),
  CHECK ((status = 'locked') = (locked_at IS NOT NULL AND locked_by IS NOT NULL)),
  EXCLUDE USING gist (company_id WITH =, daterange(period_start, period_end, '[]') WITH &&)
);

CREATE OR REPLACE FUNCTION app.assert_period_open(p_company_id uuid, p_date date) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, app AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM financial_periods
              WHERE company_id = p_company_id AND status = 'locked'
                AND p_date BETWEEN period_start AND period_end) THEN
    RAISE EXCEPTION 'financial period containing % is locked', p_date
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$$;

-- TG_ARGV[0]: name of the date column that places the row in a period.
CREATE OR REPLACE FUNCTION app.enforce_open_period() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM app.assert_period_open(OLD.company_id, (to_jsonb(OLD) ->> TG_ARGV[0])::date);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM app.assert_period_open(NEW.company_id, (to_jsonb(NEW) ->> TG_ARGV[0])::date);
    RETURN NEW;
  END IF;
  RETURN OLD;
END
$$;

-- -----------------------------------------------------------------------------
-- Management agreements: the landlord's instruction and fee terms.
-- -----------------------------------------------------------------------------
CREATE TABLE management_agreements (
  id                       uuid           PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id               uuid           NOT NULL,
  reference                text           NOT NULL,
  landlord_contact_id      uuid           NOT NULL,
  property_id              uuid           NOT NULL,
  unit_id                  uuid,          -- NULL = whole property
  service_level            text           NOT NULL CHECK (service_level IN ('let_only', 'rent_collection', 'fully_managed')),
  status                   text           NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'suspended', 'ended')),
  currency_code            char(3)        NOT NULL REFERENCES currencies (code),
  fee_basis                text           NOT NULL CHECK (fee_basis IN ('percent_of_rent_collected', 'percent_of_rent_due', 'fixed_per_period', 'one_off')),
  fee_percent              numeric(7,4)   CHECK (fee_percent >= 0 AND fee_percent <= 100),
  fee_fixed_amount         numeric(19,4)  CHECK (fee_fixed_amount >= 0),
  letting_fee_terms        jsonb          NOT NULL DEFAULT '{}'::jsonb,
  fee_tax_code_id          uuid           REFERENCES tax_codes (id),
  -- Repairs above this amount need the landlord's approval.
  expense_approval_limit   numeric(19,4)  CHECK (expense_approval_limit >= 0),
  float_amount             numeric(19,4)  NOT NULL DEFAULT 0 CHECK (float_amount >= 0),  -- retained for repairs
  payout_frequency         text           NOT NULL DEFAULT 'monthly' CHECK (payout_frequency IN ('on_receipt', 'weekly', 'monthly', 'quarterly')),
  payout_day               smallint       CHECK (payout_day BETWEEN 1 AND 31),
  payout_account_id        uuid,
  start_date               date           NOT NULL,
  end_date                 date,
  notice_period_days       smallint       CHECK (notice_period_days >= 0),
  document_id              uuid,
  created_at               timestamptz    NOT NULL DEFAULT now(),
  updated_at               timestamptz    NOT NULL DEFAULT now(),
  version                  integer        NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  UNIQUE (company_id, reference),
  FOREIGN KEY (company_id, landlord_contact_id) REFERENCES contacts (company_id, id),
  FOREIGN KEY (company_id, property_id) REFERENCES properties (company_id, id),
  FOREIGN KEY (company_id, unit_id) REFERENCES units (company_id, id),
  FOREIGN KEY (company_id, payout_account_id) REFERENCES contact_payment_accounts (company_id, id),
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK (fee_basis NOT LIKE 'percent%' OR fee_percent IS NOT NULL),
  CHECK (fee_basis NOT IN ('fixed_per_period', 'one_off') OR fee_fixed_amount IS NOT NULL)
);
CREATE INDEX management_agreements_landlord_idx ON management_agreements (company_id, landlord_contact_id) WHERE status = 'active';
CREATE INDEX management_agreements_property_idx ON management_agreements (company_id, property_id, unit_id);

-- -----------------------------------------------------------------------------
-- Leases
-- -----------------------------------------------------------------------------
CREATE TABLE leases (
  id                       uuid           PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id               uuid           NOT NULL,
  reference                text           NOT NULL,
  unit_id                  uuid           NOT NULL,
  management_agreement_id  uuid,
  listing_id               uuid,
  previous_lease_id        uuid,          -- renewal chain
  jurisdiction_code        text           NOT NULL REFERENCES jurisdictions (code),
  lease_type               text           NOT NULL CHECK (lease_type IN ('fixed_term', 'periodic')),
  usage                    text           NOT NULL DEFAULT 'residential' CHECK (usage IN ('residential', 'commercial', 'mixed')),
  status                   text           NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft', 'pending_signature', 'active', 'periodic', 'notice_given', 'ended', 'closed', 'cancelled')),
  renewal_status           text           NOT NULL DEFAULT 'not_due'
                             CHECK (renewal_status IN ('not_due', 'pending_decision', 'renewing', 'not_renewing', 'renewed')),
  start_date               date           NOT NULL,
  end_date                 date,          -- NULL for periodic
  move_in_date             date,
  move_out_date            date,
  currency_code            char(3)        NOT NULL REFERENCES currencies (code),
  rent_amount              numeric(19,4)  NOT NULL CHECK (rent_amount > 0),
  rent_frequency           text           NOT NULL CHECK (rent_frequency IN ('weekly', 'monthly', 'quarterly', 'semi_annual', 'annual')),
  rent_due_day             smallint       CHECK (rent_due_day BETWEEN 1 AND 31),
  -- Periods paid up-front at signing (e.g. 12 or 24 months in some markets).
  advance_periods          smallint       NOT NULL DEFAULT 1 CHECK (advance_periods >= 0),
  prorate_first_period     boolean        NOT NULL DEFAULT true,
  rent_tax_code_id         uuid           REFERENCES tax_codes (id),
  deposit_amount           numeric(19,4)  CHECK (deposit_amount >= 0),
  notice_period_days       smallint       CHECK (notice_period_days >= 0),
  break_clause_date        date,
  break_notice_days        smallint,
  next_rent_review_date    date,
  template_id              uuid,          -- country/locale lease template (documents module)
  governing_locale_code    text           REFERENCES locales (code),
  signed_at                timestamptz,
  document_id              uuid,
  notice_given_on          date,
  notice_given_by          text           CHECK (notice_given_by IN ('tenant', 'landlord', 'agent')),
  ended_reason             text,
  custom_fields            jsonb          NOT NULL DEFAULT '{}'::jsonb,
  created_by               uuid,
  created_at               timestamptz    NOT NULL DEFAULT now(),
  updated_at               timestamptz    NOT NULL DEFAULT now(),
  version                  integer        NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  UNIQUE (company_id, reference),
  FOREIGN KEY (company_id, unit_id) REFERENCES units (company_id, id),
  FOREIGN KEY (company_id, management_agreement_id) REFERENCES management_agreements (company_id, id),
  FOREIGN KEY (company_id, listing_id) REFERENCES listings (company_id, id),
  FOREIGN KEY (company_id, previous_lease_id) REFERENCES leases (company_id, id),
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK (lease_type = 'periodic' OR end_date IS NOT NULL),
  CHECK (status NOT IN ('active', 'periodic', 'notice_given', 'ended', 'closed') OR signed_at IS NOT NULL),
  CHECK (status <> 'notice_given' OR (notice_given_on IS NOT NULL AND notice_given_by IS NOT NULL)),
  CHECK (previous_lease_id IS NULL OR previous_lease_id <> id),
  -- A unit cannot have two live leases covering the same dates.
  EXCLUDE USING gist (company_id WITH =, unit_id WITH =,
                      daterange(start_date, coalesce(end_date, 'infinity'::date), '[]') WITH &&)
    WHERE (status IN ('pending_signature', 'active', 'periodic', 'notice_given'))
);
CREATE INDEX leases_expiry_idx ON leases (company_id, end_date) WHERE status IN ('active', 'notice_given');
CREATE INDEX leases_unit_idx ON leases (company_id, unit_id, start_date DESC);
CREATE INDEX leases_review_idx ON leases (company_id, next_rent_review_date) WHERE next_rent_review_date IS NOT NULL AND status IN ('active', 'periodic');

CREATE TABLE lease_parties (
  company_id       uuid          NOT NULL,
  lease_id         uuid          NOT NULL,
  contact_id       uuid          NOT NULL,
  party_role       text          NOT NULL CHECK (party_role IN ('tenant', 'co_tenant', 'occupant', 'guarantor', 'landlord', 'landlord_agent')),
  is_primary       boolean       NOT NULL DEFAULT false,
  liability_share  numeric(7,4)  CHECK (liability_share > 0 AND liability_share <= 100),
  portal_access    boolean       NOT NULL DEFAULT true,
  PRIMARY KEY (company_id, lease_id, contact_id, party_role),
  FOREIGN KEY (company_id, lease_id) REFERENCES leases (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts (company_id, id)
);
CREATE INDEX lease_parties_contact_idx ON lease_parties (company_id, contact_id);
CREATE UNIQUE INDEX lease_parties_one_primary_tenant_idx ON lease_parties (company_id, lease_id)
  WHERE is_primary AND party_role IN ('tenant', 'co_tenant');

CREATE TABLE rent_reviews (
  id              uuid           PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id      uuid           NOT NULL,
  lease_id        uuid           NOT NULL,
  review_date     date           NOT NULL,
  method          text           NOT NULL CHECK (method IN ('fixed_increase', 'percentage', 'index_linked', 'market', 'negotiated')),
  old_amount      numeric(19,4)  NOT NULL,
  proposed_amount numeric(19,4),
  agreed_amount   numeric(19,4),
  effective_from  date,
  status          text           NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled', 'proposed', 'agreed', 'applied', 'disputed', 'cancelled')),
  notice_sent_at  timestamptz,
  notes           text,
  created_at      timestamptz    NOT NULL DEFAULT now(),
  updated_at      timestamptz    NOT NULL DEFAULT now(),
  version         integer        NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, lease_id) REFERENCES leases (company_id, id),
  CHECK (status NOT IN ('agreed', 'applied') OR (agreed_amount IS NOT NULL AND effective_from IS NOT NULL))
);
CREATE INDEX rent_reviews_due_idx ON rent_reviews (company_id, review_date) WHERE status IN ('scheduled', 'proposed');

-- -----------------------------------------------------------------------------
-- Charges, payments and allocations
-- -----------------------------------------------------------------------------
CREATE TABLE rent_charges (
  id                 uuid           PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id         uuid           NOT NULL,
  lease_id           uuid           NOT NULL,
  charge_type        text           NOT NULL CHECK (charge_type IN ('rent', 'service_charge', 'deposit', 'fee', 'utility', 'late_fee', 'repair_recharge', 'other')),
  description        text           NOT NULL,
  period_start       date,
  period_end         date,
  due_date           date           NOT NULL,
  currency_code      char(3)        NOT NULL REFERENCES currencies (code),
  amount             numeric(19,4)  NOT NULL CHECK (amount > 0),
  tax_code_id        uuid           REFERENCES tax_codes (id),
  tax_amount         numeric(19,4)  NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total_amount       numeric(19,4)  GENERATED ALWAYS AS (amount + tax_amount) STORED,
  status             text           NOT NULL DEFAULT 'posted' CHECK (status IN ('scheduled', 'posted', 'waived', 'cancelled')),
  waived_reason      text,
  source             text           NOT NULL DEFAULT 'schedule' CHECK (source IN ('schedule', 'manual', 'import', 'automation')),
  posted_at          timestamptz,
  created_by         uuid,
  created_at         timestamptz    NOT NULL DEFAULT now(),
  updated_at         timestamptz    NOT NULL DEFAULT now(),
  version            integer        NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, lease_id) REFERENCES leases (company_id, id),
  CHECK (period_end IS NULL OR period_start IS NULL OR period_end >= period_start),
  CHECK (status <> 'waived' OR waived_reason IS NOT NULL)
);
-- Re-running the rent job never duplicates a period's charge.
CREATE UNIQUE INDEX rent_charges_period_idx ON rent_charges (company_id, lease_id, charge_type, period_start)
  WHERE status IN ('scheduled', 'posted') AND period_start IS NOT NULL;
CREATE INDEX rent_charges_due_idx ON rent_charges (company_id, due_date) WHERE status = 'posted';
CREATE INDEX rent_charges_lease_idx ON rent_charges (company_id, lease_id, due_date);

CREATE TABLE payments (
  id                    uuid           PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id            uuid           NOT NULL,
  reference             text           NOT NULL,
  payer_contact_id      uuid           NOT NULL,
  lease_id              uuid,
  bank_account_id       uuid           NOT NULL,     -- account the money was paid into
  method_code           text           NOT NULL,     -- picklist: payment_method
  currency_code         char(3)        NOT NULL REFERENCES currencies (code),
  amount                numeric(19,4)  NOT NULL CHECK (amount > 0),
  received_on           date           NOT NULL,
  -- Cheques (including post-dated cheques) and similar instruments.
  instrument_number     text,
  instrument_date       date,
  instrument_bank       text,
  value_date            date,          -- date funds are available / cheque clears
  status                text           NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'cleared', 'bounced', 'refunded', 'voided')),
  status_reason         text,
  provider              text,
  provider_reference    text,
  idempotency_key       text,
  notes                 text,
  recorded_by           uuid,
  created_at            timestamptz    NOT NULL DEFAULT now(),
  updated_at            timestamptz    NOT NULL DEFAULT now(),
  version               integer        NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  UNIQUE (company_id, reference),
  UNIQUE (company_id, provider, provider_reference),
  UNIQUE (company_id, idempotency_key),
  FOREIGN KEY (company_id, payer_contact_id) REFERENCES contacts (company_id, id),
  FOREIGN KEY (company_id, lease_id) REFERENCES leases (company_id, id),
  FOREIGN KEY (company_id, bank_account_id) REFERENCES bank_accounts (company_id, id),
  CHECK (status NOT IN ('bounced', 'voided', 'refunded') OR status_reason IS NOT NULL)
);
CREATE INDEX payments_lease_idx ON payments (company_id, lease_id, received_on);
CREATE INDEX payments_pending_instruments_idx ON payments (company_id, instrument_date) WHERE status = 'pending';
CREATE INDEX payments_payer_idx ON payments (company_id, payer_contact_id, received_on);

-- Append-only. Undo an allocation by inserting a negative row that points to it.
CREATE TABLE payment_allocations (
  id               uuid           PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id       uuid           NOT NULL,
  payment_id       uuid           NOT NULL,
  rent_charge_id   uuid           NOT NULL,
  amount           numeric(19,4)  NOT NULL CHECK (amount <> 0),
  reversal_of_id   uuid,
  allocated_on     date           NOT NULL DEFAULT current_date,
  allocated_by     uuid,
  created_at       timestamptz    NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, payment_id) REFERENCES payments (company_id, id),
  FOREIGN KEY (company_id, rent_charge_id) REFERENCES rent_charges (company_id, id),
  FOREIGN KEY (company_id, reversal_of_id) REFERENCES payment_allocations (company_id, id),
  CHECK ((amount > 0) = (reversal_of_id IS NULL))
);
CREATE INDEX payment_allocations_charge_idx ON payment_allocations (company_id, rent_charge_id);
CREATE INDEX payment_allocations_payment_idx ON payment_allocations (company_id, payment_id);
CREATE UNIQUE INDEX payment_allocations_one_reversal_idx ON payment_allocations (company_id, reversal_of_id)
  WHERE reversal_of_id IS NOT NULL;

-- Guards: cleared payment only, same currency, never over-allocate a payment
-- or a charge. Locks the payment and charge rows to serialise concurrent work.
CREATE OR REPLACE FUNCTION app.payment_allocations_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  p payments%ROWTYPE;
  c rent_charges%ROWTYPE;
  payment_used numeric;
  charge_paid numeric;
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

  IF payment_used + NEW.amount > p.amount THEN
    RAISE EXCEPTION 'allocation exceeds unallocated amount of payment %', p.reference
      USING ERRCODE = 'check_violation';
  END IF;
  IF charge_paid + NEW.amount > c.total_amount THEN
    RAISE EXCEPTION 'allocation exceeds outstanding amount of charge %', c.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER payment_allocations_validate BEFORE INSERT ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION app.payment_allocations_validate();
CREATE TRIGGER payment_allocations_append_only BEFORE UPDATE OR DELETE ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER payment_allocations_open_period BEFORE INSERT ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION app.enforce_open_period('allocated_on');

-- Deposits and their return.
CREATE TABLE deposits (
  id                    uuid           PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id            uuid           NOT NULL,
  lease_id              uuid           NOT NULL,
  currency_code         char(3)        NOT NULL REFERENCES currencies (code),
  amount                numeric(19,4)  NOT NULL CHECK (amount > 0),
  holder_type           text           NOT NULL CHECK (holder_type IN ('agent', 'landlord', 'protection_scheme', 'government_body', 'other')),
  holding_account_id    uuid,
  scheme_name           text,
  scheme_reference      text,
  protection_deadline   date,          -- computed from jurisdiction settings at creation
  protected_at          timestamptz,
  status                text           NOT NULL DEFAULT 'expected'
                          CHECK (status IN ('expected', 'held', 'protected', 'return_pending', 'partially_returned', 'returned', 'forfeited', 'disputed')),
  received_payment_id   uuid,
  returned_amount       numeric(19,4)  NOT NULL DEFAULT 0 CHECK (returned_amount >= 0),
  return_due_by         date,
  returned_at           timestamptz,
  created_at            timestamptz    NOT NULL DEFAULT now(),
  updated_at            timestamptz    NOT NULL DEFAULT now(),
  version               integer        NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  UNIQUE (company_id, lease_id),
  FOREIGN KEY (company_id, lease_id) REFERENCES leases (company_id, id),
  FOREIGN KEY (company_id, holding_account_id) REFERENCES bank_accounts (company_id, id),
  FOREIGN KEY (company_id, received_payment_id) REFERENCES payments (company_id, id),
  CHECK (returned_amount <= amount),
  CHECK (status <> 'protected' OR (protected_at IS NOT NULL AND scheme_reference IS NOT NULL))
);
CREATE INDEX deposits_protection_due_idx ON deposits (company_id, protection_deadline) WHERE status IN ('expected', 'held');

CREATE TABLE deposit_deductions (
  id                    uuid           PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id            uuid           NOT NULL,
  deposit_id            uuid           NOT NULL,
  reason_code           text           NOT NULL,     -- picklist: deposit_deduction_reason
  description           text           NOT NULL,
  amount                numeric(19,4)  NOT NULL CHECK (amount > 0),
  evidence_document_id  uuid,
  status                text           NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'agreed', 'disputed', 'adjudicated', 'withdrawn')),
  created_by            uuid,
  created_at            timestamptz    NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, deposit_id) REFERENCES deposits (company_id, id)
);

CREATE TABLE arrears_actions (
  id                  uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id          uuid         NOT NULL,
  lease_id            uuid         NOT NULL,
  action_code         text         NOT NULL,   -- picklist: arrears_action (reminder, call, formal_notice, payment_plan, legal_referral, …)
  action_date         date         NOT NULL DEFAULT current_date,
  arrears_amount      numeric(19,4),
  notes               text,
  next_action_date    date,
  performed_by        uuid,
  source              text         NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'automation')),
  document_id         uuid,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, lease_id) REFERENCES leases (company_id, id),
  FOREIGN KEY (company_id, performed_by) REFERENCES company_memberships (company_id, id)
);
CREATE INDEX arrears_actions_lease_idx ON arrears_actions (company_id, lease_id, action_date DESC);
CREATE INDEX arrears_actions_next_idx ON arrears_actions (company_id, next_action_date) WHERE next_action_date IS NOT NULL;

-- Arrears payment plans agreed with a tenant.
CREATE TABLE payment_plans (
  id              uuid           PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id      uuid           NOT NULL,
  lease_id        uuid           NOT NULL,
  currency_code   char(3)        NOT NULL REFERENCES currencies (code),
  total_amount    numeric(19,4)  NOT NULL CHECK (total_amount > 0),
  instalments     jsonb          NOT NULL,     -- [{"due_date": "...", "amount": "..."}]
  status          text           NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'broken', 'cancelled')),
  agreed_on       date           NOT NULL,
  created_by      uuid,
  created_at      timestamptz    NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, lease_id) REFERENCES leases (company_id, id)
);

-- -----------------------------------------------------------------------------
-- Inspections (move-in, move-out, periodic, pre-listing)
-- -----------------------------------------------------------------------------
CREATE TABLE inspections (
  id                    uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id            uuid         NOT NULL,
  reference             text         NOT NULL,
  property_id           uuid         NOT NULL,
  unit_id               uuid,
  lease_id              uuid,
  inspection_type       text         NOT NULL CHECK (inspection_type IN ('move_in', 'move_out', 'periodic', 'pre_listing', 'maintenance', 'safety')),
  status                text         NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'in_progress', 'completed', 'cancelled')),
  scheduled_at          timestamptz,
  completed_at          timestamptz,
  inspector_membership_id uuid,
  overall_condition     text         CHECK (overall_condition IN ('excellent', 'good', 'fair', 'poor')),
  summary               text,
  tenant_signed_at      timestamptz,
  report_document_id    uuid,
  created_at            timestamptz  NOT NULL DEFAULT now(),
  updated_at            timestamptz  NOT NULL DEFAULT now(),
  version               integer      NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  UNIQUE (company_id, reference),
  FOREIGN KEY (company_id, property_id) REFERENCES properties (company_id, id),
  FOREIGN KEY (company_id, unit_id) REFERENCES units (company_id, id),
  FOREIGN KEY (company_id, lease_id) REFERENCES leases (company_id, id),
  FOREIGN KEY (company_id, inspector_membership_id) REFERENCES company_memberships (company_id, id),
  CHECK (status <> 'completed' OR completed_at IS NOT NULL)
);
CREATE INDEX inspections_schedule_idx ON inspections (company_id, inspector_membership_id, scheduled_at) WHERE status = 'scheduled';

CREATE TABLE inspection_items (
  id              uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id      uuid         NOT NULL,
  inspection_id   uuid         NOT NULL,
  area            text         NOT NULL,       -- room / zone
  item            text         NOT NULL,
  condition_code  text         CHECK (condition_code IN ('new', 'good', 'fair', 'poor', 'damaged', 'missing', 'not_applicable')),
  cleanliness     text         CHECK (cleanliness IN ('clean', 'acceptable', 'dirty')),
  notes           text,
  action_required boolean      NOT NULL DEFAULT false,
  sort_order      integer      NOT NULL DEFAULT 0,
  FOREIGN KEY (company_id, inspection_id) REFERENCES inspections (company_id, id) ON DELETE CASCADE
);
CREATE INDEX inspection_items_idx ON inspection_items (company_id, inspection_id, sort_order);

-- -----------------------------------------------------------------------------
-- Derived balances. security_invoker makes the views obey the caller's RLS.
-- -----------------------------------------------------------------------------
CREATE VIEW rent_charge_balances WITH (security_invoker = true) AS
SELECT c.company_id,
       c.id AS rent_charge_id,
       c.lease_id,
       c.charge_type,
       c.due_date,
       c.currency_code,
       c.total_amount,
       coalesce(a.paid, 0) AS paid_amount,
       c.total_amount - coalesce(a.paid, 0) AS outstanding_amount
  FROM rent_charges c
  LEFT JOIN (SELECT company_id, rent_charge_id, sum(amount) AS paid
               FROM payment_allocations GROUP BY company_id, rent_charge_id) a
         ON a.company_id = c.company_id AND a.rent_charge_id = c.id
 WHERE c.status = 'posted';

-- Arrears ageing as of a business date (pass the date in the property's
-- timezone; the server's current_date is not used).
CREATE FUNCTION app.lease_arrears(p_as_of date)
RETURNS TABLE (company_id uuid, lease_id uuid, currency_code char(3),
               total_outstanding numeric, days_0_30 numeric, days_31_60 numeric,
               days_61_90 numeric, days_over_90 numeric, oldest_due_date date)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT b.company_id, b.lease_id, b.currency_code,
         sum(b.outstanding_amount),
         sum(b.outstanding_amount) FILTER (WHERE p_as_of - b.due_date BETWEEN 1 AND 30),
         sum(b.outstanding_amount) FILTER (WHERE p_as_of - b.due_date BETWEEN 31 AND 60),
         sum(b.outstanding_amount) FILTER (WHERE p_as_of - b.due_date BETWEEN 61 AND 90),
         sum(b.outstanding_amount) FILTER (WHERE p_as_of - b.due_date > 90),
         min(b.due_date)
    FROM rent_charge_balances b
   WHERE b.outstanding_amount > 0 AND b.due_date < p_as_of
   GROUP BY b.company_id, b.lease_id, b.currency_code
$$;
