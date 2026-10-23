-- =============================================================================
-- EstatePro · Migration 0009 · Maintenance requests (work orders)
-- =============================================================================
-- Lifecycle: reported → assigned → (awaiting_approval) → in_progress
--            → (on_hold) → completed → closed;  cancelled from any open state.
-- Priorities and SLA targets are company configuration (sla_policies).
-- =============================================================================

CREATE TABLE sla_policies (
  id                      uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id              uuid         REFERENCES companies (id),     -- NULL = platform default
  priority_code           text         NOT NULL CHECK (priority_code ~ '^[a-z][a-z0-9_]*$'),
  name                    text         NOT NULL,
  rank                    smallint     NOT NULL,     -- 1 = most urgent
  response_minutes        integer      NOT NULL CHECK (response_minutes > 0),
  resolution_minutes      integer      NOT NULL CHECK (resolution_minutes > 0),
  business_hours_only     boolean      NOT NULL DEFAULT false,   -- emergencies run on the clock
  is_active               boolean      NOT NULL DEFAULT true,
  created_at              timestamptz  NOT NULL DEFAULT now(),
  updated_at              timestamptz  NOT NULL DEFAULT now(),
  version                 integer      NOT NULL DEFAULT 1,
  UNIQUE NULLS NOT DISTINCT (company_id, priority_code),
  CHECK (resolution_minutes >= response_minutes)
);

CREATE TABLE maintenance_requests (
  id                         uuid           PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id                 uuid           NOT NULL,
  reference                  text           NOT NULL,
  property_id                uuid           NOT NULL,
  unit_id                    uuid,
  lease_id                   uuid,
  source                     text           NOT NULL CHECK (source IN ('tenant_portal', 'landlord_portal', 'staff', 'inspection', 'phone', 'email', 'planned')),
  reported_by_contact_id     uuid,
  reported_by_membership_id  uuid,
  category_code              text           NOT NULL,     -- picklist: maintenance_category
  title                      text           NOT NULL,
  description                text           NOT NULL,
  sla_policy_id              uuid           NOT NULL REFERENCES sla_policies (id),
  priority_code              text           NOT NULL,
  status                     text           NOT NULL DEFAULT 'reported'
                               CHECK (status IN ('reported', 'assigned', 'awaiting_approval', 'in_progress', 'on_hold', 'completed', 'closed', 'cancelled')),
  on_hold_reason             text,
  access_instructions        text,
  tenant_availability        text,
  permission_to_enter        boolean,
  reported_at                timestamptz    NOT NULL DEFAULT now(),
  response_due_at            timestamptz    NOT NULL,
  resolution_due_at          timestamptz    NOT NULL,
  first_responded_at         timestamptz,
  completed_at               timestamptz,
  closed_at                  timestamptz,
  cost_responsibility        text           CHECK (cost_responsibility IN ('landlord', 'tenant', 'agency', 'insurance', 'warranty', 'none')),
  currency_code              char(3)        REFERENCES currencies (code),
  estimated_cost             numeric(19,4)  CHECK (estimated_cost >= 0),
  actual_cost                numeric(19,4)  CHECK (actual_cost >= 0),
  approval_status            text           NOT NULL DEFAULT 'not_required'
                               CHECK (approval_status IN ('not_required', 'pending', 'approved', 'rejected')),
  approved_by_contact_id     uuid,
  approved_by_membership_id  uuid,
  approved_at                timestamptz,
  tenant_confirmed_at        timestamptz,
  planned_maintenance_id     uuid,
  duplicate_of_id            uuid,
  created_at                 timestamptz    NOT NULL DEFAULT now(),
  updated_at                 timestamptz    NOT NULL DEFAULT now(),
  version                    integer        NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  UNIQUE (company_id, reference),
  FOREIGN KEY (company_id, property_id) REFERENCES properties (company_id, id),
  FOREIGN KEY (company_id, unit_id) REFERENCES units (company_id, id),
  FOREIGN KEY (company_id, lease_id) REFERENCES leases (company_id, id),
  FOREIGN KEY (company_id, reported_by_contact_id) REFERENCES contacts (company_id, id),
  FOREIGN KEY (company_id, reported_by_membership_id) REFERENCES company_memberships (company_id, id),
  FOREIGN KEY (company_id, approved_by_contact_id) REFERENCES contacts (company_id, id),
  FOREIGN KEY (company_id, approved_by_membership_id) REFERENCES company_memberships (company_id, id),
  FOREIGN KEY (company_id, duplicate_of_id) REFERENCES maintenance_requests (company_id, id),
  CHECK (reported_by_contact_id IS NOT NULL OR reported_by_membership_id IS NOT NULL OR source = 'planned'),
  CHECK (resolution_due_at >= response_due_at),
  CHECK (status <> 'on_hold' OR on_hold_reason IS NOT NULL),
  CHECK (status NOT IN ('completed', 'closed') OR completed_at IS NOT NULL),
  CHECK (status <> 'closed' OR (closed_at IS NOT NULL AND cost_responsibility IS NOT NULL)),
  CHECK ((estimated_cost IS NULL AND actual_cost IS NULL) OR currency_code IS NOT NULL),
  CHECK (approval_status <> 'approved' OR approved_at IS NOT NULL),
  CHECK (status <> 'in_progress' OR approval_status IN ('not_required', 'approved'))
);
CREATE INDEX maintenance_open_queue_idx ON maintenance_requests (company_id, status, resolution_due_at)
  WHERE status NOT IN ('closed', 'cancelled');
CREATE INDEX maintenance_property_idx ON maintenance_requests (company_id, property_id, unit_id, reported_at DESC);
CREATE INDEX maintenance_lease_idx ON maintenance_requests (company_id, lease_id) WHERE lease_id IS NOT NULL;
CREATE INDEX maintenance_approval_idx ON maintenance_requests (company_id, approval_status) WHERE approval_status = 'pending';

CREATE TABLE maintenance_assignments (
  id                      uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id              uuid         NOT NULL,
  request_id              uuid         NOT NULL,
  assignee_membership_id  uuid,        -- in-house technician / supplier user
  supplier_contact_id     uuid,        -- external contractor
  status                  text         NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'reassigned', 'declined')),
  scheduled_start         timestamptz,
  scheduled_end           timestamptz,
  assigned_by             uuid,
  assigned_at             timestamptz  NOT NULL DEFAULT now(),
  ended_at                timestamptz,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, request_id) REFERENCES maintenance_requests (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, assignee_membership_id) REFERENCES company_memberships (company_id, id),
  FOREIGN KEY (company_id, supplier_contact_id) REFERENCES contacts (company_id, id),
  FOREIGN KEY (company_id, assigned_by) REFERENCES company_memberships (company_id, id),
  CHECK (assignee_membership_id IS NOT NULL OR supplier_contact_id IS NOT NULL),
  CHECK (scheduled_end IS NULL OR scheduled_end > scheduled_start)
);
CREATE UNIQUE INDEX maintenance_one_active_assignment_idx ON maintenance_assignments (company_id, request_id) WHERE status = 'active';
CREATE INDEX maintenance_assignee_idx ON maintenance_assignments (company_id, assignee_membership_id, scheduled_start) WHERE status = 'active';
CREATE INDEX maintenance_supplier_idx ON maintenance_assignments (company_id, supplier_contact_id) WHERE status = 'active';

CREATE TABLE maintenance_status_history (
  id           uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id   uuid         NOT NULL,
  request_id   uuid         NOT NULL,
  from_status  text,
  to_status    text         NOT NULL,
  changed_at   timestamptz  NOT NULL DEFAULT now(),
  changed_by   uuid,
  note         text,
  FOREIGN KEY (company_id, request_id) REFERENCES maintenance_requests (company_id, id) ON DELETE CASCADE
);
CREATE INDEX maintenance_status_history_idx ON maintenance_status_history (company_id, request_id, changed_at);

-- Comments and progress updates, each with an explicit audience.
CREATE TABLE maintenance_updates (
  id                    uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id            uuid         NOT NULL,
  request_id            uuid         NOT NULL,
  body                  text         NOT NULL,
  visibility            text         NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal', 'tenant', 'landlord', 'all_parties')),
  author_membership_id  uuid,
  author_contact_id     uuid,
  created_at            timestamptz  NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, request_id) REFERENCES maintenance_requests (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, author_membership_id) REFERENCES company_memberships (company_id, id),
  FOREIGN KEY (company_id, author_contact_id) REFERENCES contacts (company_id, id),
  CHECK (author_membership_id IS NOT NULL OR author_contact_id IS NOT NULL)
);
CREATE INDEX maintenance_updates_idx ON maintenance_updates (company_id, request_id, created_at);

CREATE TABLE maintenance_quotes (
  id                   uuid           PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id           uuid           NOT NULL,
  request_id           uuid           NOT NULL,
  supplier_contact_id  uuid           NOT NULL,
  currency_code        char(3)        NOT NULL REFERENCES currencies (code),
  amount               numeric(19,4)  NOT NULL CHECK (amount >= 0),
  tax_amount           numeric(19,4)  NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  valid_until          date,
  status               text           NOT NULL DEFAULT 'submitted' CHECK (status IN ('requested', 'submitted', 'accepted', 'rejected', 'expired')),
  document_id          uuid,
  notes                text,
  created_at           timestamptz    NOT NULL DEFAULT now(),
  updated_at           timestamptz    NOT NULL DEFAULT now(),
  version              integer        NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, request_id) REFERENCES maintenance_requests (company_id, id),
  FOREIGN KEY (company_id, supplier_contact_id) REFERENCES contacts (company_id, id)
);
CREATE UNIQUE INDEX maintenance_one_accepted_quote_idx ON maintenance_quotes (company_id, request_id) WHERE status = 'accepted';

-- Work done: labour and materials recorded at completion.
CREATE TABLE maintenance_work_logs (
  id                  uuid           PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id          uuid           NOT NULL,
  request_id          uuid           NOT NULL,
  assignment_id       uuid,
  started_at          timestamptz,
  ended_at            timestamptz,
  labour_minutes      integer        CHECK (labour_minutes >= 0),
  materials           jsonb          NOT NULL DEFAULT '[]'::jsonb,
  currency_code       char(3)        REFERENCES currencies (code),
  cost                numeric(19,4)  CHECK (cost >= 0),
  notes               text,
  recorded_by         uuid,
  created_at          timestamptz    NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, request_id) REFERENCES maintenance_requests (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, assignment_id) REFERENCES maintenance_assignments (company_id, id),
  CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at),
  CHECK (cost IS NULL OR currency_code IS NOT NULL)
);

-- Recurring planned maintenance (servicing, safety checks). RRULE per RFC 5545,
-- evaluated in the property's timezone.
CREATE TABLE planned_maintenance (
  id                   uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id           uuid         NOT NULL,
  property_id          uuid         NOT NULL,
  unit_id              uuid,
  title                text         NOT NULL,
  category_code        text         NOT NULL,
  recurrence_rule      text         NOT NULL,
  next_due_on          date         NOT NULL,
  lead_time_days       smallint     NOT NULL DEFAULT 14 CHECK (lead_time_days >= 0),
  supplier_contact_id  uuid,
  sla_policy_id        uuid         REFERENCES sla_policies (id),
  is_active            boolean      NOT NULL DEFAULT true,
  created_at           timestamptz  NOT NULL DEFAULT now(),
  updated_at           timestamptz  NOT NULL DEFAULT now(),
  version              integer      NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, property_id) REFERENCES properties (company_id, id),
  FOREIGN KEY (company_id, unit_id) REFERENCES units (company_id, id),
  FOREIGN KEY (company_id, supplier_contact_id) REFERENCES contacts (company_id, id)
);
CREATE INDEX planned_maintenance_due_idx ON planned_maintenance (company_id, next_due_on) WHERE is_active;

ALTER TABLE maintenance_requests
  ADD FOREIGN KEY (company_id, planned_maintenance_id) REFERENCES planned_maintenance (company_id, id);
