# Media Ownership and Retention Policy

| | |
|---|---|
| Status | Adopted for implementation (product owner requirement before Phase 4 Milestone 4) |
| Applies to | Property media in EstatePro: photos, floor plans, site plans and brochures stored by the platform, plus external video and virtual-tour links |
| Related | ADR-005 (media architecture decisions M-D1 to M-D8); Phase 1 detailed specification §6 (privacy), §9.4 (isolation), §14.5 (retention); Phase 10 documents (DOC-*) for contracts and identity documents, which have their own policy |
| Legal note | This policy sets product behaviour. Contract wording (customer terms, data processing agreement) and country-specific retention periods must be confirmed by counsel for Ghana, Qatar and the United Kingdom before launch. Where law requires longer retention, the law wins and is configured as a legal hold. |

## 1. Definitions

| Term | Meaning |
|---|---|
| Company | The EstatePro customer account (an agency, property manager, developer or landlord business). Every media item belongs to exactly one Company. |
| Media item | One row in `property_media`, plus its stored files: the **master** (private, at most 4,096 px, metadata removed) and the **variants** (resized WebP copies). Raw uploads are never kept (M-D3). |
| External link | A video or virtual tour hosted elsewhere (YouTube, Vimeo, Matterport; M-D2). EstatePro stores the link, not the content. |
| Archived | Hidden from galleries and listings, but recoverable for 90 days (M-D8). |
| Purged | Files permanently deleted from storage, and the database row removed. Only audit entries remain. |
| Legal hold | A flag that stops archiving from leading to purge, set while media is needed as evidence or by law. |

## 2. Ownership

1. **The Company controls its media.** Media uploaded to a Company's account is that Company's data. EstatePro processes it on the Company's behalf (as processor) to store, resize and show it to the Company's authorised users. It is not used for any other Company, for marketing by EstatePro, or for training AI models.
2. **Rights in the content stay with whoever holds them.** Photographers, landlords or the Company may hold copyright. The Company is responsible for having the right to upload and publish each item. Customer terms will say this, and the upload screen states it.
3. **Staff do not own what they upload.** `uploaded_by` records who uploaded an item, for audit only. When a staff member leaves the Company (membership ended), their uploads stay with the Company.
4. **No cross-company sharing.** Media is never visible to, copied to or moved to another Company by the platform. Tenant isolation (row-level security, company-prefixed storage keys, permission checks before every link) enforces this technically.
5. **Metadata.** All embedded metadata (EXIF, IPTC, XMP) is removed from the master and the variants. GPS location is never stored or served (M-D7).

## 3. Landlord separation

Landlords use EstatePro through the landlord portal of the Company that manages or markets their property. They are not the controller of that Company's media.

| Situation | Behaviour |
|---|---|
| Landlord views media | Through the portal (Phase 7, issue #12), landlords see the variants (never masters) of media on properties they currently own. Access ends automatically when the ownership record or management agreement ends. |
| Landlord supplied the photos | The Company holds them under whatever permission the landlord gave. If the landlord withdraws permission, the Company archives the items and removes them from listings. If the landlord asks for deletion, the Company uses the erasure workflow (§7.3). |
| Management or instruction ends | Media stays with the Company, which may need it for completed transactions, disputes or retention obligations. Published listings are withdrawn under the listing rules, so no media is shown publicly after the relationship ends. The Company may give the landlord copies (export, §6). |
| Landlord is also a staff member or another Company | Each membership is separate. Portal access never grants staff access, and vice versa. |

## 4. Agency changes

| Situation | Behaviour |
|---|---|
| A property moves from Agency A to Agency B, both EstatePro customers | No automatic transfer. Agency A's media stays in Agency A's account under this policy. Agency A may export the files and pass them to Agency B, subject to the rights in §2.2. Agency B uploads them as new media. A consented transfer feature, if wanted, is a future product decision with its own privacy review. |
| A staff member moves to another agency | Their access ends with their membership. Media they uploaded stays with the first agency. |
| Agencies merge (one account absorbs another) | A platform-assisted migration under a written instruction from both Companies, handled by platform support under an audited support grant. Not self-service. |

## 5. Retention obligations

| Data | Retention |
|---|---|
| Active media (not archived) | For as long as the Company keeps it, subject to its plan's storage quota (Starter 25 GB, Professional 250 GB, Enterprise 2 TB; M-D4). |
| Archived media | Recoverable for **90 days** from archiving, then purged automatically (M-D8), unless under legal hold. |
| Media under legal hold | Kept until the hold is released, whatever its archive date. Typical holds: evidence for an inspection or deposit dispute (Phase 7), a complaint, litigation, or a regulator's request. |
| Raw uploads | Never kept. Deleted once processing ends, or within 1 day if processing never completes (storage lifecycle rule on the quarantine area). |
| Uploads rejected by the security scan | Files deleted immediately. The audit entry (file name, size, checksum, signature name) is kept for the audit retention period. |
| Abandoned upload requests | Reservations released after 1 hour. Files, if any, are removed by the 1-day quarantine lifecycle rule. |
| Audit entries about media | Retained like other non-financial audit events (2 years; Phase 1 §14.5). They hold metadata only, never image content. |
| External links | Removed with the media item. The external host's own retention is outside EstatePro's control. |
| Backups | Database backups follow the platform's point-in-time recovery window. Object storage is not versioned, so purged files are not recoverable from storage. A purge is therefore permanent once its 90-day archive period has passed. |

## 6. Account closure

Follows Phase 1 §14.5 and ADM-09:

1. **Cancellation.** The Company moves to `cancelled`. Users can no longer edit. Owners and administrators can export.
2. **Export.** The data export (ADM-09, Phase 14) includes every non-purged media master and its metadata (captions, alt text, room and floor labels, ordering per listing).
3. **Deletion.** **90 days after cancellation**, all media files of the Company are purged from storage and its media rows are deleted, except items under legal hold. Legal-hold items are kept until released, then purged.
4. **Reactivation within 90 days** restores the account with its media intact.
5. The account-closure purge is implemented with the subscriptions work (Phase 14). It reuses the purge procedure of §7.2.

## 7. Deletion workflows

### 7.1 Archive (reversible)

- **Who:** members with `property.archive` covering the property (and `listing.archive` to remove an item from listings).
- **Effect:**
  - the item disappears from galleries and listing selections;
  - a `listing_media` cover is cleared, and the listing must choose a new cover;
  - its files stay in storage;
  - `archived_at` is set and an audit entry `media.archived` is written.
- **Restore** within 90 days with `media.restored`. The item returns to the property gallery; listings re-select it as needed.

### 7.2 Automatic purge (after 90 days)

A daily worker job finds media archived more than 90 days ago and not under legal hold. For each item it:

1. deletes the master and all variants from storage;
2. releases the bytes from the Company's storage usage;
3. deletes the `listing_media` rows and the `property_media` row;
4. writes an audit entry `media.purged` (system actor) holding the item's metadata.

The job is idempotent. A storage file that is already gone counts as deleted.

### 7.3 Immediate erasure (on request)

For a data-subject erasure request (for example, a person identifiable in a photo), or a rights holder's takedown:

- **Who:** members with `property.archive` at `all` scope (Company Owner, Office Administrator).
- **How:** `POST /api/v1/media/{id}/purge` with a reason. The item must already be archived (two deliberate steps), and must not be under legal hold. The purge then runs as in §7.2 without waiting for 90 days, and audits `media.purged` with the reason and the requesting member.
- Erasure is refused while a legal hold is in place. The Company records why it is keeping the item, under the "subject to legal retention" rule (Phase 1 §6).

### 7.4 Legal hold

- **Who:** members with `property.archive` at `all` scope set or release a hold, with a reason.
- **Effect:** while held, the item cannot be purged (automatically or on request). It can still be archived, which hides it from galleries.
- Setting and releasing a hold are both audited (`media.legal_hold_set`, `media.legal_hold_released`).

### 7.5 Account closure

As §6. Implemented in Phase 14 with the same purge procedure.

## 8. Responsibilities

| Party | Responsibility |
|---|---|
| Company (customer) | Rights to upload and publish media; landlord permissions; answering data-subject requests; deciding legal holds; exporting before account deletion. |
| EstatePro (platform) | Secure storage in the Company's region, metadata stripping, malware scanning, enforcing isolation and this policy's automatic retention, providing export and erasure tools, auditing every action. |
| Platform support | Accesses a Company's media only under an approved, time-limited, audited support grant (Phase 1 §10.3). |

## 9. Implementation in Milestone 4

| Policy item | M4 implementation |
|---|---|
| §2.5 metadata | Worker strips all metadata and never stores GPS. |
| §5 raw uploads, quarantine | Raw files are deleted after processing; quarantine lifecycle rule; abandoned-upload cleanup job. |
| §5 rejected uploads | Immediate deletion; audit `media.rejected`. |
| §7.1 archive and restore | API actions with audit entries. |
| §7.2 automatic purge | Daily worker job. |
| §7.3 immediate erasure | `POST /media/{id}/purge`. |
| §7.4 legal hold | `legal_hold` columns, the hold endpoint, and enforcement in both purge paths. |
| §3 landlord access | Not in M4. Portal endpoints arrive with issue #12 (Phases 5–7); until then portal users cannot reach media (fail-closed). |
| §6 account closure | Phase 14, reusing the §7.2 procedure. |
