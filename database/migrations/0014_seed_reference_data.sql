-- =============================================================================
-- EstatePro · Migration 0014 · Reference and default configuration data
-- =============================================================================
-- Launch markets: Ghana, Qatar, United Kingdom. Adding a market = new rows in
-- currencies / locales / countries / jurisdictions (+ optional country-scoped
-- picklists, property types and templates). No schema change.
--
-- Deliberately NOT seeded: tax rates and legal rule values (deposit caps,
-- notice periods, deadlines). They change and must be entered after legal
-- review, with a source reference, through jurisdiction_settings / tax codes.
-- =============================================================================

INSERT INTO currencies (code, name, minor_units, symbol) VALUES
  ('GHS', 'Ghanaian cedi',     2, 'GH₵'),
  ('QAR', 'Qatari riyal',      2, 'QR'),
  ('GBP', 'Pound sterling',    2, '£'),
  ('USD', 'US dollar',         2, '$'),
  ('EUR', 'Euro',              2, '€'),
  ('AED', 'UAE dirham',        2, 'AED'),
  ('SAR', 'Saudi riyal',       2, 'SAR'),
  ('KWD', 'Kuwaiti dinar',     3, 'KD'),
  ('BHD', 'Bahraini dinar',    3, 'BD'),
  ('OMR', 'Omani rial',        3, 'OMR'),
  ('NGN', 'Nigerian naira',    2, '₦'),
  ('KES', 'Kenyan shilling',   2, 'KSh'),
  ('ZAR', 'South African rand', 2, 'R');

INSERT INTO locales (code, name, text_direction, fallback_code) VALUES
  ('en',    'English',                 'ltr', NULL),
  ('ar',    'Arabic',                  'rtl', NULL);
INSERT INTO locales (code, name, text_direction, fallback_code) VALUES
  ('en-GB', 'English (United Kingdom)', 'ltr', 'en'),
  ('en-GH', 'English (Ghana)',          'ltr', 'en'),
  ('en-QA', 'English (Qatar)',          'ltr', 'en'),
  ('ar-QA', 'Arabic (Qatar)',           'rtl', 'ar');

INSERT INTO countries (code, name, default_currency_code, default_locale_code, default_timezone,
                       phone_country_code, weekend_days, area_display_unit, address_format) VALUES
  ('GH', 'Ghana', 'GHS', 'en-GH', 'Africa/Accra', '+233', '{6,7}', 'sqm',
   '{"locality": {"label": "Town / City", "required": true},
     "admin_area_1": {"label": "Region", "required": true},
     "admin_area_2": {"label": "District"},
     "postal_code": {"label": "Postal code", "required": false},
     "local_components": [{"key": "digital_address", "label": "GhanaPost GPS address",
                           "pattern": "^[A-Z]{2}-[0-9]{3,4}-[0-9]{4}$"}]}'),
  ('QA', 'Qatar', 'QAR', 'ar-QA', 'Asia/Qatar', '+974', '{5,6}', 'sqm',
   '{"locality": {"label": "Area", "required": true},
     "admin_area_1": {"label": "Municipality"},
     "postal_code": {"label": "Postal code", "required": false, "hidden": true},
     "local_components": [{"key": "zone_number", "label": "Zone", "required": true},
                          {"key": "street_number", "label": "Street", "required": true},
                          {"key": "building_number", "label": "Building", "required": true}]}'),
  ('GB', 'United Kingdom', 'GBP', 'en-GB', 'Europe/London', '+44', '{6,7}', 'sqft',
   '{"locality": {"label": "Post town", "required": true},
     "admin_area_2": {"label": "County"},
     "postal_code": {"label": "Postcode", "required": true,
                     "pattern": "^[A-Z]{1,2}[0-9][A-Z0-9]? ?[0-9][A-Z]{2}$"},
     "local_components": []}');

INSERT INTO jurisdictions (code, country_code, parent_code, name) VALUES
  ('GH', 'GH', NULL, 'Ghana'),
  ('QA', 'QA', NULL, 'Qatar'),
  ('GB', 'GB', NULL, 'United Kingdom');
INSERT INTO jurisdictions (code, country_code, parent_code, name) VALUES
  ('GB-ENG', 'GB', 'GB', 'England'),
  ('GB-WLS', 'GB', 'GB', 'Wales'),
  ('GB-SCT', 'GB', 'GB', 'Scotland'),
  ('GB-NIR', 'GB', 'GB', 'Northern Ireland');

-- Rule keys the application understands. Values are set per jurisdiction
-- after legal review (jurisdiction_settings), or per company (company_settings).
INSERT INTO jurisdiction_setting_definitions (key, data_type, description, default_value) VALUES
  ('deposit_max_rent_multiple',        'decimal',       'Maximum deposit as a multiple of the periodic rent', NULL),
  ('deposit_protection_required',      'boolean',       'Deposits must be registered with an approved scheme or body', 'false'),
  ('deposit_protection_deadline_days', 'duration_days', 'Days after receipt by which the deposit must be protected', NULL),
  ('deposit_return_deadline_days',     'duration_days', 'Days after tenancy end by which the deposit must be returned', NULL),
  ('advance_rent_max_months',          'decimal',       'Maximum rent that may be demanded in advance, in months', NULL),
  ('notice_min_days_tenant',           'duration_days', 'Minimum notice a tenant must give', NULL),
  ('notice_min_days_landlord',         'duration_days', 'Minimum notice a landlord must give', NULL),
  ('lease_registration_required',      'boolean',       'Leases must be registered with an authority', 'false'),
  ('lease_registration_deadline_days', 'duration_days', 'Days after signing by which the lease must be registered', NULL),
  ('rent_increase_min_interval_months','integer',       'Minimum months between rent increases', NULL),
  ('late_fee_allowed',                 'boolean',       'Late-payment fees may be charged', 'true'),
  ('tenant_eligibility_check_required','boolean',       'A tenant eligibility / immigration check is required before letting', 'false'),
  ('sales_kyc_required',               'boolean',       'Customer due diligence is required for sale parties', 'true'),
  ('agent_licence_required',           'boolean',       'Agents must hold a licence to transact', 'false'),
  ('lease_language_required',          'text',          'Locale a lease must be issued in (or be accompanied by)', NULL),
  ('rent_receipt_required',            'boolean',       'A receipt must be issued for every rent payment', 'true');

INSERT INTO plans (code, name, sort_order) VALUES
  ('starter', 'Starter', 1),
  ('professional', 'Professional', 2),
  ('enterprise', 'Enterprise', 3);

-- -----------------------------------------------------------------------------
-- Permission catalogue
-- -----------------------------------------------------------------------------
INSERT INTO permissions (key, module, description, is_sensitive) VALUES
  ('company.view', 'company', 'View company profile and offices', false),
  ('company.manage', 'company', 'Edit company profile, offices and settings', true),
  ('billing.view', 'billing', 'View plan, usage and invoices', false),
  ('billing.manage', 'billing', 'Change plan and billing details', true),
  ('user.view', 'company', 'View staff list', false),
  ('user.manage', 'company', 'Invite, deactivate and assign roles to users', true),
  ('role.manage', 'company', 'Create and edit custom roles', true),
  ('settings.manage', 'company', 'Edit picklists, templates and configuration', false),
  ('property.view', 'properties', 'View properties and units', false),
  ('property.create', 'properties', 'Create properties and units', false),
  ('property.update', 'properties', 'Edit properties and units', false),
  ('property.archive', 'properties', 'Archive properties and units', false),
  ('property.export', 'properties', 'Export property data', false),
  ('listing.view', 'properties', 'View listings', false),
  ('listing.create', 'properties', 'Create listings', false),
  ('listing.update', 'properties', 'Edit listings', false),
  ('listing.publish', 'properties', 'Publish or withdraw listings', false),
  ('listing.approve_price', 'properties', 'Approve price changes above threshold', false),
  ('contact.view', 'crm', 'View contacts', false),
  ('contact.create', 'crm', 'Create contacts', false),
  ('contact.update', 'crm', 'Edit contacts', false),
  ('contact.archive', 'crm', 'Archive contacts', false),
  ('contact.merge', 'crm', 'Merge duplicate contacts', false),
  ('contact.export', 'crm', 'Export contacts', true),
  ('contact.view_sensitive', 'crm', 'Reveal ID numbers, date of birth and bank details', true),
  ('kyc.view', 'crm', 'View KYC records', false),
  ('kyc.manage', 'crm', 'Record KYC checks', false),
  ('kyc.approve', 'crm', 'Sign off KYC checks', false),
  ('lead.view', 'crm', 'View leads', false),
  ('lead.create', 'crm', 'Create leads', false),
  ('lead.update', 'crm', 'Edit leads', false),
  ('lead.assign', 'crm', 'Assign and reassign leads', false),
  ('lead.export', 'crm', 'Export leads', true),
  ('deal.view', 'sales', 'View deals', false),
  ('deal.create', 'sales', 'Create deals', false),
  ('deal.update', 'sales', 'Edit deals and move stages', false),
  ('deal.close', 'sales', 'Close deals as won or lost', false),
  ('deal.export', 'sales', 'Export deals', false),
  ('viewing.view', 'sales', 'View viewings', false),
  ('viewing.manage', 'sales', 'Book, reschedule and record viewings', false),
  ('offer.view', 'sales', 'View offers', false),
  ('offer.manage', 'sales', 'Record offers and counter-offers', false),
  ('offer.accept', 'sales', 'Record acceptance of an offer', false),
  ('management_agreement.view', 'lettings', 'View management agreements', false),
  ('management_agreement.manage', 'lettings', 'Create and edit management agreements', false),
  ('management_agreement.approve', 'lettings', 'Activate management agreements', false),
  ('lease.view', 'lettings', 'View leases', false),
  ('lease.create', 'lettings', 'Draft leases', false),
  ('lease.update', 'lettings', 'Edit leases', false),
  ('lease.activate', 'lettings', 'Activate, renew and end leases', false),
  ('lease.export', 'lettings', 'Export leases', false),
  ('rent.view', 'lettings', 'View rent charges and balances', false),
  ('rent.manage', 'lettings', 'Create, waive and cancel charges', false),
  ('payment.record', 'lettings', 'Record payments received', false),
  ('payment.allocate', 'lettings', 'Allocate and reverse payment allocations', false),
  ('arrears.manage', 'lettings', 'Record arrears actions and payment plans', false),
  ('deposit.view', 'lettings', 'View deposits', false),
  ('deposit.manage', 'lettings', 'Record deposit protection and returns', false),
  ('inspection.view', 'lettings', 'View inspections', false),
  ('inspection.manage', 'lettings', 'Schedule and record inspections', false),
  ('maintenance.view', 'maintenance', 'View maintenance requests', false),
  ('maintenance.create', 'maintenance', 'Report maintenance requests', false),
  ('maintenance.update', 'maintenance', 'Update progress and record work', false),
  ('maintenance.assign', 'maintenance', 'Triage and assign requests', false),
  ('maintenance.approve', 'maintenance', 'Approve quotes above the limit', false),
  ('maintenance.close', 'maintenance', 'Close and cancel requests', false),
  ('finance.view', 'finance', 'View finance transactions and ledgers', false),
  ('finance.post', 'finance', 'Post finance transactions', false),
  ('finance.reverse', 'finance', 'Reverse posted transactions', true),
  ('supplier_invoice.manage', 'finance', 'Record supplier invoices', false),
  ('supplier_invoice.approve', 'finance', 'Approve supplier invoices', false),
  ('statement.view', 'finance', 'View landlord statements', false),
  ('statement.issue', 'finance', 'Generate and issue statements', false),
  ('payout.request', 'finance', 'Request payouts', false),
  ('payout.approve', 'finance', 'Approve payouts', true),
  ('period.lock', 'finance', 'Lock and unlock financial periods', true),
  ('bank_account.manage', 'finance', 'Manage company bank accounts', true),
  ('bank_details.manage', 'finance', 'Add or change contact bank / mobile-money details', true),
  ('commission.view', 'finance', 'View commissions', false),
  ('commission.manage', 'finance', 'Calculate and adjust commissions', false),
  ('commission.approve', 'finance', 'Approve commissions', false),
  ('document.view', 'documents', 'View documents', false),
  ('document.upload', 'documents', 'Upload documents and new versions', false),
  ('document.share', 'documents', 'Share documents with portal users', false),
  ('document.delete', 'documents', 'Archive documents', false),
  ('template.manage', 'documents', 'Manage document templates', false),
  ('report.view', 'reports', 'View reports', false),
  ('report.export', 'reports', 'Export reports', false),
  ('automation.view', 'automation', 'View automation rules and runs', false),
  ('automation.manage', 'automation', 'Edit automation rules', false),
  ('audit.view', 'audit', 'View the audit log', false),
  ('audit.export', 'audit', 'Export the audit log', true),
  ('integration.manage', 'integrations', 'Manage API keys and webhooks', true),
  ('ai.use', 'ai', 'Use EstateAI drafting tools', false);

-- -----------------------------------------------------------------------------
-- System roles (company_id NULL)
-- -----------------------------------------------------------------------------
INSERT INTO roles (company_id, key, name, audience, is_system, description) VALUES
  (NULL, 'company_owner',     'Company Owner',        'staff',  true, 'Full control of the company account'),
  (NULL, 'office_admin',      'Office Administrator', 'staff',  true, 'Runs operations, users, records and templates'),
  (NULL, 'sales_manager',     'Sales Manager',        'staff',  true, 'Leads sales teams, assigns leads, approves offers and team commissions'),
  (NULL, 'property_manager',  'Property Manager',     'staff',  true, 'Manages landlords, leases, rent and maintenance for a portfolio'),
  (NULL, 'agent',             'Agent',                'staff',  true, 'Sales and lettings front line'),
  (NULL, 'accountant',        'Accountant',           'staff',  true, 'Client money, statements, payouts, commissions and period close'),
  (NULL, 'maintenance_staff', 'Maintenance Staff',    'staff',  true, 'In-house technician or contractor; assigned work only'),
  (NULL, 'landlord',          'Landlord',             'portal', true, 'Landlord portal: own properties, statements and approvals'),
  (NULL, 'tenant',            'Tenant',               'portal', true, 'Tenant portal: own lease, balance and repair requests');

-- Role → permission → scope. 'all' rows for owner are generated below.
WITH grants (role_key, scope, perms) AS (VALUES
  ('office_admin', 'all', ARRAY[
     'company.view','billing.view','user.view','user.manage','settings.manage',
     'property.view','property.create','property.update','property.archive','property.export',
     'listing.view','listing.create','listing.update','listing.publish','listing.approve_price',
     'contact.view','contact.create','contact.update','contact.archive','contact.merge','contact.export',
     'kyc.view','kyc.manage','kyc.approve','lead.view','lead.create','lead.update','lead.assign','lead.export',
     'deal.view','deal.create','deal.update','deal.export','viewing.view','viewing.manage','offer.view','offer.manage',
     'management_agreement.view','management_agreement.manage','lease.view','lease.create','lease.update','lease.export',
     'rent.view','arrears.manage','deposit.view','inspection.view','inspection.manage',
     'maintenance.view','maintenance.create','maintenance.update','maintenance.assign','maintenance.close',
     'finance.view','statement.view','commission.view','document.view','document.upload','document.share',
     'document.delete','template.manage','report.view','report.export','automation.view','automation.manage',
     'audit.view','integration.manage','ai.use']),
  ('sales_manager', 'office', ARRAY[
     'company.view','user.view','property.view','property.create','property.update','property.export',
     'listing.view','listing.create','listing.update','listing.publish','listing.approve_price',
     'contact.view','contact.create','contact.update','contact.archive','contact.merge','contact.export',
     'kyc.view','kyc.manage','kyc.approve','lead.view','lead.create','lead.update','lead.assign','lead.export',
     'deal.view','deal.create','deal.update','deal.close','deal.export','viewing.view','viewing.manage',
     'offer.view','offer.manage','offer.accept','lease.view','commission.view','commission.approve',
     'document.view','document.upload','document.share','document.delete','report.view','report.export',
     'automation.view','ai.use']),
  ('property_manager', 'office', ARRAY[
     'company.view','user.view','property.view','property.create','property.update','property.archive','property.export',
     'listing.view','listing.create','listing.update','listing.publish','listing.approve_price',
     'contact.view','contact.create','contact.update','contact.archive','contact.merge','contact.export',
     'kyc.view','kyc.manage','kyc.approve','lead.view','lead.create','lead.update','lead.assign',
     'deal.view','viewing.view','viewing.manage','offer.view',
     'management_agreement.view','management_agreement.manage','management_agreement.approve',
     'lease.view','lease.create','lease.update','lease.activate','lease.export','rent.view','arrears.manage',
     'deposit.view','deposit.manage','inspection.view','inspection.manage',
     'maintenance.view','maintenance.create','maintenance.update','maintenance.assign','maintenance.approve','maintenance.close',
     'supplier_invoice.manage','finance.view','statement.view','document.view','document.upload','document.share',
     'document.delete','report.view','report.export','automation.view','ai.use']),
  ('agent', 'office', ARRAY['property.view','listing.view']),
  ('agent', 'own', ARRAY[
     'property.create','property.update','listing.create','listing.update',
     'contact.view','contact.create','contact.update','kyc.view','kyc.manage',
     'lead.view','lead.create','lead.update','deal.view','deal.create','deal.update',
     'viewing.view','viewing.manage','offer.view','offer.manage','lease.view','lease.create','lease.update',
     'maintenance.view','maintenance.create','inspection.view','commission.view',
     'document.view','document.upload','report.view','ai.use']),
  ('accountant', 'all', ARRAY[
     'company.view','billing.view','user.view','property.view','listing.view','contact.view','contact.view_sensitive',
     'kyc.view','deal.view','management_agreement.view','lease.view','rent.view','rent.manage','payment.record',
     'payment.allocate','arrears.manage','deposit.view','deposit.manage','maintenance.view',
     'finance.view','finance.post','finance.reverse','supplier_invoice.manage','supplier_invoice.approve',
     'statement.view','statement.issue','payout.request','payout.approve','period.lock',
     'bank_account.manage','bank_details.manage','commission.view','commission.manage','commission.approve',
     'document.view','document.upload','report.view','report.export','automation.view','audit.view']),
  ('maintenance_staff', 'assigned', ARRAY[
     'property.view','contact.view','maintenance.view','maintenance.update','inspection.view',
     'document.view','document.upload']),
  ('landlord', 'linked', ARRAY[
     'property.view','listing.view','offer.view','management_agreement.view','lease.view','rent.view',
     'deposit.view','maintenance.view','maintenance.create','maintenance.approve','statement.view',
     'document.view','report.view']),
  ('tenant', 'linked', ARRAY[
     'property.view','lease.view','rent.view','deposit.view','maintenance.view','maintenance.create','document.view'])
)
INSERT INTO role_permissions (role_id, permission_key, scope)
SELECT r.id, p.perm, g.scope
  FROM grants g
  CROSS JOIN LATERAL unnest(g.perms) AS p (perm)
  JOIN roles r ON r.key = g.role_key AND r.company_id IS NULL;

INSERT INTO role_permissions (role_id, permission_key, scope)
SELECT r.id, p.key, 'all'
  FROM roles r CROSS JOIN permissions p
 WHERE r.key = 'company_owner' AND r.company_id IS NULL;

-- -----------------------------------------------------------------------------
-- Default picklists (company_id NULL). country_code NULL = all markets.
-- -----------------------------------------------------------------------------
INSERT INTO picklist_values (list_key, code, label, country_code, sort_order) VALUES
  ('lead_source', 'website', 'Company website', NULL, 1),
  ('lead_source', 'property_portal', 'Property portal', NULL, 2),
  ('lead_source', 'phone', 'Phone call', NULL, 3),
  ('lead_source', 'walk_in', 'Walk-in', NULL, 4),
  ('lead_source', 'referral', 'Referral', NULL, 5),
  ('lead_source', 'social_media', 'Social media', NULL, 6),
  ('lead_source', 'whatsapp', 'WhatsApp', NULL, 7),
  ('lead_source', 'sign_board', 'Sign board', NULL, 8),
  ('lead_source', 'repeat_client', 'Existing client', NULL, 9),
  ('lead_source', 'developer_launch', 'Development launch event', NULL, 10),

  ('payment_method', 'bank_transfer', 'Bank transfer', NULL, 1),
  ('payment_method', 'cash', 'Cash', NULL, 2),
  ('payment_method', 'cheque', 'Cheque', NULL, 3),
  ('payment_method', 'post_dated_cheque', 'Post-dated cheque', NULL, 4),
  ('payment_method', 'card', 'Card', NULL, 5),
  ('payment_method', 'mobile_money', 'Mobile money', NULL, 6),
  ('payment_method', 'direct_debit', 'Direct debit', NULL, 7),
  ('payment_method', 'standing_order', 'Standing order', NULL, 8),

  ('tenure', 'freehold', 'Freehold', NULL, 1),
  ('tenure', 'leasehold', 'Leasehold', NULL, 2),
  ('tenure', 'customary_freehold', 'Customary freehold', 'GH', 3),
  ('tenure', 'stool_skin_family_land', 'Stool / skin / family land', 'GH', 4),
  ('tenure', 'usufruct', 'Usufruct', 'QA', 3),
  ('tenure', 'commonhold', 'Commonhold', 'GB', 3),
  ('tenure', 'share_of_freehold', 'Share of freehold', 'GB', 4),

  ('id_document_type', 'passport', 'Passport', NULL, 1),
  ('id_document_type', 'national_id', 'National ID card', NULL, 2),
  ('id_document_type', 'ghana_card', 'Ghana Card', 'GH', 3),
  ('id_document_type', 'qatar_id', 'Qatar ID (QID)', 'QA', 3),
  ('id_document_type', 'driving_licence', 'Driving licence', NULL, 4),
  ('id_document_type', 'residence_permit', 'Residence permit', NULL, 5),
  ('id_document_type', 'company_registration', 'Company registration certificate', NULL, 6),

  ('furnishing', 'unfurnished', 'Unfurnished', NULL, 1),
  ('furnishing', 'part_furnished', 'Part furnished', NULL, 2),
  ('furnishing', 'furnished', 'Furnished', NULL, 3),

  ('price_qualifier', 'fixed', 'Fixed price', NULL, 1),
  ('price_qualifier', 'negotiable', 'Negotiable', NULL, 2),
  ('price_qualifier', 'offers_over', 'Offers over', NULL, 3),
  ('price_qualifier', 'guide_price', 'Guide price', NULL, 4),
  ('price_qualifier', 'price_on_application', 'Price on application', NULL, 5),

  ('mandate_type', 'sole_agency', 'Sole agency', NULL, 1),
  ('mandate_type', 'exclusive', 'Exclusive right to sell / let', NULL, 2),
  ('mandate_type', 'multi_agency', 'Multi-agency', NULL, 3),
  ('mandate_type', 'open', 'Open listing', NULL, 4),

  ('maintenance_category', 'plumbing', 'Plumbing', NULL, 1),
  ('maintenance_category', 'electrical', 'Electrical', NULL, 2),
  ('maintenance_category', 'air_conditioning', 'Air conditioning', NULL, 3),
  ('maintenance_category', 'heating', 'Heating and hot water', NULL, 4),
  ('maintenance_category', 'appliances', 'Appliances', NULL, 5),
  ('maintenance_category', 'structural', 'Structural / roof', NULL, 6),
  ('maintenance_category', 'doors_windows_locks', 'Doors, windows and locks', NULL, 7),
  ('maintenance_category', 'pest_control', 'Pest control', NULL, 8),
  ('maintenance_category', 'water_supply', 'Water supply / borehole / tank', NULL, 9),
  ('maintenance_category', 'generator_power', 'Generator / power backup', NULL, 10),
  ('maintenance_category', 'gas', 'Gas', NULL, 11),
  ('maintenance_category', 'common_areas', 'Common areas', NULL, 12),
  ('maintenance_category', 'other', 'Other', NULL, 99),

  ('expense_category', 'repairs', 'Repairs and maintenance', NULL, 1),
  ('expense_category', 'service_charge', 'Service charge', NULL, 2),
  ('expense_category', 'utilities', 'Utilities', NULL, 3),
  ('expense_category', 'insurance', 'Insurance', NULL, 4),
  ('expense_category', 'property_tax', 'Property rates / taxes', NULL, 5),
  ('expense_category', 'cleaning', 'Cleaning', NULL, 6),
  ('expense_category', 'security', 'Security', NULL, 7),
  ('expense_category', 'marketing', 'Marketing', NULL, 8),
  ('expense_category', 'legal', 'Legal and professional', NULL, 9),
  ('expense_category', 'compliance_certificates', 'Compliance certificates', NULL, 10),
  ('expense_category', 'other', 'Other', NULL, 99),

  ('income_category', 'rent', 'Rent', NULL, 1),
  ('income_category', 'management_fee', 'Management fee', NULL, 2),
  ('income_category', 'letting_fee', 'Letting fee', NULL, 3),
  ('income_category', 'sales_fee', 'Sales fee', NULL, 4),
  ('income_category', 'renewal_fee', 'Renewal fee', NULL, 5),
  ('income_category', 'other', 'Other', NULL, 99),

  ('lost_reason', 'price', 'Price / budget', NULL, 1),
  ('lost_reason', 'bought_elsewhere', 'Bought or rented elsewhere', NULL, 2),
  ('lost_reason', 'financing_failed', 'Financing failed', NULL, 3),
  ('lost_reason', 'no_response', 'No response', NULL, 4),
  ('lost_reason', 'requirements_changed', 'Requirements changed', NULL, 5),
  ('lost_reason', 'property_withdrawn', 'Property withdrawn', NULL, 6),
  ('lost_reason', 'failed_due_diligence', 'Failed due diligence', NULL, 7),
  ('lost_reason', 'duplicate', 'Duplicate', NULL, 8),
  ('lost_reason', 'other', 'Other', NULL, 99),

  ('document_type', 'title_deed', 'Title deed / land certificate', NULL, 1),
  ('document_type', 'site_plan', 'Site plan / survey', NULL, 2),
  ('document_type', 'agency_agreement', 'Agency / instruction agreement', NULL, 3),
  ('document_type', 'management_agreement', 'Management agreement', NULL, 4),
  ('document_type', 'lease', 'Lease / tenancy agreement', NULL, 5),
  ('document_type', 'sale_agreement', 'Sale and purchase agreement', NULL, 6),
  ('document_type', 'identity', 'Identity document', NULL, 7),
  ('document_type', 'proof_of_address', 'Proof of address', NULL, 8),
  ('document_type', 'proof_of_funds', 'Proof of funds', NULL, 9),
  ('document_type', 'inspection_report', 'Inspection report', NULL, 10),
  ('document_type', 'safety_certificate', 'Safety certificate', NULL, 11),
  ('document_type', 'insurance', 'Insurance policy', NULL, 12),
  ('document_type', 'invoice', 'Invoice', NULL, 13),
  ('document_type', 'receipt', 'Receipt', NULL, 14),
  ('document_type', 'notice', 'Notice', NULL, 15),
  ('document_type', 'building_permit', 'Building permit', NULL, 16),
  ('document_type', 'other', 'Other', NULL, 99),

  ('arrears_action', 'reminder', 'Reminder sent', NULL, 1),
  ('arrears_action', 'call', 'Phone call', NULL, 2),
  ('arrears_action', 'formal_notice', 'Formal arrears notice', NULL, 3),
  ('arrears_action', 'payment_plan', 'Payment plan agreed', NULL, 4),
  ('arrears_action', 'guarantor_contacted', 'Guarantor contacted', NULL, 5),
  ('arrears_action', 'legal_referral', 'Referred for legal action', NULL, 6),

  ('deposit_deduction_reason', 'cleaning', 'Cleaning', NULL, 1),
  ('deposit_deduction_reason', 'damage', 'Damage beyond fair wear and tear', NULL, 2),
  ('deposit_deduction_reason', 'unpaid_rent', 'Unpaid rent', NULL, 3),
  ('deposit_deduction_reason', 'unpaid_utilities', 'Unpaid utilities', NULL, 4),
  ('deposit_deduction_reason', 'missing_items', 'Missing items', NULL, 5),
  ('deposit_deduction_reason', 'other', 'Other', NULL, 99),

  ('financing', 'cash', 'Cash', NULL, 1),
  ('financing', 'mortgage', 'Mortgage', NULL, 2),
  ('financing', 'developer_payment_plan', 'Developer payment plan', NULL, 3),
  ('financing', 'part_exchange', 'Part exchange', NULL, 4),

  ('feature', 'parking', 'Parking', NULL, 1),
  ('feature', 'garden', 'Garden', NULL, 2),
  ('feature', 'balcony', 'Balcony', NULL, 3),
  ('feature', 'swimming_pool', 'Swimming pool', NULL, 4),
  ('feature', 'gym', 'Gym', NULL, 5),
  ('feature', 'lift', 'Lift', NULL, 6),
  ('feature', 'security_24h', '24-hour security', NULL, 7),
  ('feature', 'air_conditioning', 'Air conditioning', NULL, 8),
  ('feature', 'backup_generator', 'Backup generator', NULL, 9),
  ('feature', 'borehole', 'Borehole', 'GH', 10),
  ('feature', 'water_storage_tank', 'Water storage tank', NULL, 11),
  ('feature', 'maids_room', 'Maid''s room', NULL, 12),
  ('feature', 'central_heating', 'Central heating', 'GB', 13),
  ('feature', 'pets_allowed', 'Pets allowed', NULL, 14),
  ('feature', 'wheelchair_access', 'Step-free access', NULL, 15);

INSERT INTO picklist_value_translations (picklist_value_id, locale_code, label)
SELECT id, 'ar', v.label_ar
  FROM picklist_values pv
  JOIN (VALUES ('furnishing', 'unfurnished', 'غير مفروش'),
               ('furnishing', 'part_furnished', 'مفروش جزئياً'),
               ('furnishing', 'furnished', 'مفروش'),
               ('payment_method', 'post_dated_cheque', 'شيك مؤجل'),
               ('payment_method', 'bank_transfer', 'تحويل بنكي'),
               ('payment_method', 'cash', 'نقداً')) AS v (list_key, code, label_ar)
    ON pv.list_key = v.list_key AND pv.code = v.code AND pv.company_id IS NULL AND pv.country_code IS NULL;

-- -----------------------------------------------------------------------------
-- Property types: universal first, then market-specific.
-- -----------------------------------------------------------------------------
INSERT INTO property_types (code, name, usage_class, applies_to, country_code, sort_order) VALUES
  ('residential', 'Residential', 'residential', 'property', NULL, 1),
  ('commercial', 'Commercial', 'commercial', 'property', NULL, 2),
  ('industrial', 'Industrial', 'industrial', 'property', NULL, 3),
  ('land', 'Land', 'land', 'property', NULL, 4),
  ('mixed_use', 'Mixed use', 'mixed_use', 'property', NULL, 5),
  ('hospitality', 'Hospitality', 'hospitality', 'property', NULL, 6);

INSERT INTO property_types (parent_id, code, name, usage_class, applies_to, country_code, sort_order)
SELECT p.id, v.code, v.name, p.usage_class, v.applies_to, v.country_code, v.sort_order
  FROM (VALUES
    ('residential', 'apartment',            'Apartment / flat',       'both', NULL, 1),
    ('residential', 'apartment_building',   'Apartment building',     'property', NULL, 2),
    ('residential', 'house_detached',       'Detached house',         'both', NULL, 3),
    ('residential', 'townhouse',            'Townhouse',              'both', NULL, 4),
    ('residential', 'villa',                'Villa',                  'both', NULL, 5),
    ('residential', 'studio',               'Studio',                 'unit', NULL, 6),
    ('residential', 'penthouse',            'Penthouse',              'unit', NULL, 7),
    ('residential', 'room',                 'Room',                   'unit', NULL, 8),
    ('residential', 'bungalow',             'Bungalow',               'both', NULL, 9),
    ('residential', 'compound',             'Residential compound',   'property', NULL, 10),
    ('residential', 'chamber_and_hall',     'Chamber and hall',       'unit', 'GH', 20),
    ('residential', 'single_room_self_contained', 'Single room self-contained', 'unit', 'GH', 21),
    ('residential', 'compound_house',       'Compound house',         'property', 'GH', 22),
    ('residential', 'compound_villa',       'Compound villa',         'unit', 'QA', 20),
    ('residential', 'staff_accommodation',  'Staff accommodation',    'both', 'QA', 21),
    ('residential', 'semi_detached',        'Semi-detached house',    'both', 'GB', 20),
    ('residential', 'terraced',             'Terraced house',         'both', 'GB', 21),
    ('residential', 'maisonette',           'Maisonette',             'unit', 'GB', 22),
    ('residential', 'hmo',                  'House in multiple occupation', 'property', 'GB', 23),
    ('commercial',  'office',               'Office',                 'both', NULL, 1),
    ('commercial',  'retail',               'Retail / shop',          'both', NULL, 2),
    ('commercial',  'showroom',             'Showroom',               'both', NULL, 3),
    ('commercial',  'restaurant',           'Restaurant / café',      'both', NULL, 4),
    ('commercial',  'shopping_centre',      'Shopping centre / mall', 'property', NULL, 5),
    ('industrial',  'warehouse',            'Warehouse',              'both', NULL, 1),
    ('industrial',  'factory',              'Factory',                'both', NULL, 2),
    ('industrial',  'labour_camp',          'Labour accommodation',   'property', 'QA', 10),
    ('land',        'residential_plot',     'Residential plot',       'property', NULL, 1),
    ('land',        'commercial_plot',      'Commercial plot',        'property', NULL, 2),
    ('land',        'agricultural_land',    'Agricultural land',      'property', NULL, 3),
    ('hospitality', 'hotel',                'Hotel',                  'property', NULL, 1),
    ('hospitality', 'serviced_apartment',   'Serviced apartment',     'unit', NULL, 2)
  ) AS v (parent_code, code, name, applies_to, country_code, sort_order)
  JOIN property_types p ON p.code = v.parent_code AND p.company_id IS NULL AND p.country_code IS NULL;

INSERT INTO property_type_translations (property_type_id, locale_code, name)
SELECT pt.id, 'ar', v.name_ar
  FROM property_types pt
  JOIN (VALUES ('apartment', 'شقة'), ('villa', 'فيلا'), ('compound_villa', 'فيلا في مجمع'),
               ('office', 'مكتب'), ('retail', 'محل تجاري'), ('warehouse', 'مستودع'),
               ('studio', 'استوديو'), ('penthouse', 'بنتهاوس')) AS v (code, name_ar)
    ON pt.code = v.code AND pt.company_id IS NULL;

-- -----------------------------------------------------------------------------
-- Pipeline stages, SLA policies and milestone templates (company-overridable)
-- -----------------------------------------------------------------------------
INSERT INTO pipeline_stages (deal_type, stage_class, code, name, sort_order, default_probability, stall_after_days) VALUES
  ('sale', 'lead',           'lead',           'Lead',               1,   5, 3),
  ('sale', 'qualification',  'qualification',  'Qualification',      2,  10, 7),
  ('sale', 'viewing',        'viewing',        'Viewing scheduled',  3,  20, 14),
  ('sale', 'negotiation',    'negotiation',    'Negotiation',        4,  40, 14),
  ('sale', 'offer_accepted', 'offer_accepted', 'Offer accepted',     5,  70, 14),
  ('sale', 'contract',       'contract',       'Contract stage',     6,  85, 30),
  ('sale', 'closed_won',     'closed_won',     'Closed – won',       7, 100, NULL),
  ('sale', 'closed_lost',    'closed_lost',    'Closed – lost',      8,   0, NULL),
  ('letting', 'lead',           'lead',           'Enquiry',            1,  10, 2),
  ('letting', 'qualification',  'qualification',  'Qualified',          2,  20, 5),
  ('letting', 'viewing',        'viewing',        'Viewing scheduled',  3,  35, 7),
  ('letting', 'negotiation',    'negotiation',    'Application / terms', 4, 60, 7),
  ('letting', 'offer_accepted', 'offer_accepted', 'Terms agreed',       5,  80, 7),
  ('letting', 'contract',       'contract',       'Lease signing',      6,  90, 14),
  ('letting', 'closed_won',     'closed_won',     'Let agreed',         7, 100, NULL),
  ('letting', 'closed_lost',    'closed_lost',    'Lost',               8,   0, NULL);

INSERT INTO sla_policies (priority_code, name, rank, response_minutes, resolution_minutes, business_hours_only) VALUES
  ('emergency', 'Emergency', 1,   120,   1440, false),
  ('urgent',    'Urgent',    2,  1440,   4320, false),
  ('routine',   'Routine',   3,  4320,  20160, true),
  ('planned',   'Planned',   4, 10080,  43200, true);

INSERT INTO milestone_templates (deal_type, code, name, sort_order, is_required, due_offset_days) VALUES
  ('sale', 'buyer_kyc',            'Buyer due diligence complete',    1, true,  7),
  ('sale', 'seller_kyc',           'Seller due diligence complete',   2, true,  7),
  ('sale', 'reservation_deposit',  'Reservation deposit received',    3, false, 7),
  ('sale', 'title_verified',       'Title / ownership verified',      4, true,  21),
  ('sale', 'financing_approved',   'Financing approved',              5, false, 30),
  ('sale', 'contract_signed',      'Sale agreement signed',           6, true,  30),
  ('sale', 'balance_paid',         'Purchase price paid',             7, true,  60),
  ('sale', 'title_transfer',       'Title transfer registered',       8, true,  90),
  ('sale', 'keys_handed_over',     'Keys handed over',                9, true,  90),
  ('letting', 'references_checked', 'References / eligibility checked', 1, true,  3),
  ('letting', 'holding_deposit',    'Holding deposit received',         2, false, 2),
  ('letting', 'lease_signed',       'Lease signed',                     3, true,  7),
  ('letting', 'advance_received',   'Advance rent and deposit received', 4, true,  7),
  ('letting', 'move_in_inspection', 'Move-in inspection completed',     5, true,  14);

-- -----------------------------------------------------------------------------
-- Company provisioning: per-company defaults created at sign-up.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.provision_company_defaults(p_company_id uuid) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO number_sequences (company_id, sequence_key, prefix)
  VALUES (p_company_id, 'contact', 'CON'), (p_company_id, 'property', 'PRP'), (p_company_id, 'unit', 'UNT'),
         (p_company_id, 'listing', 'LST'), (p_company_id, 'lead', 'LEA'), (p_company_id, 'deal', 'DEA'),
         (p_company_id, 'sale', 'SAL'), (p_company_id, 'management_agreement', 'MGA'),
         (p_company_id, 'lease', 'LSE'), (p_company_id, 'payment', 'RCT'), (p_company_id, 'work_order', 'WO'),
         (p_company_id, 'inspection', 'INS'), (p_company_id, 'finance_transaction', 'FIN'),
         (p_company_id, 'statement', 'STM'), (p_company_id, 'payout', 'PAY')
  ON CONFLICT DO NOTHING;
$$;
