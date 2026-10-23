# 02 — Information Architecture and Navigation

## 1. Application information architecture

### Global application shell
- Company switcher (only for users with more than one company membership)
- Office switcher when the user has multiple offices
- Global search with permission-filtered results
- Quick create menu limited by role and permissions
- Task/inbox notifications
- Help and keyboard shortcut reference
- User profile, preferences, locale and sign-out

### Main navigation (staff)

1. **Work queue** — assigned tasks, overdue work, approvals and follow-ups. Maintenance Staff see **My jobs** instead.
2. **Dashboards** — Property, CRM, Rent, Maintenance, Finance and Admin dashboards, shown by role (see [06](./06-role-dashboards.md)).
3. **Properties** — properties, units, developments, listings, media, ownership, notes and key register.
4. **Contacts** — people and organisations with their roles (buyer, seller, landlord, tenant, supplier), requirements, KYC and activity timeline.
5. **Sales** — leads, pipeline, viewings, offers and completions.
6. **Lettings** — applicants, management agreements, leases, renewals, inspections and deposits.
7. **Rent** — charges, receipts, allocation, arrears and post-dated cheques.
8. **Maintenance** — requests, planned maintenance, suppliers and approvals.
9. **Finance** — transactions, bank reconciliation, supplier invoices, landlord statements, payouts, commissions and financial periods.
10. **Documents** — document library, templates and expiring documents, scoped to records and sharing.
11. **Reports** — operational reports and exports (Phase 11).
12. **Settings** — company, offices, users and roles, picklists, property types, templates, automation, integrations, billing and audit log; administrators only.

The exact items each role sees are in §6.

Navigation labels should reflect actual product capabilities. Do not show routes that are not implemented or accessible to the current user.

## 2. Record hierarchy

```text
Company
 ├── Offices
 ├── Team memberships and permissions
 ├── Properties
 │    ├── Units (optional where property is not multi-unit)
 │    ├── Ownership records
 │    ├── Media and documents
 │    ├── Viewings and inspections
 │    └── Sales / rental activity
 ├── Contacts
 │    ├── Contact roles
 │    └── Activity history
 ├── Leads → Viewings → Offers → Deal / Lease
 ├── Active leases → Charges → Payments → Allocations
 ├── Maintenance requests → Work history
 └── Reports, audit records and company configuration
```

A property may support sale, rent or both depending on configured business rules. Avoid assuming all markets use the same property categories, lease practices, address structure or terminology.

## 3. Role-based workspace definitions

Roles match the 11 roles in the brief and the system roles seeded in Phase 2 (`roles` table). Scopes come from `role_permissions.scope`.

| Role (system key) | Scope | Landing page | Default high-value actions |
|---|---|---|---|
| Platform Owner (`platform_owner`) | Platform | Platform console: companies, plans, health | Manage plans and pricing, platform staff, incidents |
| Super Admin (`super_admin`) | Platform | Platform console: companies, support | Company lifecycle, support requests through approved `support_access_grants` only |
| Company Owner (`company_owner`) | All | Admin dashboard | Approvals, billing, users and roles, company-wide reports |
| Office Administrator (`office_admin`) | All or assigned offices | Work queue (office) | Assign work, resolve overdue items, manage users, templates and imports |
| Sales Manager (`sales_manager`) | Office / team | CRM dashboard (team) and pipeline | Distribute leads, review stalled deals, accept offers, approve team commissions |
| Property Manager (`property_manager`) | Office / portfolio | Rent dashboard and maintenance | Renewals, arrears actions, inspections, maintenance assignment and approval |
| Agent (`agent`) | Own (read office listings) | My day | Respond to leads, book viewings, record outcomes and offers |
| Accountant (`accountant`) | All (finance) | Finance dashboard | Allocate receipts, bank reconciliation, statements, payouts, commissions, period lock |
| Maintenance Staff (`maintenance_staff`) | Assigned | My jobs (mobile-first) | Accept job, update status, add photos, record work and cost |
| Landlord (`landlord`, portal) | Linked | Landlord portal home | Statements, approvals of quotes above their limit, documents |
| Tenant (`tenant`, portal) | Linked | Tenant portal home | Balance and payments, lease, report a repair, documents |

Roles are not a substitute for record-level authorization. Portal visibility is derived on the server from the contact linked to the portal membership (`company_memberships.contact_id`): a landlord sees properties where they hold a current `property_ownerships` row or management agreement; a tenant sees leases where they are a `lease_parties` member. Documents appear in a portal only through an explicit `document_shares` row. Portal users never receive staff navigation.

## 4. Navigation behaviour

- Desktop: fixed-width left navigation that can collapse; current section remains obvious.
- Tablet: compact navigation rail or drawer; primary task remains in the content area.
- Mobile: bottom navigation limited to 4–5 high-frequency destinations plus a clearly accessible menu; do not shrink desktop sidebar into unreadable text.
- Global create menu: task-based options (lead, contact, property, viewing, maintenance request, payment) filtered by permission.
- Global search: searches only records the user is authorized to access; show record type and useful context.
- Breadcrumbs: use on deep record hierarchies, not every list page.
- Back navigation: restore list filters, page and sort when returning from a record.
- Unsaved changes: warn before losing edits; save draft where safe.
- Active office/company context is visible and unambiguous before any create or financial action.

## 5. Country and language configuration

The UI renders country-specific options from reference data and the record's own context, never from hard-coded country checks:

| UI element | Source in the Phase 2 schema |
|---|---|
| Address fields, labels, required fields, patterns | `countries.address_format`, stored in `addresses.local_components` |
| Property type choices | `property_types` filtered by the property's country plus the company's own types |
| Picklists (tenure, ID document types, payment methods, …) | `picklist_values` with `country_code` NULL or matching, plus company values; labels from `picklist_value_translations` |
| Currency default on forms | Office currency (`offices.currency_code`); always shown and changeable where allowed |
| Timezone for dates and appointments | Property timezone (`properties.timezone`), else office, else user |
| Week and working days | `countries.weekend_days`, `offices.working_days` |
| Lease templates | `document_templates` filtered by jurisdiction, usage and locale, showing version and status |
| Legal rule hints (e.g. deposit protection deadline) | Resolved rule settings (`company_settings` → `jurisdiction_settings`); hidden when no value is configured |
| Text direction | `locales.text_direction` |

- Display timezone where a date/time could be misunderstood, especially viewings, appointments and deadlines across markets.
- Currency is always explicit on money values and forms.
- Never convert currencies silently. Show original amount/currency and conversion details where conversion is explicitly applied (reports only; `fx_rates`).
- Lease templates show jurisdiction, language and version; the UI never implies a template is legally valid.

## 6. Sidebar structure by role

✓ = visible · ◐ = visible with reduced scope or read-only · blank = hidden. Hidden sections are not rendered at all, and the server rejects direct URLs.

| Section → sub-pages | Co. Owner | Office Admin | Sales Mgr | Prop. Mgr | Agent | Accountant | Maint. Staff |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| **Work queue** (my tasks, team, overdue, approvals) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| **My jobs** (assigned work orders) | | | | | | | ✓ |
| **Dashboards** → Property · CRM · Rent · Maintenance · Finance · Admin | ✓ all | ✓ all but Finance ◐ | CRM, Property | Property, Rent, Maintenance | CRM ◐ (own) | Finance, Rent | |
| **Properties** → Properties · Units · Developments · Listings · Keys | ✓ | ✓ | ✓ | ✓ | ◐ | ◐ | ◐ |
| **Contacts** → Contacts · Requirements · KYC | ✓ | ✓ | ✓ | ✓ | ◐ | ◐ | |
| **Sales** → Leads · Pipeline · Viewings · Offers · Completions | ✓ | ✓ | ✓ | ◐ | ◐ | ◐ | |
| **Lettings** → Applicants · Management agreements · Leases · Renewals · Inspections · Deposits | ✓ | ✓ | ◐ | ✓ | ◐ | ◐ | |
| **Rent** → Charges · Receipts · Allocation · Arrears · Post-dated cheques | ✓ | ◐ | | ✓ | | ✓ | |
| **Maintenance** → Requests · Planned · Suppliers · Approvals | ✓ | ✓ | | ✓ | ◐ | ◐ | |
| **Finance** → Transactions · Bank reconciliation · Supplier invoices · Landlord statements · Payouts · Commissions · Periods | ✓ | ◐ | ◐ (commissions) | ◐ | ◐ (own commissions) | ✓ | |
| **Documents** → Library · Templates · Expiring | ✓ | ✓ | ✓ | ✓ | ◐ | ◐ | ◐ |
| **Reports** | ✓ | ✓ | ◐ | ◐ | ◐ | ✓ | |
| **Settings** → Company · Offices · Users & roles · Picklists · Property types · Templates · Automation · Integrations · Billing · Audit log | ✓ | ✓ (no billing changes) | | | | ◐ (audit, bank accounts) | |

Portal navigation (separate shell):

- **Landlord:** Home · Properties · Statements · Approvals · Maintenance · Documents · Profile
- **Tenant:** Home · Payments · Lease · Repairs · Documents · Profile
- **Platform console (EstatePro staff):** Companies · Plans · Support access · Usage · Incidents · Platform audit

Sidebar rules: at most 12 top-level items; sub-pages expand in place (no fly-out menus); counts appear only for queues that need action (e.g. *Approvals 3*), never totals; the sidebar order is fixed so muscle memory holds.

## 7. Search behaviour

Global search (shortcut `/` or `Ctrl/Cmd + K`) is the fastest way into any record.

| Aspect | Behaviour |
|---|---|
| What it searches | References (`LSE-2026-000042`, `PRP-…`), contact names (including native-script names), emails, phone numbers in any format (normalised to E.164), addresses (including Ghana digital addresses and Qatar zone/street/building), listing titles, document titles |
| Matching | Exact reference match first; then prefix; then full-text (`contacts.search_vector`); then fuzzy trigram for misspelt names and addresses |
| Scope | Server-side and permission-filtered: results the user cannot open are never returned, and counts never reveal them |
| Speed | Results start after 2 characters, debounced 200 ms; target p95 < 300 ms; stale responses are discarded |
| Results | Grouped by type (Contacts, Properties, Listings, Leases, Deals, Work orders, Documents), max 5 per group with "See all"; each row shows type, reference, primary line and one context line (e.g. "Tenant · Flat 1A, Osu Court · Arrears GH₵10,000") |
| Keyboard | Arrow keys move, Enter opens, `Ctrl/Cmd + Enter` opens in a new tab, Esc closes; focus returns to the trigger |
| Recent | Empty search shows the user's last 8 opened records |
| Quick actions | Typing a phone number offers "Create contact with this number" if none matches (duplicate check first) |
| No results | "No records match '…' in Accra Homes" plus suggestions: check spelling, search by reference or phone, or create |
| List search | Every list page has its own search box that filters that list only, keeps filters, and is reflected in the URL |
