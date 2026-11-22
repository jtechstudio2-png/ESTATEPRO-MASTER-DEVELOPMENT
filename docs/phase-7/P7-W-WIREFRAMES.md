# Phase 7 · P7-W · Wireframes: management agreements, leases, rent, receipts, arrears, deposits, inspections, portals

| | |
|---|---|
| Status | **Approved** (product owner, 22 November 2026), with W7-D1 to W7-D8. L6 builds these screens; L1 to L5 build their endpoints |
| Builds on | Phase 3 design set (`docs/phase-3-ui-ux/`): shell, tokens, record page pattern (07 §1), tables, forms, filters, empty and error states. Specific Phase 3 drawings: receipt allocation (07 §2.1), tablet inspection (07 §2.5), rent dashboard (06 §6), portal home screens (06 §11), information architecture (02: Lettings and Rent sections). Phase 4 to 6 wireframe conventions (`docs/phase-6/P6-W-WIREFRAMES.md`). Those rules apply here and are not repeated |
| Backed by | The schema (migrations 0008, 0010, 0011, 0035) and the approved Phase 7 readiness report (workflows §5, portals §6, legal rules §7, decisions P7-D1 to P7-D16). The lettings API does not exist yet: each screen names the endpoint L1 to L5 must provide (verification report §3) |
| Companion | [P7-W Wireframe Verification Report](./P7-W-VERIFICATION.md) |

These are low-fidelity structural wireframes. They fix content, order, actions, permissions and states, not visual styling. Names, amounts, dates and references in the drawings are illustrative placeholders. They are not data, defaults, legal values or business rules.

## How to read this document

Each screen has a drawing and a specification block:
- **Purpose**
- **Roles**: permission and scope. Roles not listed never see the screen: navigation hides it and the API refuses direct calls
- **Data**: the planned endpoint, marked † when L1 to L5 must add it
- **Actions**: endpoint and permission
- **States**: the screen-specific ones. Every screen also has the standard states of Phase 3 03 §8: loading, empty, filtered empty, validation error, permission denied, conflict 412, network failure, success
- **Security**

Role abbreviations:

| Abbreviation | Role |
|---|---|
| Own | Company owner |
| Adm | Office administrator |
| PM | Property manager |
| Ag | Agent |
| Acc | Accountant |
| SM | Sales manager |
| MS | Maintenance staff |
| LL | Landlord (portal) |
| Tn | Tenant (portal) |

Permissions are the seeded ones (migration 0014). `lease.view`:

| Role | Scope |
|---|---|
| Own, Adm, Acc | All |
| PM, SM | Office |
| Ag | Own |
| LL, Tn | Linked |

Approved rules these screens show, not re-decide:

| Rule | Decision |
|---|---|
| A draft lease is created from a letting deal; the listing becomes `rented` on activation | P7-D4 |
| Activation needs the signed document | P7-D5 |
| Charges created by the daily job; pro-rated first period; advance periods at signing | P7-D6 |
| Manual and CSV import receipts | P7-D7 |
| Allocation suggested, confirmed by a person | P7-D8 |
| Posted charges corrected by adjustment; bounces reverse allocations | P7-0, ADR-009 |
| Ageing buckets 0–30, 31–60, 61–90, over 90 | P7-D10 |
| Legal values never invented; "not reviewed" shown | P7-D3, P7-D11 |
| Portal visibility, guarantors' limited view, 12 months read-only | P7-D13 |
| No repair requests, work orders or statements in the Phase 7 portals | P7-D2, P7-D15 |

## 1. Screen index

| ID | Screen | Device notes |
|---|---|---|
| **Shell** | | |
| SH-3 | Navigation: Lettings and Rent sections | Desktop sidebar, tablet rail, mobile menu |
| **Management agreements** | | |
| MA-1 | Agreements list | Table; cards on mobile |
| MA-2 | Agreement record: terms, activate, suspend, end | Record page |
| **Leases** | | |
| LS-1 | Leases list | Table; cards on mobile |
| LS-2 | New lease, or a lease from a letting deal | Full-page form |
| LS-3 | Lease record | Record page with tabs |
| LS-4 | Parties: add, liability share, portal access | Dialog |
| LS-5 | Send for signature; activate with the signed document | Dialogs |
| LS-6 | Notice, end, close | Dialogs |
| LS-7 | Renewal decision and renewal lease | Dialog, then LS-2 prefilled |
| **Rent** | | |
| RL-1 | Rent ledger (lease tab): charges, receipts, adjustments, running balance | Tab in LS-3 |
| RC-1 | Charges list | Table |
| RC-2 | Add a charge (manual) | Dialog |
| RC-3 | Adjust a charge | Dialog |
| RC-4 | Waive or cancel a charge | Dialog |
| RR-1 | Rent reviews: schedule, propose, agree, apply | Tab in LS-3, list |
| **Receipts and allocation** | | |
| RP-1 | Receipts list | Table |
| RP-2 | Record a receipt | Dialog |
| RP-3 | Bank-file import: upload, check, match | Page |
| RP-4 | Allocate a receipt | Page (Phase 3 07 §2.1) |
| RP-5 | Unallocated receipts queue | Table |
| RP-6 | Post-dated cheques | Table |
| RP-7 | Bounce, refund or void a receipt | Dialog |
| **Arrears** | | |
| AR-1 | Arrears list with ageing | Table |
| AR-2 | Arrears tab: actions, payment plan | Tab in LS-3 |
| **Deposits and inspections** | | |
| DP-1 | Deposit panel: register, protect, deduct, return | Tab in LS-3 |
| IN-1 | Inspections list and schedule | Table |
| IN-2 | Inspection on a tablet | Tablet (Phase 3 07 §2.5) |
| IN-3 | Finish and report | Dialog |
| **Dashboard and settings** | | |
| RD-1 | Rent dashboard | Page (Phase 3 06 §6) |
| ST-2 | Lettings settings: charge lead days, arrears steps | Settings page |
| **Portals** | | |
| PS-1 | Portal shell and sign-in | All devices; bottom bar on mobile |
| PT-1 | Tenant home | |
| PT-2 | Tenant lease | |
| PT-3 | Tenant payments and receipts | |
| PT-4 | Guarantor view | |
| PL-1 | Landlord home (#9) | |
| PL-2 | Landlord property and tenancies | |
| PD-1 | Portal documents | |
| PI-1 | Staff: portal access and invitations | Panel on the contact and lease records |
| **Panels on existing screens** | | |
| X-C3 | Contact record: Leases, Rent, Portal panels | C-2 |
| X-D9 | Letting deal: "Create draft lease" | DL-3 |
| X-U1 | Unit and property: current lease and occupancy | Property record |

---

## 2. Shell

### SH-3 Lettings and Rent navigation

```text
┌──────────────────────┬────────────────────────────────────────────┐
│ Dashboards           │                                            │
│   … Rent             │                                            │
│ Contacts · Leads     │                                            │
│ Sales …              │                                            │
│ Lettings             │                                            │
│   Agreements         │                                            │
│   Leases             │                                            │
│   Renewals        4  │  ← leases ending ≤ 90 days without decision│
│   Inspections        │                                            │
│ Rent                 │                                            │
│   Charges            │                                            │
│   Receipts           │                                            │
│   To allocate     3  │  ← unallocated cleared receipts            │
│   Arrears            │                                            │
│   Cheques         6  │  ← post-dated cheques due ≤ 3 days         │
│ Properties …         │                                            │
└──────────────────────┴────────────────────────────────────────────┘
+ Create ▾ : … · New lease · Record receipt
```

| | |
|---|---|
| Purpose | Reach the Phase 7 staff screens from the existing shell (Phase 3 02: Lettings and Rent) |
| Roles | Lettings: `lease.view` or `management_agreement.view`. Rent: `rent.view`. To allocate: `payment.allocate` (Own, Acc). Record receipt: `payment.record` (Own, Acc). New lease: `lease.create` |
| Data | `GET /me/context`; badge counts from scoped count endpoints† (`GET /leases?filter[renewalDue]=true&limit=0`, `GET /payments?filter[unallocated]=true&limit=0`, `GET /payments?filter[chequesDue]=3&limit=0`) |
| Security | Items are not rendered without the permission. Badges count only rows in the member's scope |

---

## 3. Management agreements

### MA-1 Agreements list

```text
┌ Management agreements ──────────────── [Search ref, landlord, property] [Status ▾] [Service ▾] [+ New] ┐
│ Reference      Landlord        Property / unit        Service         Fee            Status    Ends     │
│ MGT-2026-0004  Ama Owusu       Osu Court · whole      Fully managed   10 % collected  Active    —        │
│ MGT-2026-0007  Kofi Mensah     Labone Villa · Flat 2  Rent collection 8 % due         Draft     —        │
│ MGT-2025-0019  Esi Boateng     East Legon · whole     Let only        One-off         Ended     31 Oct   │
└───────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Find the landlord instruction behind a unit; see which units are collected for |
| Roles | `management_agreement.view`: Own, Adm, Acc (all), PM (office). LL see their own in the portal (PL-2), not here |
| Data | `GET /management-agreements?filter[status]&filter[serviceLevel]&q=`† |
| Actions | Open MA-2; New (`management_agreement.manage`) |
| States | Fee shown as recorded; "Fees are charged with Finance (Phase 9)" in the empty-state help (P7-D2) |
| Security | Office scope by property office; landlord bank account never shown in the list |

### MA-2 Agreement record

```text
┌ MGT-2026-0007 · Draft ───────────────────────────────── [Edit] [Activate] [⋯ Suspend · End] ┐
│ Landlord  Kofi Mensah →            Property  Labone Villa → · Unit Flat 2 (blank = whole)    │
│ Service   Rent collection          Currency  GHS                                             │
│ Fee       8 % of rent due · tax VAT-GH (as configured)   Letting fee terms  "…"              │
│ Expense approval limit  GH₵2,000.00    Float  GH₵0.00                                       │
│ Payouts   Monthly on day 5 → account ••••4471 (verified)                                    │
│ Dates     Starts 1 Dec 2026 · no end · notice 60 days                                        │
│ Document  Signed agreement.pdf ⤓  [Replace]                                                  │
├ Leases under this agreement (2) ─────────────────────────────────────────────────────────────┤
│ LSE-2026-000031 Flat 2 · Abena Darko · Active →                                               │
├ Activity ────────────────────────────────────────────────────────────────────────────────────┤
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Record and approve the landlord's instruction (LET-02); a unit is collected for only under an active agreement (readiness §5.1 step 1) |
| Roles | View: as MA-1. Edit, suspend, end: `management_agreement.manage` (Own, Adm, PM office). Activate: `management_agreement.approve` (Own, PM office) |
| Data | `GET /management-agreements/{id}`†, `GET /leases?filter[managementAgreementId]` |
| Actions | `POST /management-agreements`†, `PATCH /management-agreements/{id}`† (draft or active, If-Match), `POST /management-agreements/{id}/activate`† (document required), `…/suspend`†, `…/end`† (end date, reason) |
| States | Activation blocked without the signed document ("Upload the signed agreement first"). Ending blocked while a lease under it is live, with links. Fee fields are recorded only: no charge is created in Phase 7 |
| Security | Payout account shown masked (ADR-007); full number never in the browser. Audit on every change |

---

## 4. Leases

### LS-1 Leases list

```text
┌ Leases ─────────────── [Search ref, tenant, unit] [Status ▾] [Ending ▾ ≤30 ≤60 ≤90] [Office ▾] [+ New lease] ┐
│ Reference        Unit                 Tenant          Rent              Term                Status       │
│ LSE-2026-000031  Flat 2, Labone Villa Abena Darko     GH₵6,000 / month  1 Jan–31 Dec 2026  Active       │
│ LSE-2026-000040  Flat 1A, Osu Court   Yaw Adjei       GH₵4,500 / month  from 1 Dec          Pending sig. │
│ LSE-2025-000112  Unit 3, Al Dafna     خالد المستأجر    QAR 8,000 / month 1 Mar 25–28 Feb 26 Notice given │
│                                       ⚠ arrears QAR 8,000 (31–60 d)                                       │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Find a lease; see live, pending and ending leases |
| Roles | `lease.view`: Own, Adm, Acc (all), PM, SM (office), Ag (own: leases they created or of their letting deals) |
| Data | `GET /leases?filter[status]&filter[endingWithin]&filter[officeId]&q=`† (includes the primary tenant and an arrears summary per currency for members with `rent.view`) |
| Actions | Open LS-3; New lease (`lease.create`) |
| States | Arrears line only for `rent.view`; no total across currencies |
| Security | Scope applied by the API; search matches only in-scope leases |

### LS-2 New lease (or from a letting deal)

```text
┌ New lease ──────────────────────────────────────────────────────────────────────────────────┐
│ From deal DEA-2026-000044 (terms agreed) · parties and unit copied — change them here        │
│ 1 Unit        [Flat 1A, Osu Court ▾]  Management agreement [MGT-2026-0004 · Active ▾]        │
│ 2 Parties     Tenant  Yaw Adjei (primary) · [+ Co-tenant] [+ Occupant] [+ Guarantor]         │
│               Landlord Ama Owusu (from ownership record)                                     │
│ 3 Term        Type [Fixed term ▾]  Starts [01/12/2026]  Ends [30/11/2027]  Usage [Residential]│
│               Notice [60] days · Break clause [date] notice [ ] days                         │
│ 4 Rent        [GH₵ 4,500.00] per [Month ▾] due day [1]  Advance periods [12]                 │
│               ☑ Pro-rate the first period by actual days     Tax [None ▾]                    │
│               Next rent review [01/12/2027]                                                  │
│ 5 Deposit     Amount [GH₵ 9,000.00] (recorded in DP-1 once received)                         │
│ 6 Jurisdiction GH · Governing language [English (Ghana) ▾]                                   │
│   ⓘ No reviewed legal rules for Ghana yet: limits are not enforced (P7-D3)                   │
│                                                          [Cancel]   [Save draft lease]       │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Create a draft lease (LET-01), directly or from a letting deal at "terms agreed" (P7-D4) |
| Roles | `lease.create`: Own, Adm (all), PM (office), Ag (own) |
| Data | Units: `GET /units?filter[available]` (existing); agreements: `GET /management-agreements?filter[unitId]&filter[status]=active`†; from deal: `GET /deals/{id}` (existing) |
| Actions | `POST /leases`† (draft; from deal: `POST /deals/{id}/lease`†, which closes the deal won and links it) |
| States | Unit already let for the dates: "Flat 1A has a live lease from … to …" (exclusion constraint). For a collected service level, an active agreement is required, otherwise "Activate the management agreement first". Let-only units need none. Pro-rating and advance periods explained in a hint |
| Security | Only contacts in scope can be chosen. Amounts are decimal strings in the lease currency |

### LS-3 Lease record

```text
┌ LSE-2026-000040 · Pending signature ─────── [Edit] [Send for signature] [Activate] [⋯ Notice · Cancel] ┐
│ Flat 1A, Osu Court → · Ama Owusu (landlord) → · Yaw Adjei (tenant) →                                     │
│ 1 Dec 2026 – 30 Nov 2027 · GH₵4,500.00 per month, due day 1 · deposit GH₵9,000.00 · notice 60 days      │
│ Balance GH₵0.00 · Deposit: expected · Renewal: not due                                                  │
├ Overview │ Parties │ Ledger │ Reviews │ Deposit │ Inspections │ Arrears │ Documents │ Activity ──────────┤
│ (tab content)                                                                                            │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Everything about one tenancy: terms, parties, money, deposit, inspections, renewal, documents, history |
| Roles | View: `lease.view` in scope. Ledger and Arrears tabs: `rent.view`. Deposit: `deposit.view`. Inspections: `inspection.view`. Edit (draft only): `lease.update` |
| Data | `GET /leases/{id}`†; each tab loads its own endpoint (below) |
| Actions | Edit (draft and pending signature), Send for signature, Activate (LS-5); Notice, End, Close (LS-6); Cancel (draft or pending only, with reason); Renewal (LS-7) |
| States | Terms read-only once active: "Active leases change through rent reviews, renewals or notice" |
| Security | Tabs the member may not see are not rendered. Each tab enforces its own permission on the server |

### LS-4 Parties

```text
┌ Add a party ─────────────────────────────────────────────┐
│ Contact [Search contacts…            ]  or [+ New contact]│
│ Role    (•) Co-tenant ( ) Occupant ( ) Guarantor          │
│         ( ) Landlord ( ) Landlord's agent                 │
│ Liability share [ 50 ] %   (tenants and co-tenants)       │
│ ☑ Portal access (tenant portal; guarantors see balance)   │
│                                        [Cancel] [Add]     │
└──────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Record who is party to the lease and who may use the portal (P7-D13) |
| Roles | `lease.update` in scope; portal access also needs `portal.invite`† (verification §5, W7-D4) |
| Data | `GET /leases/{id}/parties`† |
| Actions | `POST /leases/{id}/parties`†, `PATCH …/parties/{contactId}/{role}`†, `DELETE` on draft leases only |
| States | One primary tenant (unique index). Shares of tenants and co-tenants are shown as entered, with no check that they total 100 % (W7-D5). Portal access is on by default (schema default) but grants nothing until the contact accepts an invitation (PI-1) |
| Security | Turning portal access on starts an invitation (PI-1); it never shows another party's data |

### LS-5 Send for signature; activate

```text
┌ Activate LSE-2026-000040 ───────────────────────────────────────────┐
│ Signed lease  [Upload PDF]  Signed on [28/11/2026]                    │
│ Move-in date  [01/12/2026]                                            │
│ On activation:                                                        │
│  • Listing LST-2026-000033 becomes Rented                             │
│  • Advance rent (12 periods) is charged now                           │
│  • A move-in inspection is scheduled [01/12/2026 10:00 ▾]             │
│                                          [Cancel]  [Activate lease]   │
└──────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Draft → pending signature → active (readiness §5.1 steps 3 and 4) |
| Roles | Send for signature: `lease.update`. Activate: `lease.activate` (Own, PM office) |
| Data | Lease, its listing and the advance-charge preview† |
| Actions | `POST /leases/{id}/send-for-signature`†; document upload `POST /documents`† then `POST /leases/{id}/activate`† (document id, signed date, move-in date, inspection time) |
| States | "Upload the signed lease" until a clean scan (P7-D5). The lease overlaps another: refused with the other lease named. No active management agreement for a collected unit: refused |
| Security | Document scanned before it can be linked (existing document versions, scan status) |

### LS-6 Notice, end, close

```text
┌ Record notice ──────────────────────────┐   ┌ Close LSE-2025-000112 ───────────────────────────┐
│ Given by (•) Tenant ( ) Landlord ( ) Agent│  │ ✓ Moved out 28 Feb 2026                          │
│ Given on [10/12/2025]                      │  │ ✓ Move-out inspection completed                 │
│ Ends on  [28/02/2026] (60 days' notice)    │  │ ✗ Balance QAR 8,000.00 outstanding → Ledger      │
│ Reason   [                       ]         │  │ ✗ Deposit held, not returned → Deposit           │
│                       [Cancel] [Record]    │  │ Closing needs a zero balance and a settled deposit│
└───────────────────────────────────────────┘  └───────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Notice, move-out and ending (LET-07, readiness §5.6); closing once settled (§12.5) |
| Roles | `lease.update` in scope |
| Actions | `POST /leases/{id}/notice`†, `…/end`† (move-out date, reason), `…/close`† |
| States | The notice end date is computed from the lease's notice days and shown, not enforced as law (P7-D3). Close lists each unmet condition with a link. After closing: "Relist the unit" → existing relist (ADR-004 D3) |
| Security | The reason is free text: hint "Do not enter ID or bank numbers" (#35) |

### LS-7 Renewal

```text
┌ Renewal · LSE-2026-000031 ends 31 Dec 2026 (in 38 days) ──────────┐
│ Decision (•) Renew  ( ) Not renewing  ( ) Decide later              │
│ Renewal terms (prefilled from the current lease, editable)          │
│   Starts 1 Jan 2027 · Ends [31/12/2027] · Rent [GH₵ 6,300.00]       │
│                          [Cancel]  [Create renewal lease (draft)]   │
└────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Record the renewal decision; create the linked renewal lease (`previous_lease_id`) |
| Roles | `lease.update` (decision), `lease.create` (renewal lease) |
| Data | Renewal tasks at 90, 60 and 30 days, escalated at 30 without a decision (readiness §5.6) |
| Actions | `POST /leases/{id}/renewal-decision`†; `POST /leases/{id}/renewal`† (opens LS-2 prefilled) |
| States | Renewals list (SH-3 badge): leases ending ≤ 90 days without a decision, oldest end first |

---

## 5. Rent

### RL-1 Ledger tab

```text
┌ Ledger · LSE-2026-000031 · GHS ──────────────── [As of 22/11/2026] [Add charge] [Record receipt] [⤓ CSV] ┐
│ Date     Entry                                   Charge      Paid      Adjust.     Balance             │
│ 01 Jan   Rent January 2026                        6,000.00                          6,000.00            │
│ 02 Jan   Receipt RCP-2026-000118 (transfer)                  6,000.00               0.00                │
│ 01 Feb   Rent February 2026                       6,000.00                          6,000.00            │
│ 20 Jan   Receipt RCP-2026-000131 (cheque 000123)             6,000.00               0.00                │
│ 03 Feb   ↺ Cheque 000123 bounced: allocation reversed      −6,000.00               6,000.00  ⚠         │
│ 05 Feb   Adjustment: water heater (approved K. Owusu)                   −500.00     5,500.00            │
│ Outstanding GH₵5,500.00 · 1–30 d 0 · 31–60 d 5,500.00 · 61–90 d 0 · 90+ d 0                            │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
Row ⋯ : Open receipt · Adjust (RC-3) · Waive / Cancel (RC-4, only at zero allocated)
```

| | |
|---|---|
| Purpose | One tenancy's money in date order, per currency: charges, receipts, reversals and adjustments, with the running balance and ageing (LET-03, LET-05) |
| Roles | `rent.view`: Own, Adm, Acc (all), PM (office). Add charge, adjust, waive: `rent.manage` (Own, Acc). Record receipt: `payment.record` (Own, Acc) |
| Data | `GET /leases/{id}/ledger?asOf=`† (from `rent_charges`, `rent_charge_adjustments`, `payment_allocations`, `payments`; balance as `rent_charge_balances`) |
| States | One table per currency; never a total across currencies. Reversed rows show the original and the reversal. Nothing in the ledger is editable in place (ADR-009) |
| Security | Receipt payer names are shown only within scope. The CSV export needs `lease.export` |

### RC-1 Charges list

```text
┌ Charges ─────── [Due ▾ this month] [Status ▾ posted] [Type ▾] [Office ▾] [Currency ▾] ┐
│ Due      Lease            Tenant        Type     Description          Total    Outst.  │
│ 01 Dec   LSE-2026-000031  Abena Darko   Rent     Rent December 2026   6,000.00 6,000.00│
│ 01 Dec   LSE-2026-000040  Yaw Adjei     Service  Service charge Q4    900.00   900.00  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Charges due across leases; scheduled charges before they post |
| Roles | `rent.view` |
| Data | `GET /rent-charges?filter[dueDate][gte|lte]&filter[status]&filter[chargeType]&filter[currency]`† |
| Actions | Open the lease ledger; Add (RC-2) |
| States | Totals per currency in the footer, from the server |

### RC-2 Add a charge

```text
┌ Add a charge · LSE-2026-000031 ────────────────────┐
│ Type [Service charge ▾]  Description [           ]  │
│ Period [01/10/2026] – [31/12/2026]  Due [01/12/2026]│
│ Amount [GH₵ 900.00]  Tax [None ▾]                   │
│ ( ) Schedule for the due date (•) Post now          │
│                               [Cancel] [Add charge] │
└────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Charges the schedule does not create: service, utility, repair recharge, fee, other (LET-03) |
| Roles | `rent.manage` |
| Actions | `POST /leases/{id}/charges`† |
| States | "A charge of this type already exists for this period" (unique index). Currency is the lease's |

### RC-3 Adjust a charge

```text
┌ Adjust: Rent February 2026 (GH₵6,000.00, paid 1,000.00) ───────────┐
│ Adjustment (•) Credit (reduces what is owed) ( ) Debit (adds)        │
│ Amount [GH₵ 500.00]   Date [22/11/2026] (open period)               │
│ Reason [Agreed reduction for the broken water heater      ] (3–500)  │
│ Approved by [Kofi Owusu ▾]                                           │
│ After: owed 5,500.00 · paid 1,000.00 · outstanding 4,500.00          │
│                                       [Cancel] [Record adjustment]   │
└─────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Correct a posted charge without editing it (#1, ADR-009 T-D2) |
| Roles | `rent.manage`; approver chosen from members with `rent.manage` (W7-D2) |
| Actions | `POST /rent-charges/{id}/adjustments`† |
| States | Refused below what is paid ("Reverse an allocation first") or below zero; refused in a locked period; only posted charges. The preview is computed on the server |
| Security | Append-only; the record shows who approved and why. The reason is erased with the tenant (ADR-009 §4) |

### RC-4 Waive or cancel a charge

| | |
|---|---|
| Purpose | Waive (with reason) or cancel a posted charge with nothing allocated; cancel a scheduled charge |
| Roles | `rent.manage` |
| Actions | `POST /rent-charges/{id}/waive`† (reason), `…/cancel`† |
| States | With money allocated: "Reverse the allocations first (RP-7 or RP-4)", and the button is disabled with that text visible |

### RR-1 Rent reviews

```text
┌ Reviews · LSE-2026-000031 ──────────────────────────────────────────── [+ Schedule review] ┐
│ Review date   Method       Current     Proposed    Agreed      From        Status          │
│ 01 Dec 2026   Negotiated   6,000.00    6,500.00    6,300.00    01 Jan 2027 Agreed [Apply]  │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Scheduled → proposed → agreed → applied (LET-08); applied amounts drive future charges |
| Roles | View `lease.view`; act `lease.update` |
| Actions | `POST /leases/{id}/rent-reviews`†, `PATCH …/{reviewId}`† (propose, agree, dispute, cancel), `POST …/{reviewId}/apply`† |
| States | Apply refused without an agreed amount and date (existing check). Notification to the tenant written to the outbox, delivered in Phase 12: "Notice is recorded; sending arrives later" |

---

## 6. Receipts and allocation

### RP-1 Receipts list

```text
┌ Receipts ─────── [Received ▾ this month] [Status ▾] [Method ▾] [Unallocated ☐] [+ Record] [Import file] ┐
│ Reference        Received  Payer          Method           Amount       Allocated   Status             │
│ RCP-2026-000131  20 Jan    Abena Darko    Cheque 000123    6,000.00     0.00        Bounced            │
│ RCP-2026-000140  02 Feb    Yaw Adjei      Mobile money     4,500.00     4,500.00    Cleared            │
│ RCP-2026-000141  02 Feb    (unmatched)    Bank transfer    1,200.00     0.00        Cleared ⚠ match    │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Every receipt with its state (LET-04) |
| Roles | `rent.view` to read; `payment.record` to record or import |
| Data | `GET /payments?filter[receivedOn]&filter[status]&filter[method]&filter[unallocated]`† |
| States | Unmatched imported lines show "match" (RP-3) |

### RP-2 Record a receipt

```text
┌ Record a receipt ──────────────────────────────────────────────┐
│ Payer [Abena Darko ▾]  Lease [LSE-2026-000031 ▾] (optional)     │
│ Method [Cheque ▾]  Bank account [Client account GHS ▾]          │
│ Amount [GH₵ 6,000.00]  Received [20/01/2026]                    │
│ Cheque no. [000123]  Cheque date [01/02/2026]  Bank [Test Bank] │
│ ⓘ A cheque dated after today stays pending until cleared         │
│ Notes [                                    ]                     │
│                          [Cancel] [Record] [Record and allocate] │
└────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Manual receipt entry (P7-D7) |
| Roles | `payment.record` (Own, Acc) |
| Actions | `POST /payments`† with an idempotency key (existing convention, ADR-003) |
| States | Currency follows the bank account. A duplicate submit returns the first receipt. Once cleared, the terms are fixed (#2): "To correct a cleared receipt, void it and record a new one" |
| Security | Cheque details erased with the payer (ADR-009) |

### RP-3 Bank-file import

```text
┌ Import a bank file ──────────────────────────────────────────────────────────────────────────┐
│ 1 Upload  [statement.csv] · Bank account [Client account GHS ▾] · Format: EstatePro CSV v1 ⓘ   │
│ 2 Check   48 lines · 45 matched by reference · 2 unmatched · 1 already imported (skipped)      │
│ Line  Date    Reference        Amount     Match                              Action            │
│ 1     02 Feb  LSE-2026-000031  6,000.00   Abena Darko · LSE-2026-000031      ✓                  │
│ 17    02 Feb  JAN RENT FLAT2   1,200.00   — [Choose payer ▾] [Leave in queue]                   │
│ 3 Import  [Cancel] [Import 47 receipts]  (imported as cleared; allocation is a separate step)   │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Documented CSV import, matched by reference (P7-D7) |
| Roles | `payment.record` |
| Actions | `POST /payments/imports`† (upload, returns a check); `POST /payments/imports/{id}/commit`† |
| States | Each line has a stable idempotency key, so re-importing a file skips lines already imported. Errors per line (bad date, wrong currency) are listed and those lines are not imported. Nothing is allocated by the import (P7-D8) |
| Security | The file is scanned and kept as a document; the format document is linked from ⓘ |

### RP-4 Allocate a receipt

Phase 3 07 §2.1, with:
- the remaining balance of each charge including adjustments
- the oldest-first suggestion pre-filled but not confirmed (P7-D8)
- the "someone allocated at the same time" conflict message (suite 18)

| | |
|---|---|
| Roles | `payment.allocate` (Own, Acc) |
| Data | `GET /payments/{id}`†, `GET /leases/{id}/ledger`† (outstanding charges in the receipt's currency) |
| Actions | `POST /payments/{id}/allocations`† (one transaction for all lines) |
| States | Inputs cannot exceed either remaining amount (also refused by the database). Other currencies' charges are not shown |

### RP-5 Unallocated receipts

| | |
|---|---|
| Purpose | Cleared receipts with money not yet allocated, oldest first (readiness §5.3) |
| Roles | `payment.allocate` |
| Data | `GET /payments?filter[unallocated]=true&sort=receivedOn`† |
| Actions | Allocate (RP-4); match payer (unmatched imports) |

### RP-6 Post-dated cheques

```text
┌ Post-dated cheques ─────── [Due ▾ next 7 days] ─────────────────────────────────────────┐
│ Cheque date  Cheque   Bank       Payer          Lease            Amount     Action        │
│ 01 Feb       000123   Test Bank  Abena Darko    LSE-2026-000031  6,000.00   [Cleared] [Bounced] │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Bank cheques when due; mark them cleared or bounced (readiness §5.3) |
| Roles | `payment.record` |
| Data | `GET /payments?filter[status]=pending&filter[instrumentDate][lte]`† (index `payments_pending_instruments_idx`) |
| Actions | Cleared: `POST /payments/{id}/clear`† (value date). Bounced: RP-7 |

### RP-7 Bounce, refund or void

```text
┌ Cheque 000123 bounced? ───────────────────────────────────────────────┐
│ RCP-2026-000131 · GH₵6,000.00 · allocated to:                          │
│   Rent February 2026  6,000.00                                         │
│ These allocations will be reversed and the rent will be owed again.    │
│ Reason [Returned unpaid: insufficient funds               ]            │
│ Date   [03/02/2026]                                                    │
│                                  [Cancel] [Mark bounced and reverse]   │
└───────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Take money back without losing the arrears (#3) |
| Roles | `payment.record` |
| Actions | `POST /payments/{id}/bounce`†, `…/refund`†, `…/void`†. Each calls `app.unwind_payment`, writes audit and an outbox event (P70-D2) |
| States | Shows every allocation that will be reversed. Bounced, refunded and voided are final; the receipt stays in the ledger with its reversal |

---

## 7. Arrears

### AR-1 Arrears list

```text
┌ Arrears ─────── [As of 22/11/2026] [Office ▾] [Bucket ▾] [Currency ▾] [Next action due ☐] ┐
│ Lease            Tenant         Currency  1–30     31–60     61–90    90+      Next action │
│ LSE-2025-000112  خالد المستأجر   QAR       0        8,000.00  0        0        Notice 25 Nov│
│ LSE-2026-000031  Abena Darko    GHS       5,500.00 0         0        0        Reminder today│
│ Totals per currency (server): GHS 5,500.00 · QAR 8,000.00                                   │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Who owes what and for how long (LET-05, P7-D10) |
| Roles | `rent.view`; actions `arrears.manage` (Own, Adm, Acc all; PM office) |
| Data | `GET /arrears?asOf=&filter[bucket]&filter[currency]`† (`app.lease_arrears`, P7-0 R1: read path measured in L3) |
| States | "As of" in the office time zone, so month-end figures can be reproduced |

### AR-2 Arrears tab

```text
┌ Arrears · LSE-2026-000031 ─────────────────────────── [Record action] [Agree payment plan] ┐
│ Outstanding GH₵5,500.00 (31–60 d) · step 1 of 3: Reminder (company setting)                │
│ 22 Nov  Reminder sent (outbox) · by system · next: Formal notice on 06 Dec                  │
│ Payment plan  GH₵5,500.00 in 2 instalments · agreed 22 Nov · Active                         │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Record each step and any payment plan (readiness §5.4) |
| Roles | `arrears.manage` |
| Actions | `POST /leases/{id}/arrears-actions`†, `POST /leases/{id}/payment-plans`†, `PATCH …/payment-plans/{id}`† (completed, broken, cancelled) |
| States | Steps and their days come from ST-2; no legal thresholds (P7-D3). Notes hint (#35, readiness R9) |

---

## 8. Deposits and inspections

### DP-1 Deposit tab

```text
┌ Deposit · LSE-2026-000031 · GH₵9,000.00 ──────────────────── Status: Held ─────────────────┐
│ Holder [Agent ▾]  Account [Client account GHS]  Received with RCP-2026-000118 →               │
│ Protection  Scheme [            ] Reference [        ] Deadline [ dd/mm/yyyy ] (entered)       │
│   ⓘ No reviewed deposit rule for Ghana: enter the deadline that applies (P7-D11)              │
│   [Record protection]                                                                         │
├ Return ───────────────────────────────────────────────────────────────────────────────────────┤
│ Deductions  Cleaning (evidence: move-out report p.3)   300.00  Agreed                        │
│             Broken window (photo ×2)                   500.00  Proposed  [Agree] [Withdraw]  │
│ Return due by [ ]  To return GH₵8,200.00 of 9,000.00            [Record return]               │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Register, protect and return the deposit with itemised, evidenced deductions (LET-06, P7-D11) |
| Roles | `deposit.view`; act `deposit.manage` (Own, Acc all; PM office) |
| Data | `GET /leases/{id}/deposit`† |
| Actions | `PUT /leases/{id}/deposit`†, `POST /deposits/{id}/protection`†, `POST /deposits/{id}/deductions`†, `PATCH …/deductions/{id}`†, `POST /deposits/{id}/return`† |
| States | Deadline from a reviewed jurisdiction value (with source) when one exists; otherwise entered, with the notice. Return never above the amount held (existing check). Protected needs a reference (existing check) |
| Security | Deduction descriptions erased with the tenant (ADR-009) |

### IN-1 Inspections list

| | |
|---|---|
| Purpose | Scheduled and completed inspections; schedule one (LET-09) |
| Roles | `inspection.view`: Own, Adm (all), PM (office), Ag (own), MS (assigned). Schedule: `inspection.manage` |
| Data | `GET /inspections?filter[status]&filter[type]&filter[scheduledAt]`† |
| Actions | `POST /inspections`† (unit, lease, type, time, inspector) |

### IN-2 Inspection on a tablet

Phase 3 07 §2.5 as drawn, with:
- areas and items from the previous inspection of the unit, or from a default list (company setting)
- the move-in condition beside each item on a move-out inspection
- photos per item through the media pipeline (W7-S1)
- saving each item as it changes; working offline is not supported (W7-D6)

| | |
|---|---|
| Roles | `inspection.manage` |
| Actions | `PATCH /inspections/{id}`† (start, overall condition, summary), `PUT /inspections/{id}/items`†, photo upload through the existing media upload with an inspection-item link (W7-S1) |
| States | "Finish" disabled while photo uploads are pending (Phase 3 07 §2.5). An inspection by another inspector in progress: read only |
| Security | Item notes hint (#35). Photos of people are discouraged in the hint |

### IN-3 Finish and report

| | |
|---|---|
| Purpose | Complete the inspection; produce the report document; tenant acknowledgement recorded |
| Actions | `POST /inspections/{id}/complete`† (produces `report_document_id`); `POST /inspections/{id}/tenant-signed`† |
| States | The report can be shared with the tenant (PD-1) |

---

## 9. Dashboard and settings

### RD-1 Rent dashboard

Phase 3 06 §6 as drawn and specified (panels, sources, click-throughs), built in L7. "Deposits to protect" appears only where the deadline is known (P7-D11).

| | |
|---|---|
| Roles | `rent.view` (Own, Adm, Acc, PM office) |
| Data | `GET /dashboards/rent?asOf=&officeId=`† |
| States | Per currency, never summed across currencies; "Updated" time with refresh |

### ST-2 Lettings settings

```text
┌ Lettings settings ────────────────────────────────────────────────┐
│ Create charges [ 14 ] days before they are due                      │
│ Arrears steps   1 [Reminder      ] after [  3 ] days past due       │
│                 2 [Formal notice ] after [ 14 ] days                │
│                 3 [Escalate to PM] after [ 30 ] days   [+ Step]     │
│ ⓘ These are your company's steps, not legal thresholds              │
│ Inspection areas (default list) [Kitchen, Living, Bedroom 1, …]    │
│                                                     [Save]          │
└────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Company settings named by the readiness report (P7-D6 `lead_days`, P7-D10 steps and days) |
| Roles | `settings.manage` (existing: Own, Adm) |
| Actions | `PUT /settings/lettings`† |
| States | The values shown in the drawing are placeholders; the settings start empty, and the job and workflow are idle until they are saved (W7-D7) |

---

## 10. Portals

### PS-1 Portal shell and sign-in

```text
Desktop                                                    Mobile
┌ EstatePro · Accra Homes Ltd ────────── [EN|عربي] [Yaw ▾]┐ ┌ Accra Homes Ltd ──────── ☰ ┐
│ Home · My lease · Payments · Documents                  │ │ (screen)                    │
└─────────────────────────────────────────────────────────┘ ├─────────────────────────────┤
                                                            │ Home Lease Payments Docs    │
                                                            └─────────────────────────────┘
```

| | |
|---|---|
| Purpose | A simplified shell for portal users (Phase 3 06 §11): top bar, bottom navigation on mobile |
| Roles | Tenant portal: contacts with portal access as tenant, co-tenant, occupant or guarantor. Landlord portal: contacts who own or are landlord parties. One person can be both and switches portal from the menu |
| Data | `GET /portal/me`† (companies, portals, contact) |
| States | Multi-factor authentication required for landlords, offered to tenants (P7-D12). Invitation accepted → first sign-in. Access ended: "Your access to this lease ended on …" (12 months after the end, P7-D13) |
| Security | Local only until #6, #21 and #28 (readiness §6.4). Every portal request carries `app.contact_id` for contact-keyed row-level security (P7-D13) |

### PT-1 Tenant home

```text
┌ Hello Yaw ───────────────────────────────────────────────────────────────┐
│ ┌ Amount due ──────────────────────┐ ┌ Your lease ──────────────────────┐ │
│ │ GH₵4,500.00 due 1 Jan 2027       │ │ Flat 1A, Osu Court               │ │
│ │ Pay to: Accra Homes client acct  │ │ 1 Dec 2026 – 30 Nov 2027         │ │
│ │ Reference LSE-2026-000040        │ │ GH₵4,500.00 per month · notice 60 d│ │
│ └──────────────────────────────────┘ │ Renewal: not due                  │ │
│ ┌ Recent payments ─────────────────┐ └───────────────────────────────────┘ │
│ │ 02 Dec  4,500.00  Receipt ⤓      │ ┌ Documents shared with you (2) ────┐ │
│ └──────────────────────────────────┘ └───────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Amount due, lease summary, recent payments, shared documents (LET-10, Phase 3 06 §11) |
| Roles | Tn: `lease.view`, `rent.view` (linked) |
| Data | `GET /portal/tenant/home`† |
| States | No repair requests panel (P7-D15). Several leases: one card per lease. Ended lease within 12 months: "Ended · read only". Payment instructions are company settings; no online payment (P7-D7) |
| Security | Only leases where the contact is a party with portal access; amounts in the lease currency |

### PT-2 Tenant lease

| | |
|---|---|
| Purpose | Lease terms, parties' names (not their contact details), deposit status, inspections shared with the tenant |
| Data | `GET /portal/tenant/leases/{id}`† |
| Security | Other parties' phone, email and identity details are never returned |

### PT-3 Tenant payments and receipts

```text
┌ Payments · Flat 1A ─────────────── [⤓ Statement of account (PDF)] ┐
│ Date     Description              Charge    Paid      Balance      │
│ 01 Dec   Rent December 2026       4,500.00            4,500.00     │
│ 02 Dec   Payment, mobile money              4,500.00  0.00  [⤓]   │
└───────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Payment history and receipts (LET-10) |
| Data | `GET /portal/tenant/leases/{id}/ledger`†; receipt PDF `GET /portal/tenant/payments/{id}/receipt`† |
| States | Bounced payments shown with the reversal, as in RL-1 |
| Security | Shows the tenant's own lease only; payer names of other parties are shown as "Payment" |

### PT-4 Guarantor view

```text
┌ Lease you guarantee · Flat 1A, Osu Court ───────────┐
│ Tenant  Yaw Adjei · 1 Dec 2026 – 30 Nov 2027         │
│ Balance outstanding GH₵0.00 (as of today)            │
│ Payment details are visible to the tenant only.      │
└─────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | A guarantor sees the guaranteed lease and its balance, not payment detail (P7-D13) |
| Data | `GET /portal/tenant/home`† (guarantor variant) |
| Security | Ledger and receipts endpoints refuse guarantors (403) |

### PL-1 Landlord home (#9)

```text
┌ Hello Ama ─────────────────────────────────────────────────────────────────────────┐
│ ┌ Your properties ───────────────────────────────────────────────────────────────┐ │
│ │ Osu Court      3 units · 2 let · 1 vacant   Rent this month: due 10,500 ·      │ │
│ │                received 6,000 · arrears GH₵4,500.00 →                            │ │
│ │ Labone Villa   1 unit · let · no arrears →                                       │ │
│ └─────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌ For sale (S4) ───────────────────┐ ┌ Documents shared with you (3) ─────────────┐ │
│ │ LST-2026-000052 · 2 offers →     │ │ Management agreement.pdf ⤓ …               │ │
│ └──────────────────────────────────┘ └────────────────────────────────────────────┘ │
│ ⓘ Statements will appear here once Finance is available.                            │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Properties with occupancy and rent this month, sale activity (S4, #5) and documents (LET-11, Phase 3 06 §11, #9) |
| Roles | LL: `lease.view`, `rent.view`, `management_agreement.view`, `deposit.view` (linked) |
| Data | `GET /portal/landlord/home`†; sale activity from the existing `GET /portal/landlord/listings` (S4) |
| States | No statements and no approvals panel (P7-D2, P7-D15); the statements line is the readiness R6 notice. Ownership ended: the property disappears the day after, in the property's time zone (#12) |
| Security | Tenants' names are shown; their contact details, identity and payment instruments are not. Multi-factor authentication required |

### PL-2 Landlord property and tenancies

| | |
|---|---|
| Purpose | Per unit: current lease (tenant name, dates, rent), rent due and received this month and the last 12, deposit status, management agreement summary |
| Data | `GET /portal/landlord/properties/{id}`† |
| Security | Only properties the contact owns or is landlord party to, while that holds |

### PD-1 Portal documents

| | |
|---|---|
| Purpose | Documents explicitly shared with the contact (`document_shares`) |
| Data | `GET /portal/documents`†; download `GET /portal/documents/{id}/download`† (short-lived link) |
| Security | Nothing is visible unless shared (migration 0011). Infected or unscanned files are never offered |

### PI-1 Portal access and invitations (staff)

```text
┌ Portal access · Yaw Adjei ──────────────────────────────────────────┐
│ Tenant portal   Invited 2 Dec · accepted 3 Dec · MFA offered          │
│ Leases visible  LSE-2026-000040 (tenant)                              │
│ [Resend invitation] [Remove access]                                   │
└──────────────────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| Purpose | Invite a contact and see what the portal shows them |
| Roles | `portal.invite`† (W7-D4) |
| Actions | `POST /contacts/{id}/portal-invitations`†, `DELETE /contacts/{id}/portal-access`† |
| States | No email address: "Add an email address to invite". Invitations are written to the outbox (delivery in Phase 12); locally the test identity provider is used |

---

## 11. Panels on existing screens

| ID | Screen | Change |
|---|---|---|
| X-C3 | Contact record (C-2) | Leases panel (as party, with role); Rent panel (balance per currency, `rent.view`); Portal panel (PI-1) |
| X-D9 | Deal record (DL-3), letting deals | At "terms agreed": "Create draft lease" (LS-2 prefilled), replacing the S3 note that letting deals stop here |
| X-U1 | Property and unit records | Current lease and occupancy per unit; link to the lease |

## 12. Mobile and tablet

| Device | What is available |
|---|---|
| Phone (≤ 767 px), staff | Lease read, ledger read, record a receipt, cheque cleared or bounced, arrears action. Allocation, bank import and adjustments: "Open on a larger screen" (W7-D3) |
| Tablet (768–1023 px) | Everything; IN-2 is designed for tablets |
| Portals | Every portal screen works at 320 px; tables become cards |

## 13. Accessibility (WCAG 2.2 AA, ADR-002)

- Every table has a caption and column headers. Amount columns are right-aligned in LTR and left-aligned in RTL, with the currency in the column header.
- Running balances and ageing buckets are text, not colour only. Arrears warnings carry ⚠ and words.
- Dialogs that reverse money (RP-7) or adjust it (RC-3) name the effect in text before the confirm button. The confirm button names the action.
- Inspection items can be completed by keyboard and screen reader on a tablet with a keyboard; photo buttons have labels naming the item.
- axe in English and Arabic, at desktop and 320 px, on every screen (L6 browser suite), as in Phases 4 to 6.

## 14. Localisation and right-to-left

- All labels in English and Arabic (messages checked in CI).
- Amounts are formatted for the locale with the lease currency (ADR-003). Western or Arabic-Indic digits follow the locale setting already used.
- Dates in the property's time zone. "As of" dates are business dates.
- Mixed-direction text (references, names in another script) is wrapped in `<bdi>`, as on the privacy screen.
- The governing language of a lease is shown on LS-3; documents are not translated.

## 15. States per screen (beyond the standard set)

| Screen | Extra states |
|---|---|
| LS-2, LS-5 | Unit already let for the dates; no active agreement for a collected unit; signed document still scanning |
| RL-1 | Several currencies (one table each); reversed rows; ledger "as of" a past date |
| RC-3, RC-4 | Locked period; amount below paid; charge not posted |
| RP-3 | Lines already imported; unmatched lines; per-line errors |
| RP-4 | Concurrent allocation (reload and explain) |
| RP-7 | Receipt with allocations on several leases (all listed) |
| DP-1 | No reviewed rule for the jurisdiction |
| PS-1 | Access ended; invitation expired; MFA required |
| PT-1 | Ended lease, read only; several leases |
