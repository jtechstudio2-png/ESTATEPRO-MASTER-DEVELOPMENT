-- =============================================================================
-- EstatePro · Migration 0015 · Indexes for company-scoped foreign keys
-- =============================================================================
-- Every (company_id, <fk>) reference between business tables gets an index whose
-- leading columns match it. They serve record-detail lookups ("this contact's
-- requirements", "this lease's rent reviews") and keep parent-row FK checks
-- cheap. Nullable references use partial indexes to stay small.
--
-- Intentionally NOT indexed: references to fixed reference data (currencies,
-- countries, locales, jurisdictions, roles, property types, stages, SLA
-- policies, tax codes, templates), to documents, and staff "who did it" columns
-- (created_by, approved_by, …). Their parent rows are not deleted, and they are
-- not used as lookup paths. Add an index when a query plan shows the need.
-- =============================================================================

CREATE INDEX automation_runs_scheduled_job_id_fk_idx ON automation_runs (company_id, scheduled_job_id) WHERE scheduled_job_id IS NOT NULL;
CREATE INDEX bank_accounts_office_id_fk_idx ON bank_accounts (company_id, office_id) WHERE office_id IS NOT NULL;
CREATE INDEX bank_statement_lines_import_job_id_fk_idx ON bank_statement_lines (company_id, import_job_id) WHERE import_job_id IS NOT NULL;
CREATE INDEX bank_statement_lines_matched_payment_id_fk_idx ON bank_statement_lines (company_id, matched_payment_id) WHERE matched_payment_id IS NOT NULL;
CREATE INDEX bank_statement_lines_matched_transaction_id_fk_idx ON bank_statement_lines (company_id, matched_transaction_id) WHERE matched_transaction_id IS NOT NULL;
CREATE INDEX commissions_adjusts_commission_id_fk_idx ON commissions (company_id, adjusts_commission_id) WHERE adjusts_commission_id IS NOT NULL;
CREATE INDEX commissions_commission_plan_id_fk_idx ON commissions (company_id, commission_plan_id) WHERE commission_plan_id IS NOT NULL;
CREATE INDEX commissions_lease_id_fk_idx ON commissions (company_id, lease_id) WHERE lease_id IS NOT NULL;
CREATE INDEX commissions_sales_transaction_id_fk_idx ON commissions (company_id, sales_transaction_id) WHERE sales_transaction_id IS NOT NULL;
CREATE INDEX company_memberships_contact_id_fk_idx ON company_memberships (company_id, contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX contact_links_related_contact_id_fk_idx ON contact_links (company_id, related_contact_id);
CREATE INDEX contact_methods_contact_id_fk_idx ON contact_methods (company_id, contact_id);
CREATE INDEX contacts_address_id_fk_idx ON contacts (company_id, address_id) WHERE address_id IS NOT NULL;
CREATE INDEX contacts_merged_into_contact_id_fk_idx ON contacts (company_id, merged_into_contact_id) WHERE merged_into_contact_id IS NOT NULL;
CREATE INDEX contacts_office_id_fk_idx ON contacts (company_id, office_id) WHERE office_id IS NOT NULL;
CREATE INDEX deals_lead_id_fk_idx ON deals (company_id, lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX deals_office_id_fk_idx ON deals (company_id, office_id);
CREATE INDEX deals_unit_id_fk_idx ON deals (company_id, unit_id) WHERE unit_id IS NOT NULL;
CREATE INDEX deposit_deductions_deposit_id_fk_idx ON deposit_deductions (company_id, deposit_id);
CREATE INDEX deposits_holding_account_id_fk_idx ON deposits (company_id, holding_account_id) WHERE holding_account_id IS NOT NULL;
CREATE INDEX deposits_received_payment_id_fk_idx ON deposits (company_id, received_payment_id) WHERE received_payment_id IS NOT NULL;
CREATE INDEX development_phases_development_id_fk_idx ON development_phases (company_id, development_id);
CREATE INDEX developments_address_id_fk_idx ON developments (company_id, address_id) WHERE address_id IS NOT NULL;
CREATE INDEX developments_developer_contact_id_fk_idx ON developments (company_id, developer_contact_id) WHERE developer_contact_id IS NOT NULL;
CREATE INDEX document_versions_uploaded_by_contact_id_fk_idx ON document_versions (company_id, uploaded_by_contact_id) WHERE uploaded_by_contact_id IS NOT NULL;
CREATE INDEX documents_current_version_id_fk_idx ON documents (company_id, current_version_id) WHERE current_version_id IS NOT NULL;
CREATE INDEX finance_transactions_bank_account_id_fk_idx ON finance_transactions (company_id, bank_account_id) WHERE bank_account_id IS NOT NULL;
CREATE INDEX finance_transactions_commission_id_fk_idx ON finance_transactions (company_id, commission_id) WHERE commission_id IS NOT NULL;
CREATE INDEX finance_transactions_deal_id_fk_idx ON finance_transactions (company_id, deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX finance_transactions_lease_id_fk_idx ON finance_transactions (company_id, lease_id) WHERE lease_id IS NOT NULL;
CREATE INDEX finance_transactions_maintenance_request_id_fk_idx ON finance_transactions (company_id, maintenance_request_id) WHERE maintenance_request_id IS NOT NULL;
CREATE INDEX finance_transactions_office_id_fk_idx ON finance_transactions (company_id, office_id) WHERE office_id IS NOT NULL;
CREATE INDEX finance_transactions_payment_id_fk_idx ON finance_transactions (company_id, payment_id) WHERE payment_id IS NOT NULL;
CREATE INDEX finance_transactions_supplier_invoice_id_fk_idx ON finance_transactions (company_id, supplier_invoice_id) WHERE supplier_invoice_id IS NOT NULL;
CREATE INDEX finance_transactions_unit_id_fk_idx ON finance_transactions (company_id, unit_id) WHERE unit_id IS NOT NULL;
CREATE INDEX identity_documents_contact_id_fk_idx ON identity_documents (company_id, contact_id);
CREATE INDEX inspections_lease_id_fk_idx ON inspections (company_id, lease_id) WHERE lease_id IS NOT NULL;
CREATE INDEX inspections_property_id_fk_idx ON inspections (company_id, property_id);
CREATE INDEX inspections_unit_id_fk_idx ON inspections (company_id, unit_id) WHERE unit_id IS NOT NULL;
CREATE INDEX invitations_contact_id_fk_idx ON invitations (company_id, contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX key_movements_holder_contact_id_fk_idx ON key_movements (company_id, holder_contact_id) WHERE holder_contact_id IS NOT NULL;
CREATE INDEX key_sets_property_id_fk_idx ON key_sets (company_id, property_id);
CREATE INDEX key_sets_unit_id_fk_idx ON key_sets (company_id, unit_id) WHERE unit_id IS NOT NULL;
CREATE INDEX kyc_checks_deal_id_fk_idx ON kyc_checks (company_id, deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX leads_converted_deal_id_fk_idx ON leads (company_id, converted_deal_id) WHERE converted_deal_id IS NOT NULL;
CREATE INDEX leads_listing_id_fk_idx ON leads (company_id, listing_id) WHERE listing_id IS NOT NULL;
CREATE INDEX leads_requirement_id_fk_idx ON leads (company_id, requirement_id) WHERE requirement_id IS NOT NULL;
CREATE INDEX leases_listing_id_fk_idx ON leases (company_id, listing_id) WHERE listing_id IS NOT NULL;
CREATE INDEX leases_management_agreement_id_fk_idx ON leases (company_id, management_agreement_id) WHERE management_agreement_id IS NOT NULL;
CREATE INDEX leases_previous_lease_id_fk_idx ON leases (company_id, previous_lease_id) WHERE previous_lease_id IS NOT NULL;
CREATE INDEX ledger_entries_contact_id_fk_idx ON ledger_entries (company_id, contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX ledger_entries_finance_transaction_id_fk_idx ON ledger_entries (company_id, finance_transaction_id) WHERE finance_transaction_id IS NOT NULL;
CREATE INDEX ledger_entries_lease_id_fk_idx ON ledger_entries (company_id, lease_id) WHERE lease_id IS NOT NULL;
CREATE INDEX ledger_entries_payment_allocation_id_fk_idx ON ledger_entries (company_id, payment_allocation_id) WHERE payment_allocation_id IS NOT NULL;
CREATE INDEX ledger_entries_rent_charge_id_fk_idx ON ledger_entries (company_id, rent_charge_id) WHERE rent_charge_id IS NOT NULL;
CREATE INDEX ledger_entries_reversal_of_id_fk_idx ON ledger_entries (company_id, reversal_of_id) WHERE reversal_of_id IS NOT NULL;
CREATE INDEX listings_office_id_fk_idx ON listings (company_id, office_id);
CREATE INDEX maintenance_quotes_supplier_contact_id_fk_idx ON maintenance_quotes (company_id, supplier_contact_id);
CREATE INDEX maintenance_requests_approved_by_contact_id_fk_idx ON maintenance_requests (company_id, approved_by_contact_id) WHERE approved_by_contact_id IS NOT NULL;
CREATE INDEX maintenance_requests_duplicate_of_id_fk_idx ON maintenance_requests (company_id, duplicate_of_id) WHERE duplicate_of_id IS NOT NULL;
CREATE INDEX maintenance_requests_planned_maintenance_id_fk_idx ON maintenance_requests (company_id, planned_maintenance_id) WHERE planned_maintenance_id IS NOT NULL;
CREATE INDEX maintenance_requests_reported_by_contact_id_fk_idx ON maintenance_requests (company_id, reported_by_contact_id) WHERE reported_by_contact_id IS NOT NULL;
CREATE INDEX maintenance_requests_unit_id_fk_idx ON maintenance_requests (company_id, unit_id) WHERE unit_id IS NOT NULL;
CREATE INDEX maintenance_updates_author_contact_id_fk_idx ON maintenance_updates (company_id, author_contact_id) WHERE author_contact_id IS NOT NULL;
CREATE INDEX maintenance_work_logs_assignment_id_fk_idx ON maintenance_work_logs (company_id, assignment_id) WHERE assignment_id IS NOT NULL;
CREATE INDEX maintenance_work_logs_request_id_fk_idx ON maintenance_work_logs (company_id, request_id);
CREATE INDEX management_agreements_payout_account_id_fk_idx ON management_agreements (company_id, payout_account_id) WHERE payout_account_id IS NOT NULL;
CREATE INDEX management_agreements_unit_id_fk_idx ON management_agreements (company_id, unit_id) WHERE unit_id IS NOT NULL;
CREATE INDEX membership_commission_plans_commission_plan_id_fk_idx ON membership_commission_plans (company_id, commission_plan_id);
CREATE INDEX message_deliveries_recipient_contact_id_fk_idx ON message_deliveries (company_id, recipient_contact_id) WHERE recipient_contact_id IS NOT NULL;
CREATE INDEX offers_offered_by_contact_id_fk_idx ON offers (company_id, offered_by_contact_id);
CREATE INDEX offers_parent_offer_id_fk_idx ON offers (company_id, parent_offer_id) WHERE parent_offer_id IS NOT NULL;
CREATE INDEX offices_address_id_fk_idx ON offices (company_id, address_id) WHERE address_id IS NOT NULL;
CREATE INDEX payment_plans_lease_id_fk_idx ON payment_plans (company_id, lease_id);
CREATE INDEX payments_bank_account_id_fk_idx ON payments (company_id, bank_account_id);
CREATE INDEX payouts_finance_transaction_id_fk_idx ON payouts (company_id, finance_transaction_id) WHERE finance_transaction_id IS NOT NULL;
CREATE INDEX payouts_from_account_id_fk_idx ON payouts (company_id, from_account_id);
CREATE INDEX payouts_payee_contact_id_fk_idx ON payouts (company_id, payee_contact_id);
CREATE INDEX payouts_statement_id_fk_idx ON payouts (company_id, statement_id) WHERE statement_id IS NOT NULL;
CREATE INDEX payouts_supplier_invoice_id_fk_idx ON payouts (company_id, supplier_invoice_id) WHERE supplier_invoice_id IS NOT NULL;
CREATE INDEX payouts_to_account_id_fk_idx ON payouts (company_id, to_account_id);
CREATE INDEX planned_maintenance_property_id_fk_idx ON planned_maintenance (company_id, property_id);
CREATE INDEX planned_maintenance_supplier_contact_id_fk_idx ON planned_maintenance (company_id, supplier_contact_id) WHERE supplier_contact_id IS NOT NULL;
CREATE INDEX planned_maintenance_unit_id_fk_idx ON planned_maintenance (company_id, unit_id) WHERE unit_id IS NOT NULL;
CREATE INDEX properties_address_id_fk_idx ON properties (company_id, address_id);
CREATE INDEX properties_development_phase_id_fk_idx ON properties (company_id, development_phase_id) WHERE development_phase_id IS NOT NULL;
CREATE INDEX property_media_unit_id_fk_idx ON property_media (company_id, unit_id) WHERE unit_id IS NOT NULL;
CREATE INDEX property_notes_unit_id_fk_idx ON property_notes (company_id, unit_id) WHERE unit_id IS NOT NULL;
CREATE INDEX property_ownerships_unit_id_fk_idx ON property_ownerships (company_id, unit_id) WHERE unit_id IS NOT NULL;
CREATE INDEX rent_reviews_lease_id_fk_idx ON rent_reviews (company_id, lease_id);
CREATE INDEX requirements_contact_id_fk_idx ON requirements (company_id, contact_id);
CREATE INDEX sales_transactions_accepted_offer_id_fk_idx ON sales_transactions (company_id, accepted_offer_id);
CREATE INDEX sales_transactions_listing_id_fk_idx ON sales_transactions (company_id, listing_id);
CREATE INDEX sales_transactions_unit_id_fk_idx ON sales_transactions (company_id, unit_id);
CREATE INDEX scheduled_jobs_automation_rule_id_fk_idx ON scheduled_jobs (company_id, automation_rule_id) WHERE automation_rule_id IS NOT NULL;
CREATE INDEX statement_lines_ledger_entry_id_fk_idx ON statement_lines (company_id, ledger_entry_id);
CREATE INDEX subscription_invoices_subscription_id_fk_idx ON subscription_invoices (company_id, subscription_id);
CREATE INDEX supplier_invoices_maintenance_request_id_fk_idx ON supplier_invoices (company_id, maintenance_request_id) WHERE maintenance_request_id IS NOT NULL;
CREATE INDEX supplier_invoices_property_id_fk_idx ON supplier_invoices (company_id, property_id) WHERE property_id IS NOT NULL;
CREATE INDEX supplier_invoices_unit_id_fk_idx ON supplier_invoices (company_id, unit_id) WHERE unit_id IS NOT NULL;
CREATE INDEX tasks_automation_rule_id_fk_idx ON tasks (company_id, automation_rule_id) WHERE automation_rule_id IS NOT NULL;
CREATE INDEX teams_office_id_fk_idx ON teams (company_id, office_id) WHERE office_id IS NOT NULL;
CREATE INDEX viewing_attendees_contact_id_fk_idx ON viewing_attendees (company_id, contact_id);
CREATE INDEX viewings_deal_id_fk_idx ON viewings (company_id, deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX viewings_lead_id_fk_idx ON viewings (company_id, lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX viewings_rescheduled_to_id_fk_idx ON viewings (company_id, rescheduled_to_id) WHERE rescheduled_to_id IS NOT NULL;
CREATE INDEX viewings_unit_id_fk_idx ON viewings (company_id, unit_id);
