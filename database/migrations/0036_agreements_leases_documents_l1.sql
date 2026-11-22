-- =============================================================================
-- EstatePro · Migration 0036 · Management agreements, leases and documents (L1)
-- =============================================================================
-- Phase 7 milestone L1 (readiness report §5.1, §11; wireframes MA-1, MA-2,
-- LS-1 to LS-5; verification report W7-A1):
--
--  1. Documents: upload sessions for document files (scanned before use), and
--     the scan result rule on document versions (pending → clean, infected or
--     failed, then final).
--  2. Management agreements: draft → active → suspended → active, or ended;
--     the instruction's terms are fixed once activated; one live agreement per
--     unit; an agreement with live leases cannot end; drafts only are deleted.
--  3. Leases: the life cycle (draft → pending signature → active → periodic or
--     notice given → ended → closed; draft or pending signature → cancelled;
--     imported leases may be inserted live, with the activation checks);
--     terms fixed once active; an activated lease names an active agreement
--     that covers its unit, if any, and a clean signed document, if any;
--     parties are removed or changed only before activation (portal access
--     aside); drafts only are deleted.
--  4. Letting deals: the lease records its deal. A letting deal moves to
--     "lease signing" (contract) once a lease is drawn up from it, and is won
--     ("let agreed") once that lease is active (replacing the S3 rule that
--     letting deals stop at "terms agreed", P6-D2).
-- The database tests are database/tests/19_agreements_leases_l1.sql.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Documents
-- -----------------------------------------------------------------------------
CREATE TABLE document_upload_sessions (
  id                  uuid         PRIMARY KEY DEFAULT app.uuid_v7(),
  company_id          uuid         NOT NULL,
  entity_type         text         NOT NULL CHECK (entity_type IN ('lease', 'management_agreement')),
  entity_id           uuid         NOT NULL,
  title               text         NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  document_type_code  text         NOT NULL,
  category            text         NOT NULL CHECK (category IN ('legal', 'financial', 'compliance', 'identity', 'property', 'correspondence', 'media', 'other')),
  is_signed           boolean      NOT NULL DEFAULT false,
  file_name           text         NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 200),
  declared_mime       text         NOT NULL,
  declared_size       bigint       NOT NULL CHECK (declared_size > 0),
  sha256              bytea        NOT NULL CHECK (octet_length(sha256) = 32),
  storage_key         text         NOT NULL UNIQUE,
  status              text         NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'expired', 'cancelled')),
  document_id         uuid,
  expires_at          timestamptz  NOT NULL,
  created_by          uuid         NOT NULL,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, document_id) REFERENCES documents (company_id, id),
  FOREIGN KEY (company_id, created_by) REFERENCES company_memberships (company_id, id)
);
COMMENT ON TABLE document_upload_sessions IS 'Document uploads between the signed URL and confirmation (W7-A1); the file is scanned before the document can be used';
CREATE INDEX document_upload_sessions_pending_idx ON document_upload_sessions (expires_at) WHERE status = 'pending';
CREATE INDEX document_upload_sessions_document_idx ON document_upload_sessions (company_id, document_id) WHERE document_id IS NOT NULL;
CREATE INDEX document_upload_sessions_created_by_idx ON document_upload_sessions (company_id, created_by);
ALTER TABLE document_upload_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON document_upload_sessions FOR ALL TO estatepro_app
  USING (company_id = app.current_company_id()) WITH CHECK (company_id = app.current_company_id());
GRANT SELECT, INSERT, UPDATE ON document_upload_sessions TO estatepro_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON document_upload_sessions TO estatepro_platform;  -- as upload_sessions (0018)

-- A scan result is recorded once: pending → clean, infected or failed.
CREATE FUNCTION app.document_versions_scan_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.scan_status IS DISTINCT FROM OLD.scan_status AND OLD.scan_status <> 'pending' THEN
    RAISE EXCEPTION 'the scan result of a document version is final (%)', OLD.scan_status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.scan_status <> 'pending' AND NEW.scanned_at IS NULL THEN
    NEW.scanned_at := now();
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER document_versions_scan_guard BEFORE UPDATE ON document_versions
  FOR EACH ROW EXECUTE FUNCTION app.document_versions_scan_guard();

-- Whether a document's current version passed the malware scan.
CREATE FUNCTION app.document_is_clean(p_company uuid, p_document uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT v.scan_status = 'clean'
                     FROM documents d JOIN document_versions v ON v.company_id = d.company_id AND v.id = d.current_version_id
                    WHERE d.company_id = p_company AND d.id = p_document), false)
$$;

-- -----------------------------------------------------------------------------
-- 2. Management agreements
-- -----------------------------------------------------------------------------
-- Whether two agreements cover the same unit (the same unit, or either is the whole property).
CREATE FUNCTION app.agreements_overlap(p_company uuid, p_id uuid, p_property uuid, p_unit uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM management_agreements m
                  WHERE m.company_id = p_company AND m.id <> p_id AND m.property_id = p_property
                    AND m.status IN ('active', 'suspended')
                    AND (m.unit_id IS NULL OR p_unit IS NULL OR m.unit_id = p_unit))
$$;

CREATE FUNCTION app.management_agreements_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  fixed text[] := ARRAY['reference', 'landlord_contact_id', 'property_id', 'unit_id', 'service_level', 'currency_code', 'fee_basis',
                        'fee_percent', 'fee_fixed_amount', 'letting_fee_terms', 'fee_tax_code_id', 'start_date', 'created_at'];
  col text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'management agreement % is % and cannot be deleted; end it instead', OLD.reference, OLD.status
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  -- Imported agreements may arrive live; the same checks as activation apply.
  IF TG_OP = 'INSERT' THEN
    IF NEW.unit_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM units u WHERE u.company_id = NEW.company_id AND u.id = NEW.unit_id AND u.property_id = NEW.property_id) THEN
      RAISE EXCEPTION 'the unit is not part of the property' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status IN ('active', 'suspended') AND app.agreements_overlap(NEW.company_id, NEW.id, NEW.property_id, NEW.unit_id) THEN
      RAISE EXCEPTION 'another live management agreement covers this unit' USING ERRCODE = 'check_violation', DETAIL = 'agreement-overlap';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'draft' THEN
    FOREACH col IN ARRAY fixed LOOP
      IF to_jsonb(OLD) -> col IS DISTINCT FROM to_jsonb(NEW) -> col THEN
        RAISE EXCEPTION 'management agreement % is %: % cannot change; end it and make a new agreement', OLD.reference, OLD.status, col
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END LOOP;
  ELSIF NEW.unit_id IS DISTINCT FROM OLD.unit_id OR NEW.property_id IS DISTINCT FROM OLD.property_id THEN
    IF NEW.unit_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM units u WHERE u.company_id = NEW.company_id AND u.id = NEW.unit_id AND u.property_id = NEW.property_id) THEN
      RAISE EXCEPTION 'the unit is not part of the property' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'draft' AND NEW.status = 'active')
            OR (OLD.status = 'active' AND NEW.status IN ('suspended', 'ended'))
            OR (OLD.status = 'suspended' AND NEW.status IN ('active', 'ended'))) THEN
      RAISE EXCEPTION 'a % management agreement cannot become %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'active' THEN
      IF app.agreements_overlap(NEW.company_id, NEW.id, NEW.property_id, NEW.unit_id) THEN
        RAISE EXCEPTION 'another live management agreement covers this unit' USING ERRCODE = 'check_violation', DETAIL = 'agreement-overlap';
      END IF;
      IF NEW.document_id IS NOT NULL AND NOT app.document_is_clean(NEW.company_id, NEW.document_id) THEN
        RAISE EXCEPTION 'the agreement document has not passed the security scan' USING ERRCODE = 'check_violation', DETAIL = 'document-not-clean';
      END IF;
    END IF;
    IF NEW.status = 'ended' THEN
      IF EXISTS (SELECT 1 FROM leases l WHERE l.company_id = NEW.company_id AND l.management_agreement_id = NEW.id
                    AND l.status IN ('pending_signature', 'active', 'periodic', 'notice_given')) THEN
        RAISE EXCEPTION 'management agreement % has live leases; end them first', OLD.reference USING ERRCODE = 'check_violation', DETAIL = 'agreement-has-live-leases';
      END IF;
      IF NEW.end_date IS NULL THEN
        RAISE EXCEPTION 'an ended agreement records its end date' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF NEW.document_id IS DISTINCT FROM OLD.document_id AND NEW.document_id IS NOT NULL AND NEW.status <> 'draft'
     AND NOT app.document_is_clean(NEW.company_id, NEW.document_id) THEN
    RAISE EXCEPTION 'the agreement document has not passed the security scan' USING ERRCODE = 'check_violation', DETAIL = 'document-not-clean';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER management_agreements_guard BEFORE INSERT OR UPDATE OR DELETE ON management_agreements
  FOR EACH ROW EXECUTE FUNCTION app.management_agreements_guard();

-- -----------------------------------------------------------------------------
-- 3. Leases
-- -----------------------------------------------------------------------------
ALTER TABLE leases ADD COLUMN deal_id uuid;
ALTER TABLE leases ADD CONSTRAINT leases_deal_fk FOREIGN KEY (company_id, deal_id) REFERENCES deals (company_id, id);
CREATE UNIQUE INDEX leases_one_per_deal_idx ON leases (company_id, deal_id) WHERE deal_id IS NOT NULL AND status <> 'cancelled';
CREATE INDEX leases_agreement_idx ON leases (company_id, management_agreement_id) WHERE management_agreement_id IS NOT NULL;
CREATE INDEX leases_status_idx ON leases (company_id, status, start_date DESC);
COMMENT ON COLUMN leases.deal_id IS 'The letting deal the lease was drawn up from (P7-D4)';

CREATE FUNCTION app.leases_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  fixed text[] := ARRAY['reference', 'unit_id', 'listing_id', 'previous_lease_id', 'deal_id', 'jurisdiction_code', 'lease_type', 'usage',
                        'start_date', 'currency_code', 'rent_amount', 'rent_frequency', 'rent_due_day', 'advance_periods',
                        'prorate_first_period', 'rent_tax_code_id', 'deposit_amount', 'notice_period_days', 'break_clause_date',
                        'break_notice_days', 'template_id', 'governing_locale_code', 'signed_at', 'document_id', 'created_by', 'created_at'];
  col text;
  agreement management_agreements%ROWTYPE;
  unit_property uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'lease % is % and cannot be deleted; cancel or end it instead', OLD.reference, OLD.status
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status NOT IN ('draft', 'pending_signature') THEN
      FOREACH col IN ARRAY fixed LOOP
        IF to_jsonb(OLD) -> col IS DISTINCT FROM to_jsonb(NEW) -> col THEN
          RAISE EXCEPTION 'lease % is %: % cannot change; use a rent review, a renewal or notice', OLD.reference, OLD.status, col
            USING ERRCODE = 'insufficient_privilege';
        END IF;
      END LOOP;
      -- The end date moves only with notice (L4).
      IF NEW.end_date IS DISTINCT FROM OLD.end_date AND NOT (NEW.status = 'notice_given' AND OLD.status IN ('active', 'periodic')) THEN
        RAISE EXCEPTION 'lease % is %: the end date changes only when notice is given', OLD.reference, OLD.status
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
         (OLD.status = 'draft' AND NEW.status IN ('pending_signature', 'cancelled'))
      OR (OLD.status = 'pending_signature' AND NEW.status IN ('draft', 'active', 'cancelled'))
      OR (OLD.status = 'active' AND NEW.status IN ('periodic', 'notice_given', 'ended'))
      OR (OLD.status = 'periodic' AND NEW.status IN ('notice_given', 'ended'))
      OR (OLD.status = 'notice_given' AND NEW.status IN ('active', 'periodic', 'ended'))
      OR (OLD.status = 'ended' AND NEW.status = 'closed')) THEN
      RAISE EXCEPTION 'a % lease cannot become %', OLD.status, NEW.status USING ERRCODE = 'check_violation', DETAIL = 'lease-transition';
    END IF;
  END IF;
  -- The agreement, if any, covers the lease's unit.
  IF NEW.management_agreement_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.management_agreement_id IS DISTINCT FROM OLD.management_agreement_id OR NEW.unit_id IS DISTINCT FROM OLD.unit_id) THEN
    SELECT * INTO agreement FROM management_agreements WHERE company_id = NEW.company_id AND id = NEW.management_agreement_id;
    SELECT property_id INTO unit_property FROM units WHERE company_id = NEW.company_id AND id = NEW.unit_id;
    IF agreement.property_id IS DISTINCT FROM unit_property OR (agreement.unit_id IS NOT NULL AND agreement.unit_id <> NEW.unit_id) THEN
      RAISE EXCEPTION 'the management agreement does not cover this unit' USING ERRCODE = 'check_violation', DETAIL = 'agreement-unit';
    END IF;
    IF agreement.status = 'ended' THEN
      RAISE EXCEPTION 'management agreement % has ended', agreement.reference USING ERRCODE = 'check_violation', DETAIL = 'agreement-ended';
    END IF;
  END IF;
  -- Activation, or an imported live lease: the same checks.
  IF (TG_OP = 'UPDATE' AND NEW.status = 'active' AND OLD.status = 'pending_signature')
     OR (TG_OP = 'INSERT' AND NEW.status IN ('active', 'periodic', 'notice_given')) THEN
    IF NEW.management_agreement_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM management_agreements m WHERE m.company_id = NEW.company_id AND m.id = NEW.management_agreement_id AND m.status = 'active') THEN
      RAISE EXCEPTION 'the management agreement is not active' USING ERRCODE = 'check_violation', DETAIL = 'agreement-not-active';
    END IF;
    IF NEW.document_id IS NOT NULL AND NOT app.document_is_clean(NEW.company_id, NEW.document_id) THEN
      RAISE EXCEPTION 'the signed lease has not passed the security scan' USING ERRCODE = 'check_violation', DETAIL = 'document-not-clean';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER leases_guard BEFORE INSERT OR UPDATE OR DELETE ON leases
  FOR EACH ROW EXECUTE FUNCTION app.leases_guard();

-- Parties are removed or changed only before activation; afterwards only portal
-- access changes (a change of tenant is a new lease or a renewal).
CREATE FUNCTION app.lease_parties_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lease_status text;
BEGIN
  SELECT status INTO lease_status FROM leases
   WHERE company_id = coalesce(NEW.company_id, OLD.company_id) AND id = coalesce(NEW.lease_id, OLD.lease_id);
  IF lease_status IS NULL OR lease_status IN ('draft', 'pending_signature') THEN
    RETURN coalesce(NEW, OLD);
  END IF;
  -- Adding a party to a live lease is an API decision (imports add them after
  -- the lease row); removing or changing one is never allowed here.
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(OLD) - 'portal_access') = (to_jsonb(NEW) - 'portal_access') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'the parties of a % lease are fixed', lease_status USING ERRCODE = 'insufficient_privilege';
END
$$;
CREATE TRIGGER lease_parties_guard BEFORE INSERT OR UPDATE OR DELETE ON lease_parties
  FOR EACH ROW EXECUTE FUNCTION app.lease_parties_guard();

-- -----------------------------------------------------------------------------
-- 4. Letting deals follow their lease (replaces migration 0033's function)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.deals_stage_rules() RETURNS trigger
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
  -- Lettings (P7-D4): "lease signing" once a lease is drawn up from the deal; "let agreed" once it is active.
  IF NEW.deal_type = 'letting' AND to_class = 'contract' AND NOT EXISTS (
       SELECT 1 FROM leases l WHERE l.company_id = NEW.company_id AND l.deal_id = NEW.id AND l.status <> 'cancelled') THEN
    RAISE EXCEPTION 'a letting deal moves to lease signing once a lease is drawn up from it'
      USING ERRCODE = 'check_violation', DETAIL = 'letting-needs-lease';
  END IF;
  IF NEW.deal_type = 'letting' AND to_class = 'closed_won' AND NOT EXISTS (
       SELECT 1 FROM leases l WHERE l.company_id = NEW.company_id AND l.deal_id = NEW.id
          AND l.status IN ('active', 'periodic', 'notice_given', 'ended', 'closed')) THEN
    RAISE EXCEPTION 'a letting deal is won once its lease is active'
      USING ERRCODE = 'check_violation', DETAIL = 'letting-lease-not-active';
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
