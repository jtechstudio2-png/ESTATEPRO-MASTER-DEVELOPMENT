-- =============================================================================
-- EstatePro · Migration 0010 · Operational finance: transactions, party
-- ledgers, supplier invoices, landlord statements, payouts, commissions,
-- bank statement import
-- =============================================================================
-- Scope: operational money tracking for property businesses. Not a general
-- ledger. Posted rows are immutable; corrections are reversals. Locked
-- financial periods reject entries dated inside them.
-- =============================================================================

CREATE TABLE supplier_invoices (
  id                      uuid           PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id              uuid           NOT NULL,
  supplier_contact_id     uuid           NOT NULL,
  invoice_number          text           NOT NULL,
  invoice_date            date           NOT NULL,
  due_date                date,
  currency_code           char(3)        NOT NULL REFERENCES currencies (code),
  amount                  numeric(19,4)  NOT NULL CHECK (amount >= 0),
  tax_amount              numeric(19,4)  NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  chargeable_to           text           NOT NULL CHECK (chargeable_to IN ('landlord', 'agency', 'tenant', 'development')),
  property_id             uuid,
  unit_id                 uuid,
  maintenance_request_id  uuid,
  status                  text           NOT NULL DEFAULT 'received'
                            CHECK (status IN ('received', 'approved', 'scheduled', 'paid', 'disputed', 'void')),
  approved_by             uuid,
  approved_at             timestamptz,
  document_id             uuid,
  created_by              uuid,
  created_at              timestamptz    NOT NULL DEFAULT now(),
  updated_at              timestamptz    NOT NULL DEFAULT now(),
  version                 integer        NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  UNIQUE (company_id, supplier_contact_id, invoice_number),
  FOREIGN KEY (company_id, supplier_contact_id) REFERENCES contacts (company_id, id),
  FOREIGN KEY (company_id, property_id) REFERENCES properties (company_id, id),
  FOREIGN KEY (company_id, unit_id) REFERENCES units (company_id, id),
  FOREIGN KEY (company_id, maintenance_request_id) REFERENCES maintenance_requests (company_id, id),
  FOREIGN KEY (company_id, approved_by) REFERENCES company_memberships (company_id, id),
  CHECK (chargeable_to <> 'landlord' OR property_id IS NOT NULL),
  CHECK (status NOT IN ('approved', 'scheduled', 'paid') OR approved_by IS NOT NULL)
);
CREATE INDEX supplier_invoices_due_idx ON supplier_invoices (company_id, due_date) WHERE status IN ('received', 'approved', 'scheduled');

-- -----------------------------------------------------------------------------
-- Commission plans and commissions
-- -----------------------------------------------------------------------------
CREATE TABLE commission_plans (
  id              uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id      uuid         NOT NULL,
  name            text         NOT NULL,
  deal_type       text         NOT NULL CHECK (deal_type IN ('sale', 'letting', 'any')),
  basis           text         NOT NULL CHECK (basis IN ('agency_fee', 'sale_price', 'first_year_rent')),
  -- Tiers: [{"from": 0, "to": 100000, "percent": 20}, {"from": 100000, "percent": 30}]
  -- or flat: [{"from": 0, "percent": 25}]. Values are in the deal currency.
  tiers           jsonb        NOT NULL,
  tier_period     text         NOT NULL DEFAULT 'per_deal' CHECK (tier_period IN ('per_deal', 'monthly', 'quarterly', 'annual')),
  effective_from  date         NOT NULL,
  effective_to    date,
  is_active       boolean      NOT NULL DEFAULT true,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  version         integer      NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  CHECK (jsonb_typeof(tiers) = 'array' AND jsonb_array_length(tiers) > 0),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE TABLE membership_commission_plans (
  company_id          uuid  NOT NULL,
  membership_id       uuid  NOT NULL,
  commission_plan_id  uuid  NOT NULL,
  effective_from      date  NOT NULL,
  effective_to        date,
  PRIMARY KEY (company_id, membership_id, commission_plan_id, effective_from),
  FOREIGN KEY (company_id, membership_id) REFERENCES company_memberships (company_id, id),
  FOREIGN KEY (company_id, commission_plan_id) REFERENCES commission_plans (company_id, id),
  EXCLUDE USING gist (company_id WITH =, membership_id WITH =,
                      daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[)') WITH &&)
);

CREATE TABLE commissions (
  id                    uuid           PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id            uuid           NOT NULL,
  deal_id               uuid           NOT NULL,
  sales_transaction_id  uuid,
  lease_id              uuid,
  membership_id         uuid           NOT NULL,       -- the agent being paid
  commission_plan_id    uuid,
  currency_code         char(3)        NOT NULL REFERENCES currencies (code),
  basis_amount          numeric(19,4)  NOT NULL CHECK (basis_amount >= 0),
  split_percent         numeric(7,4)   NOT NULL CHECK (split_percent > 0 AND split_percent <= 100),
  amount                numeric(19,4)  NOT NULL,       -- may be negative for a clawback
  calculation           jsonb          NOT NULL,       -- snapshot of plan, tiers and inputs used
  status                text           NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'approved', 'payable', 'paid', 'held', 'cancelled')),
  adjusts_commission_id uuid,
  approved_by           uuid,
  approved_at           timestamptz,
  paid_at               timestamptz,
  payroll_reference     text,
  notes                 text,
  created_at            timestamptz    NOT NULL DEFAULT now(),
  updated_at            timestamptz    NOT NULL DEFAULT now(),
  version               integer        NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, deal_id) REFERENCES deals (company_id, id),
  FOREIGN KEY (company_id, sales_transaction_id) REFERENCES sales_transactions (company_id, id),
  FOREIGN KEY (company_id, lease_id) REFERENCES leases (company_id, id),
  FOREIGN KEY (company_id, membership_id) REFERENCES company_memberships (company_id, id),
  FOREIGN KEY (company_id, commission_plan_id) REFERENCES commission_plans (company_id, id),
  FOREIGN KEY (company_id, adjusts_commission_id) REFERENCES commissions (company_id, id),
  FOREIGN KEY (company_id, approved_by) REFERENCES company_memberships (company_id, id),
  CHECK (status NOT IN ('approved', 'payable', 'paid') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK (status <> 'paid' OR paid_at IS NOT NULL),
  -- Separation of duties: nobody approves their own commission.
  CHECK (approved_by IS NULL OR approved_by <> membership_id),
  CHECK (amount >= 0 OR adjusts_commission_id IS NOT NULL)
);
CREATE INDEX commissions_agent_idx ON commissions (company_id, membership_id, status);
CREATE INDEX commissions_approval_queue_idx ON commissions (company_id, created_at) WHERE status = 'pending';
CREATE UNIQUE INDEX commissions_one_per_agent_deal_idx ON commissions (company_id, deal_id, membership_id)
  WHERE adjusts_commission_id IS NULL AND status <> 'cancelled';

-- -----------------------------------------------------------------------------
-- Finance transactions: operational income and expenditure events
-- -----------------------------------------------------------------------------
CREATE TABLE finance_transactions (
  id                      uuid           PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id              uuid           NOT NULL,
  reference               text           NOT NULL,
  txn_type                text           NOT NULL CHECK (txn_type IN (
                            'rent_received', 'management_fee', 'letting_fee', 'sales_fee', 'other_income',
                            'property_expense', 'agency_expense', 'landlord_payout', 'supplier_payment',
                            'commission_payment', 'deposit_received', 'deposit_returned', 'refund', 'adjustment')),
  direction               text           NOT NULL CHECK (direction IN ('in', 'out', 'internal')),
  txn_date                date           NOT NULL,
  currency_code           char(3)        NOT NULL REFERENCES currencies (code),
  amount                  numeric(19,4)  NOT NULL CHECK (amount > 0),
  tax_code_id             uuid           REFERENCES tax_codes (id),
  tax_amount              numeric(19,4)  NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  bank_account_id         uuid,
  counterparty_contact_id uuid,
  office_id               uuid,
  property_id             uuid,
  unit_id                 uuid,
  lease_id                uuid,
  deal_id                 uuid,
  maintenance_request_id  uuid,
  payment_id              uuid,
  supplier_invoice_id     uuid,
  commission_id           uuid,
  category_code           text,          -- picklist: income_category / expense_category
  description             text           NOT NULL,
  status                  text           NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'reversed')),
  posted_at               timestamptz,
  posted_by               uuid,
  reversal_of_id          uuid,
  reversed_at             timestamptz,
  created_by              uuid,
  created_at              timestamptz    NOT NULL DEFAULT now(),
  updated_at              timestamptz    NOT NULL DEFAULT now(),
  version                 integer        NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  UNIQUE (company_id, reference),
  FOREIGN KEY (company_id, bank_account_id) REFERENCES bank_accounts (company_id, id),
  FOREIGN KEY (company_id, counterparty_contact_id) REFERENCES contacts (company_id, id),
  FOREIGN KEY (company_id, office_id) REFERENCES offices (company_id, id),
  FOREIGN KEY (company_id, property_id) REFERENCES properties (company_id, id),
  FOREIGN KEY (company_id, unit_id) REFERENCES units (company_id, id),
  FOREIGN KEY (company_id, lease_id) REFERENCES leases (company_id, id),
  FOREIGN KEY (company_id, deal_id) REFERENCES deals (company_id, id),
  FOREIGN KEY (company_id, maintenance_request_id) REFERENCES maintenance_requests (company_id, id),
  FOREIGN KEY (company_id, payment_id) REFERENCES payments (company_id, id),
  FOREIGN KEY (company_id, supplier_invoice_id) REFERENCES supplier_invoices (company_id, id),
  FOREIGN KEY (company_id, commission_id) REFERENCES commissions (company_id, id),
  FOREIGN KEY (company_id, reversal_of_id) REFERENCES finance_transactions (company_id, id),
  FOREIGN KEY (company_id, posted_by) REFERENCES company_memberships (company_id, id),
  CHECK ((status IN ('posted', 'reversed')) = (posted_at IS NOT NULL)),
  CHECK ((status = 'reversed') = (reversed_at IS NOT NULL))
);
CREATE INDEX finance_transactions_date_idx ON finance_transactions (company_id, txn_date, txn_type) WHERE status <> 'draft';
CREATE INDEX finance_transactions_property_idx ON finance_transactions (company_id, property_id, txn_date) WHERE property_id IS NOT NULL;
CREATE INDEX finance_transactions_counterparty_idx ON finance_transactions (company_id, counterparty_contact_id, txn_date);
CREATE UNIQUE INDEX finance_transactions_one_reversal_idx ON finance_transactions (company_id, reversal_of_id) WHERE reversal_of_id IS NOT NULL;

CREATE TRIGGER finance_transactions_freeze BEFORE UPDATE OR DELETE ON finance_transactions
  FOR EACH ROW EXECUTE FUNCTION app.freeze_when_posted('status', 'posted,reversed', 'status,reversed_at');
CREATE TRIGGER finance_transactions_open_period BEFORE INSERT OR UPDATE OR DELETE ON finance_transactions
  FOR EACH ROW EXECUTE FUNCTION app.enforce_open_period('txn_date');

-- -----------------------------------------------------------------------------
-- Party ledgers: what the company holds for or owes each landlord, tenant,
-- supplier and itself. Append-only; balance = sum(credit) − sum(debit).
-- -----------------------------------------------------------------------------
CREATE TABLE ledger_entries (
  id                      uuid           PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id              uuid           NOT NULL,
  ledger_type             text           NOT NULL CHECK (ledger_type IN ('landlord', 'tenant', 'supplier', 'agency', 'deposit')),
  contact_id              uuid,          -- NULL only for the agency ledger
  property_id             uuid,
  lease_id                uuid,
  entry_date              date           NOT NULL,
  currency_code           char(3)        NOT NULL REFERENCES currencies (code),
  debit                   numeric(19,4)  NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit                  numeric(19,4)  NOT NULL DEFAULT 0 CHECK (credit >= 0),
  description             text           NOT NULL,
  finance_transaction_id  uuid,
  payment_allocation_id   uuid,
  rent_charge_id          uuid,
  reversal_of_id          uuid,
  created_by              uuid,
  created_at              timestamptz    NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, contact_id) REFERENCES contacts (company_id, id),
  FOREIGN KEY (company_id, property_id) REFERENCES properties (company_id, id),
  FOREIGN KEY (company_id, lease_id) REFERENCES leases (company_id, id),
  FOREIGN KEY (company_id, finance_transaction_id) REFERENCES finance_transactions (company_id, id),
  FOREIGN KEY (company_id, payment_allocation_id) REFERENCES payment_allocations (company_id, id),
  FOREIGN KEY (company_id, rent_charge_id) REFERENCES rent_charges (company_id, id),
  FOREIGN KEY (company_id, reversal_of_id) REFERENCES ledger_entries (company_id, id),
  CHECK ((debit > 0) <> (credit > 0)),
  CHECK ((ledger_type = 'agency') = (contact_id IS NULL))
);
CREATE INDEX ledger_entries_party_idx ON ledger_entries (company_id, ledger_type, contact_id, currency_code, entry_date);
CREATE INDEX ledger_entries_property_idx ON ledger_entries (company_id, property_id, entry_date) WHERE property_id IS NOT NULL;
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER ledger_entries_open_period BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION app.enforce_open_period('entry_date');

CREATE VIEW ledger_balances WITH (security_invoker = true) AS
SELECT company_id, ledger_type, contact_id, currency_code,
       sum(credit) - sum(debit) AS balance,
       max(entry_date) AS last_entry_date
  FROM ledger_entries
 GROUP BY company_id, ledger_type, contact_id, currency_code;

-- -----------------------------------------------------------------------------
-- Landlord statements and payouts
-- -----------------------------------------------------------------------------
CREATE TABLE statements (
  id                   uuid           PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id           uuid           NOT NULL,
  reference            text           NOT NULL,
  landlord_contact_id  uuid           NOT NULL,
  period_start         date           NOT NULL,
  period_end           date           NOT NULL,
  currency_code        char(3)        NOT NULL REFERENCES currencies (code),
  opening_balance      numeric(19,4)  NOT NULL,
  total_income         numeric(19,4)  NOT NULL,
  total_fees           numeric(19,4)  NOT NULL,
  total_expenses       numeric(19,4)  NOT NULL,
  total_payouts        numeric(19,4)  NOT NULL,
  closing_balance      numeric(19,4)  NOT NULL,
  status               text           NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'void')),
  issued_at            timestamptz,
  issued_by            uuid,
  void_reason          text,
  document_id          uuid,
  created_at           timestamptz    NOT NULL DEFAULT now(),
  updated_at           timestamptz    NOT NULL DEFAULT now(),
  version              integer        NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  UNIQUE (company_id, reference),
  FOREIGN KEY (company_id, landlord_contact_id) REFERENCES contacts (company_id, id),
  FOREIGN KEY (company_id, issued_by) REFERENCES company_memberships (company_id, id),
  CHECK (period_end >= period_start),
  CHECK (closing_balance = opening_balance + total_income - total_fees - total_expenses - total_payouts),
  CHECK (status <> 'issued' OR issued_at IS NOT NULL),
  CHECK (status <> 'void' OR void_reason IS NOT NULL)
);
CREATE UNIQUE INDEX statements_one_live_per_period_idx ON statements (company_id, landlord_contact_id, currency_code, period_start)
  WHERE status <> 'void';
CREATE TRIGGER statements_freeze BEFORE UPDATE OR DELETE ON statements
  FOR EACH ROW EXECUTE FUNCTION app.freeze_when_posted('status', 'issued,void', 'status,void_reason,document_id');

CREATE TABLE statement_lines (
  company_id        uuid     NOT NULL,
  statement_id      uuid     NOT NULL,
  ledger_entry_id   uuid     NOT NULL,
  line_group        text     NOT NULL CHECK (line_group IN ('income', 'fee', 'expense', 'payout', 'adjustment')),
  sort_order        integer  NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, statement_id, ledger_entry_id),
  FOREIGN KEY (company_id, statement_id) REFERENCES statements (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, ledger_entry_id) REFERENCES ledger_entries (company_id, id)
);

CREATE TABLE payouts (
  id                    uuid           PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id            uuid           NOT NULL,
  reference             text           NOT NULL,
  payee_contact_id      uuid           NOT NULL,
  payee_type            text           NOT NULL CHECK (payee_type IN ('landlord', 'supplier', 'tenant_refund', 'other')),
  from_account_id       uuid           NOT NULL,     -- company bank account
  to_account_id         uuid           NOT NULL,     -- payee's bank / mobile-money account
  currency_code         char(3)        NOT NULL REFERENCES currencies (code),
  amount                numeric(19,4)  NOT NULL CHECK (amount > 0),
  statement_id          uuid,
  supplier_invoice_id   uuid,
  status                text           NOT NULL DEFAULT 'pending_approval'
                          CHECK (status IN ('pending_approval', 'approved', 'sent', 'paid', 'failed', 'cancelled')),
  requested_by          uuid           NOT NULL,
  requested_at          timestamptz    NOT NULL DEFAULT now(),
  approved_by           uuid,
  approved_at           timestamptz,
  paid_on               date,
  bank_reference        text,
  failure_reason        text,
  finance_transaction_id uuid,
  created_at            timestamptz    NOT NULL DEFAULT now(),
  updated_at            timestamptz    NOT NULL DEFAULT now(),
  version               integer        NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  UNIQUE (company_id, reference),
  FOREIGN KEY (company_id, payee_contact_id) REFERENCES contacts (company_id, id),
  FOREIGN KEY (company_id, from_account_id) REFERENCES bank_accounts (company_id, id),
  FOREIGN KEY (company_id, to_account_id) REFERENCES contact_payment_accounts (company_id, id),
  FOREIGN KEY (company_id, statement_id) REFERENCES statements (company_id, id),
  FOREIGN KEY (company_id, supplier_invoice_id) REFERENCES supplier_invoices (company_id, id),
  FOREIGN KEY (company_id, requested_by) REFERENCES company_memberships (company_id, id),
  FOREIGN KEY (company_id, approved_by) REFERENCES company_memberships (company_id, id),
  FOREIGN KEY (company_id, finance_transaction_id) REFERENCES finance_transactions (company_id, id),
  CHECK (status NOT IN ('approved', 'sent', 'paid') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
  -- Separation of duties: the requester cannot approve the same payout.
  CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CHECK (status <> 'paid' OR paid_on IS NOT NULL),
  CHECK (status <> 'failed' OR failure_reason IS NOT NULL)
);
CREATE INDEX payouts_queue_idx ON payouts (company_id, status, requested_at) WHERE status IN ('pending_approval', 'approved', 'sent');

-- -----------------------------------------------------------------------------
-- Bank statement import and reconciliation
-- -----------------------------------------------------------------------------
CREATE TABLE bank_statement_lines (
  id                      uuid           PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id              uuid           NOT NULL,
  bank_account_id         uuid           NOT NULL,
  import_job_id           uuid,
  line_date               date           NOT NULL,
  value_date              date,
  currency_code           char(3)        NOT NULL REFERENCES currencies (code),
  amount                  numeric(19,4)  NOT NULL CHECK (amount <> 0),      -- + money in, − money out
  description             text,
  bank_reference          text,
  fingerprint             bytea          NOT NULL,   -- hash of account+date+amount+reference; prevents re-import
  match_status            text           NOT NULL DEFAULT 'unmatched'
                            CHECK (match_status IN ('unmatched', 'suggested', 'matched', 'ignored')),
  matched_payment_id      uuid,
  matched_transaction_id  uuid,
  match_confidence        numeric(5,2),
  matched_by              uuid,
  matched_at              timestamptz,
  created_at              timestamptz    NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, bank_account_id, fingerprint),
  FOREIGN KEY (company_id, bank_account_id) REFERENCES bank_accounts (company_id, id),
  FOREIGN KEY (company_id, matched_payment_id) REFERENCES payments (company_id, id),
  FOREIGN KEY (company_id, matched_transaction_id) REFERENCES finance_transactions (company_id, id),
  CHECK (match_status <> 'matched' OR matched_payment_id IS NOT NULL OR matched_transaction_id IS NOT NULL)
);
CREATE INDEX bank_statement_lines_unmatched_idx ON bank_statement_lines (company_id, bank_account_id, line_date)
  WHERE match_status IN ('unmatched', 'suggested');
