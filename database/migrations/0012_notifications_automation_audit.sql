-- =============================================================================
-- EstatePro · Migration 0012 · Notifications, automation, scheduled jobs,
-- audit logs, outbox, webhooks, imports/exports, idempotency, AI usage
-- =============================================================================

-- Creates monthly range partitions for a partitioned table, from the month of
-- p_from for p_months months. Run by a monthly maintenance job (and here).
CREATE OR REPLACE FUNCTION app.ensure_monthly_partitions(p_table regclass, p_from date, p_months integer)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  m date := date_trunc('month', p_from)::date;
  part text;
BEGIN
  FOR i IN 0 .. p_months - 1 LOOP
    part := format('%s_%s', p_table::text, to_char(m + make_interval(months => i), 'YYYYMM'));
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
                   part, p_table, m + make_interval(months => i), m + make_interval(months => i + 1));
  END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- Notifications (in-app) and outbound message deliveries
-- -----------------------------------------------------------------------------
CREATE TABLE notifications (
  id                 uuid         NOT NULL DEFAULT app.uuid_v7(),
  company_id         uuid         NOT NULL,
  membership_id      uuid         NOT NULL,      -- recipient
  notification_type  text         NOT NULL,      -- lease.expiring, rent.overdue, lead.assigned, …
  title              text         NOT NULL,
  body               text,
  severity           text         NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'action_required', 'warning', 'critical')),
  entity_type        text,
  entity_id          uuid,
  action_url         text,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  read_at            timestamptz,
  dismissed_at       timestamptz,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX notifications_inbox_idx ON notifications (company_id, membership_id, created_at DESC) WHERE read_at IS NULL;
CREATE TABLE notifications_default PARTITION OF notifications DEFAULT;
DO $$ BEGIN PERFORM app.ensure_monthly_partitions('notifications', current_date, 3); END $$;

CREATE TABLE notification_preferences (
  company_id         uuid     NOT NULL,
  membership_id      uuid     NOT NULL,
  notification_type  text     NOT NULL,
  channel            text     NOT NULL CHECK (channel IN ('in_app', 'email', 'sms', 'whatsapp', 'push')),
  is_enabled         boolean  NOT NULL DEFAULT true,
  quiet_hours        jsonb,   -- {"start": "21:00", "end": "07:00"} in the user's timezone
  PRIMARY KEY (company_id, membership_id, notification_type, channel),
  FOREIGN KEY (company_id, membership_id) REFERENCES company_memberships (company_id, id) ON DELETE CASCADE
);

CREATE TABLE message_deliveries (
  id                   uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id           uuid         NOT NULL,
  channel              text         NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp', 'push')),
  template_code        text,
  recipient_contact_id uuid,
  recipient_membership_id uuid,
  recipient_address    text         NOT NULL,     -- email / E.164 number
  subject              text,
  provider             text,
  provider_message_id  text,
  status               text         NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued', 'sent', 'delivered', 'failed', 'bounced', 'suppressed')),
  attempts             smallint     NOT NULL DEFAULT 0,
  last_error           text,
  entity_type          text,
  entity_id            uuid,
  idempotency_key      text,
  queued_at            timestamptz  NOT NULL DEFAULT now(),
  sent_at              timestamptz,
  delivered_at         timestamptz,
  UNIQUE (company_id, id),
  UNIQUE (company_id, idempotency_key),
  FOREIGN KEY (company_id, recipient_contact_id) REFERENCES contacts (company_id, id),
  FOREIGN KEY (company_id, recipient_membership_id) REFERENCES company_memberships (company_id, id)
);
CREATE INDEX message_deliveries_entity_idx ON message_deliveries (company_id, entity_type, entity_id);
CREATE INDEX message_deliveries_retry_idx ON message_deliveries (status, queued_at) WHERE status IN ('queued', 'failed');
CREATE UNIQUE INDEX message_deliveries_provider_idx ON message_deliveries (provider, provider_message_id) WHERE provider_message_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Automation rules and timezone-aware scheduled jobs
-- -----------------------------------------------------------------------------
CREATE TABLE automation_rules (
  id              uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id      uuid         NOT NULL,
  name            text         NOT NULL,
  trigger_type    text         NOT NULL CHECK (trigger_type IN ('event', 'date_offset', 'schedule')),
  -- event:       {"event": "lead.created"}
  -- date_offset: {"entity": "lease", "date_field": "end_date", "offset_days": -90}
  -- schedule:    {"rrule": "FREQ=DAILY;BYHOUR=8"}
  trigger_config  jsonb        NOT NULL,
  conditions      jsonb        NOT NULL DEFAULT '[]'::jsonb,
  actions         jsonb        NOT NULL,    -- [{"type": "create_task", ...}, {"type": "send_message", ...}]
  is_system       boolean      NOT NULL DEFAULT false,   -- built-in reminder, editable but not deletable
  is_active       boolean      NOT NULL DEFAULT true,
  created_by      uuid,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  version         integer      NOT NULL DEFAULT 1,
  UNIQUE (company_id, id),
  CHECK (jsonb_typeof(actions) = 'array' AND jsonb_array_length(actions) > 0)
);
CREATE INDEX automation_rules_active_idx ON automation_rules (company_id, trigger_type) WHERE is_active;

ALTER TABLE tasks ADD FOREIGN KEY (company_id, automation_rule_id) REFERENCES automation_rules (company_id, id);

-- A job due at a local date/time in a specific timezone (the property's or
-- office's). run_at is computed in UTC from local_due + timezone, and recomputed
-- if the timezone's rules change. idempotency_key prevents duplicate reminders.
CREATE TABLE scheduled_jobs (
  id               uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id       uuid         NOT NULL,
  job_type         text         NOT NULL,     -- lease_expiry_reminder, rent_due_reminder, rent_run, sla_check, …
  automation_rule_id uuid,
  entity_type      text,
  entity_id        uuid,
  local_due        timestamp    NOT NULL,     -- wall-clock time in `timezone`
  timezone         text         NOT NULL,
  run_at           timestamptz  NOT NULL,
  idempotency_key  text         NOT NULL,
  payload          jsonb        NOT NULL DEFAULT '{}'::jsonb,
  status           text         NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed', 'cancelled', 'skipped')),
  attempts         smallint     NOT NULL DEFAULT 0,
  max_attempts     smallint     NOT NULL DEFAULT 5,
  locked_until     timestamptz,
  last_error       text,
  completed_at     timestamptz,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, idempotency_key),
  FOREIGN KEY (company_id, automation_rule_id) REFERENCES automation_rules (company_id, id)
);
CREATE INDEX scheduled_jobs_due_idx ON scheduled_jobs (run_at) WHERE status = 'pending';
CREATE INDEX scheduled_jobs_entity_idx ON scheduled_jobs (company_id, entity_type, entity_id);

CREATE TABLE automation_runs (
  id                  uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id          uuid         NOT NULL,
  automation_rule_id  uuid         NOT NULL,
  scheduled_job_id    uuid,
  entity_type         text,
  entity_id           uuid,
  status              text         NOT NULL CHECK (status IN ('succeeded', 'failed', 'skipped')),
  result              jsonb        NOT NULL DEFAULT '{}'::jsonb,
  started_at          timestamptz  NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  FOREIGN KEY (company_id, automation_rule_id) REFERENCES automation_rules (company_id, id),
  FOREIGN KEY (company_id, scheduled_job_id) REFERENCES scheduled_jobs (company_id, id)
);
CREATE INDEX automation_runs_rule_idx ON automation_runs (company_id, automation_rule_id, started_at DESC);

-- -----------------------------------------------------------------------------
-- Audit log: append-only, partitioned monthly. company_id NULL = platform event.
-- -----------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id                 uuid         NOT NULL DEFAULT app.uuid_v7(),
  occurred_at        timestamptz  NOT NULL DEFAULT now(),
  company_id         uuid,
  actor_type         text         NOT NULL CHECK (actor_type IN ('user', 'portal_user', 'api_key', 'system', 'platform_staff')),
  actor_user_id      uuid,
  actor_membership_id uuid,
  api_key_id         uuid,
  support_grant_id   uuid,        -- set when platform staff act under a support grant
  action             text         NOT NULL,     -- lease.activated, contact.exported, payout.approved, auth.login_failed
  entity_type        text,
  entity_id          uuid,
  -- Changed fields: {"field": {"old": …, "new": …}}; sensitive values masked.
  changes            jsonb,
  metadata           jsonb        NOT NULL DEFAULT '{}'::jsonb,
  ip_address         inet,
  user_agent         text,
  request_id         text,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX audit_logs_company_time_idx ON audit_logs (company_id, occurred_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (company_id, entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (company_id, actor_user_id, occurred_at DESC);
CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;
DO $$ BEGIN PERFORM app.ensure_monthly_partitions('audit_logs', current_date, 3); END $$;

CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- -----------------------------------------------------------------------------
-- Transactional outbox: domain events written in the same transaction as the
-- change, then published by a relay to queues, webhooks and read models.
-- -----------------------------------------------------------------------------
CREATE TABLE outbox_events (
  id              uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id      uuid         NOT NULL,
  event_type      text         NOT NULL,      -- deal.stage_changed, lease.activated, …
  aggregate_type  text         NOT NULL,
  aggregate_id    uuid         NOT NULL,
  payload         jsonb        NOT NULL,
  occurred_at     timestamptz  NOT NULL DEFAULT now(),
  published_at    timestamptz,
  attempts        smallint     NOT NULL DEFAULT 0,
  last_error      text
);
CREATE INDEX outbox_events_unpublished_idx ON outbox_events (occurred_at) WHERE published_at IS NULL;

-- -----------------------------------------------------------------------------
-- Integrations
-- -----------------------------------------------------------------------------
CREATE TABLE webhook_endpoints (
  id                uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id        uuid         NOT NULL,
  url               text         NOT NULL CHECK (url ~ '^https://'),
  description       text,
  event_types       text[]       NOT NULL,
  secret_encrypted  bytea        NOT NULL,
  is_active         boolean      NOT NULL DEFAULT true,
  disabled_reason   text,
  created_by        uuid,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (company_id, id)
);

CREATE TABLE webhook_deliveries (
  id                   uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id           uuid         NOT NULL,
  webhook_endpoint_id  uuid         NOT NULL,
  outbox_event_id      uuid         NOT NULL,
  status               text         NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'abandoned')),
  attempts             smallint     NOT NULL DEFAULT 0,
  next_attempt_at      timestamptz,
  response_status      smallint,
  last_error           text,
  created_at           timestamptz  NOT NULL DEFAULT now(),
  delivered_at         timestamptz,
  UNIQUE (company_id, webhook_endpoint_id, outbox_event_id),
  FOREIGN KEY (company_id, webhook_endpoint_id) REFERENCES webhook_endpoints (company_id, id) ON DELETE CASCADE
);
CREATE INDEX webhook_deliveries_retry_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';

CREATE TABLE import_jobs (
  id                  uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id          uuid         NOT NULL,
  import_type         text         NOT NULL CHECK (import_type IN ('contacts', 'properties', 'units', 'listings', 'leases',
                                                                   'opening_balances', 'bank_statement', 'leads')),
  status              text         NOT NULL DEFAULT 'uploaded'
                        CHECK (status IN ('uploaded', 'validating', 'validated', 'importing', 'completed', 'failed', 'cancelled')),
  is_dry_run          boolean      NOT NULL DEFAULT true,
  source_storage_key  text         NOT NULL,
  error_storage_key   text,
  rows_total          integer,
  rows_valid          integer,
  rows_imported       integer,
  rows_failed         integer,
  mapping             jsonb        NOT NULL DEFAULT '{}'::jsonb,
  requested_by        uuid         NOT NULL,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, requested_by) REFERENCES company_memberships (company_id, id)
);

ALTER TABLE bank_statement_lines ADD FOREIGN KEY (company_id, import_job_id) REFERENCES import_jobs (company_id, id);

CREATE TABLE export_jobs (
  id                 uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id         uuid         NOT NULL,
  export_type        text         NOT NULL,     -- report key, entity list, full_company_export
  format             text         NOT NULL CHECK (format IN ('csv', 'xlsx', 'pdf', 'json', 'zip')),
  parameters         jsonb        NOT NULL DEFAULT '{}'::jsonb,
  status             text         NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'expired')),
  storage_key        text,
  row_count          integer,
  expires_at         timestamptz,
  requested_by       uuid         NOT NULL,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, requested_by) REFERENCES company_memberships (company_id, id)
);

-- API idempotency: replays return the stored response.
CREATE TABLE idempotency_keys (
  company_id       uuid         NOT NULL,
  key              text         NOT NULL,
  request_method   text         NOT NULL,
  request_path     text         NOT NULL,
  request_hash     bytea        NOT NULL,
  response_status  smallint,
  response_body    jsonb,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  expires_at       timestamptz  NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (company_id, key)
);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

-- EstateAI usage (Phase 13). Prompts are not stored by default; outputs are
-- drafts until a user accepts them.
CREATE TABLE ai_requests (
  id               uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id       uuid         NOT NULL,
  membership_id    uuid         NOT NULL,
  feature          text         NOT NULL CHECK (feature IN ('listing_description', 'listing_review', 'follow_up_draft',
                                                             'market_summary', 'maintenance_summary')),
  entity_type      text,
  entity_id        uuid,
  model            text         NOT NULL,
  input_tokens     integer      CHECK (input_tokens >= 0),
  output_tokens    integer      CHECK (output_tokens >= 0),
  status           text         NOT NULL CHECK (status IN ('succeeded', 'failed', 'blocked')),
  outcome          text         CHECK (outcome IN ('accepted', 'edited', 'discarded')),
  created_at       timestamptz  NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, membership_id) REFERENCES company_memberships (company_id, id)
);
CREATE INDEX ai_requests_usage_idx ON ai_requests (company_id, created_at);
