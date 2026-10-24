# ADR-004 — Listing publishing, pricing and status rules

| | |
|---|---|
| Status | Accepted (product owner, "Decisions Approved", 24 October 2026) |
| Context | [M3 Listings Requirements Verification Report](../phase-4/M3-LISTINGS-REQUIREMENTS-VERIFICATION.md) §4 and §7 |
| Amends | Phase 1 detailed specification §7.2 step 11b and §11.2 (Listings row, note 2) |

## Decisions

| ID | Decision | Implementation |
|---|---|---|
| D1 | Agents may publish listings assigned to themselves. Managers and admins may publish any listing in their scope. Publishing is audited. | Migration 0017 grants `listing.publish` with scope `own` to Agent. "Own" for listings means the assigned agent (`listings.agent_membership_id`). `listing.published` / `listing.unpublished` audit entries and `listing.publication_changed` events. |
| D2 | A configurable approval threshold applies to significant price reductions. It is off by default; the suggested value is 10%. Above the threshold, a manager must approve. | Company setting `listing.price_reduction_approval_percent` (1–100, absent = off), managed through `PUT /api/v1/settings/listings` with `settings.manage`. It applies to live listings (available, reserved, under contract). Above the threshold, a member without `listing.approve_price` covering the listing gets 403 `approval-required`, and a manager makes the change, recorded as `listing_price_history.approved_by`. A reduction exactly at the threshold does not need approval. Reductions on live listings require a reason. |
| D3 | Sold, Rented, Withdrawn and Expired are terminal statuses. Relisting creates a new listing. | Transition table in `apps/api/src/listings/listing-rules.ts`. `POST /listings/{id}/relist` copies terms and translations into a new draft, clears the mandate and availability dates, and records `relistedFrom` in the audit entry. |
| D4 | Only managers and admins may reassign a listing. | `POST /listings/{id}/assign` requires `listing.update` with scope `office` or `all`. |
| D5 | SEO metadata and portal feed publishing are deferred to PRP-10. | Nothing implemented in Phase 4. |
| D6 | The linked visibility scope is tracked as its own High-priority issue, separate from #5. | Issue #12. |

## Related rules adopted with the decisions

- **Archive permission (G2):** a new `listing.archive` permission for Owner and Office Admin (all) and for the Sales and Property Managers (office). Only drafts and closed listings can be archived.
- **Seller KYC gate (G4):** company setting `listing.require_seller_kyc` (default off). Seller identity comes from ownership (Phase 5). Until then, switching the setting on blocks publishing (fail-closed).
- **Rental caps:** `advance_rent_max_months` and `deposit_max_rent_multiple` resolve as office setting, then company setting, then jurisdiction (and its parent), then the definition default. No country rule is coded.
- **Under maintenance:** blocks rental listings from moving to reserved, under contract or rented. The listing's marketing status is not changed.

## Consequences

- Phase 1 §7.2 step 11b now reads "rental relisted (new listing)" instead of "listing → Available".
- Withdrawal above a threshold (Phase 1 §11.2 note 2) is not part of D2 and is not enforced; it can be added to the same setting later if the product owner asks.
