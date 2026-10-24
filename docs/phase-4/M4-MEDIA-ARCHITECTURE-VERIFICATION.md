# Phase 4 · Milestone 4 · Media Architecture Verification Report

| | |
|---|---|
| Status | For product-owner review. No M4 code has been written. |
| Scope | Milestone 4 (Gallery and Floor Plans) of Phase 4, plus the background worker it introduces |
| Branch | `phase-4/property-management` (audit branch `audit/pre-phase-4` remains unmerged) |
| Sources checked | Phase 1 detailed specification (P1-D) §5.2 PRP-06, §6, §9 (architecture, storage, isolation), §12.6 upload flow, §15 threats, §16 scalability; Phase 1 baseline; Phase 2 migrations 0002, 0003, 0006, 0011, 0012, 0013; Phase 3 screens doc and validation gate item 5; Phase 4 Readiness Report §2 (M4); ADR-001 to ADR-004 |

## 0. Summary

The specification already fixes the main shape of this milestone:

- **Storage:** private, S3-compatible object storage with company-prefixed keys. Access is only through short-lived pre-signed URLs issued after a permission check (P1-D §9.4 item 5).
- **Upload flow:** pre-signed upload into a quarantine area, then confirmation, a malware scan and promotion to the company area. Thumbnails and previews come after the scan (P1-D §12.6).
- **Media scaling:** images are resized into standard sizes at upload and served through a CDN with long cache lifetimes (P1-D §16.1).
- **Workers:** separate queues per workload; media is one of them (P1-D §16.1).

The Phase 2 schema has `property_media` (one row per photo, video, floor plan, tour, site plan or brochure, with `processing_status` and a `derivatives` JSON column). It also has `scheduled_jobs` for timezone-aware jobs and `outbox_events` for domain events. **No worker process exists yet.**

This review found **6 schema gaps and 8 decisions** to make before implementation (§11). The two that change the design most are:

- **M-D5:** one photo cannot currently belong to both a sale and a rental listing, or be carried over when a unit is relisted. This needs a `listing_media` join table.
- **M-D2:** video upload (PRP-06, Must) requires transcoding. Recommendation: external video links only in M4, with uploaded video moved to a later milestone.

Recommended provider: **Cloudflare R2**, through a provider-neutral S3 adapter. It has the S3 API, no egress fees and EU jurisdiction buckets. SeaweedFS is used in tests and AWS S3 is the fallback where a region rule requires it.

## 1. Storage architecture

### 1.1 Cloudflare R2 (recommended primary)

| Aspect | Assessment |
|---|---|
| API | S3-compatible, so the same AWS SDK v3 client works against R2, AWS S3 and SeaweedFS (used in CI). |
| Cost model | Storage about US$0.015 per GB-month. Writes (Class A) about US$4.50 per million; reads (Class B) about US$0.36 per million. **No egress fees.** These are list prices at the time of writing and must be confirmed at procurement. |
| Location | Location hints (for example Western Europe) and jurisdiction-restricted buckets (EU) that keep data in that jurisdiction. There is no Africa or Middle East jurisdiction. |
| Pre-signed URLs | Pre-signed `GET` and `PUT` are supported. **Pre-signed `POST` with a policy is not supported**, so the file size cannot be capped by a policy condition. M4 signs `Content-Length` and `Content-Type` into the `PUT` signature, and the worker checks the real size before accepting the file (§2.4). An integration test against R2 itself is needed before production; SeaweedFS behaviour differs. |
| Lifecycle | Object lifecycle rules (expire objects by prefix and age) and aborting incomplete multipart uploads are supported. |
| CDN | Served through Cloudflare's CDN on a custom domain; edge rules or Workers can check signed tokens (§6). |

### 1.2 S3-compatible alternatives

| Provider | When to use it | Trade-off |
|---|---|---|
| AWS S3 | When a company's data must stay in a region R2 cannot guarantee, such as the Gulf (`me-central-1`, UAE) or Africa (`af-south-1`, Cape Town) | Egress is charged (about US$0.09/GB), so it is worse for public listing images |
| Backblaze B2, Wasabi | Cheaper storage-only alternatives | Fewer regions and weaker CDN integration; not recommended for launch |
| SeaweedFS (self-hosted) | CI and local development only (already in Docker) | Not a production option |

**Design rule:** the API and worker use a `StoragePort` interface. Endpoint, bucket, region and credentials come from configuration per **cell** (`companies.data_region`, P1-D §9.4). A company's media lives in the bucket of its cell, and nothing in code depends on the provider.

**Data residency:** Ghana, Qatar and UK launch markets (§10, risk R-1). UK personal data can be held in the EU (UK adequacy regulations). Whether Ghanaian and Qatari companies' media may be held in an EU bucket needs **legal confirmation**. Property photos usually contain little personal data, but interior photos can show personal items and people. Until legal answers, the recommendation is one EU-jurisdiction R2 bucket per environment, with AWS S3 in-region available per cell if required.

### 1.3 Tenant isolation

Isolation is enforced at four points:

1. **Key layout.** Keys are generated by the server only; a client never supplies or sees a key:
   - `{company_id}/media/{media_id}/original` (private master)
   - `{company_id}/media/{media_id}/{variant}.webp` (sizes)
   - `quarantine/{company_id}/{upload_id}` (unscanned)
2. **Authorisation before every URL.** Upload and download URLs are issued only after the same record-level checks as M2/M3: `assertPropertyAccess` or `assertListingAccess`, inside a tenant transaction with row-level security.
3. **Database.** `property_media` already has `company_id`, row-level security and composite foreign keys. A media row cannot point at another company's property, unit or listing.
4. **Worker.** Each job payload carries `company_id`. The worker opens the same tenant transaction (`app.company_id`) before touching rows, and refuses keys whose prefix does not match the job's company.

Storage tokens cannot be scoped by prefix in R2 (they are per bucket), so prefix isolation relies on points 1–4. Cross-company tests must show that a member of company A cannot obtain a URL for company B's media by id, listing or property, and that a forged key is never accepted.

### 1.4 Private and public assets

| Asset | Visibility in Phase 4 | Later |
|---|---|---|
| Raw upload (quarantine) | Private; deleted after processing or within 24 h | — |
| Original / master | Private; never served to browsers; used only for re-processing | — |
| Size variants (thumbnail, display) | Private; served through short-lived signed `GET` URLs (15 min) | For published listings, a public, cache-friendly copy for website and portal feeds (PRP-10, D5) |
| Floor plan PDF | Private; downloaded with `Content-Disposition: attachment` | Same as variants for published listings |
| External video and virtual-tour links | Stored as URLs; allow-listed hosts only | — |

Nothing is public in Phase 4. This matches P1-D §9.4 and the Phase 1 baseline rule "no public bucket". The public path for feeds is designed in §6, not built.

## 2. Upload security

### 2.1 Upload flow (P1-D §12.6, adapted)

1. **Request an upload.** `POST /api/v1/media/uploads` with the target (property, unit or listing), media type, file name, size, content type and SHA-256 checksum. The API then:
   - checks the permission, quota (§2.5), allowed type and size limit;
   - creates an `upload_sessions` row that reserves the bytes against the quota;
   - returns a pre-signed `PUT` URL valid for 5 minutes, bound to that content type and length.
2. **Upload.** The client sends the file directly to quarantine storage; the API never handles the bytes.
3. **Confirm.** `POST /api/v1/media/uploads/{id}/confirm` checks with a `HEAD` request that the object exists and its size matches. It then creates the `property_media` row with `processing_status = pending` and writes an outbox event that queues the processing job.
4. **Worker.** Malware scan (§2.3), type check (§2.2), image decode and re-encode (§3), master and sizes written to the company prefix, quarantine object deleted. The row then becomes `ready`, `failed` or `rejected`, with an audit entry and a domain event.

### 2.2 File and MIME validation

The client's declared type is only a first filter. The worker decides by content:

| Check | Rule |
|---|---|
| Allow-list at request time | Photos: `image/jpeg`, `image/png`, `image/webp`, `image/heic`/`heif` (phone cameras). Floor plans and site plans: these plus `application/pdf`. Brochures: `application/pdf`. Everything else is refused (422). |
| Magic bytes | The worker sniffs the real type from the first bytes. A mismatch with the declared type means `rejected`. |
| Full decode | An image counts as valid only if it decodes completely (libvips through `sharp`). Polyglot and truncated files fail here. |
| Re-encoding | Every served image is re-encoded from decoded pixels, so no uploaded bytes are ever served as-is. |
| Rejected formats | SVG (script and XSS risk), GIF, TIFF, BMP and RAW are refused at request time. |
| PDF rules | Valid header and trailer; not encrypted; no JavaScript, launch actions, embedded files or XFA; at most 50 pages. Otherwise `rejected`. |
| File names | Stored as display metadata only, normalised (Unicode NFC, control characters removed, at most 200 characters). Never used in a storage key. |

### 2.3 Malware scanning

| Aspect | Recommendation |
|---|---|
| Engine | ClamAV (`clamd`) as a sidecar of the worker, behind a `MalwareScanner` port. It is free and self-hosted, so no file leaves the cell. A commercial engine can replace it later through the same port (DOC-06 in Phase 10 reuses it). |
| Signatures | `freshclam` updates at least every 2 hours. The worker refuses to scan, and leaves jobs pending, when signatures are older than 24 hours. |
| Fail-closed | If the scanner is unavailable or times out, the file stays `pending` and the job is retried with back-off. A file is never promoted without a clean result. After the final retry the row becomes `failed`, and the uploader can retry. |
| Infected file | The quarantine object is deleted, the row is set to `rejected` with reason `malware`, and an audit entry `media.rejected` records the signature name. The uploader sees "This file was blocked by the security scan." |
| Defence in depth | Images are re-encoded from pixels anyway (§2.2), so a scanner miss in an image cannot reach a browser as the original bytes. |

### 2.4 File size limits

| Media | Limit | Other limits |
|---|---|---|
| Photo | 25 MB | At most 100 megapixels, and at most 12,000 px on a side (decompression-bomb guard: `sharp` `limitInputPixels`) |
| Floor plan or site plan, image | 25 MB | As for photos |
| Floor plan or site plan, PDF | 20 MB | At most 50 pages |
| Brochure (PDF) | 20 MB | At most 50 pages |
| Video upload | Not in M4 (M-D2) | External link only |
| Per listing | At most 60 photos and 10 floor plans | Configurable per plan later |

Each limit is enforced three times:

- in the upload request (422);
- in the signed `Content-Length`;
- by the worker's `HEAD` size check before processing. An oversized object is deleted and the row rejected.

### 2.5 Quotas

Storage is a pricing driver (P1-D §2, BIL-01).

**Gap S-4:** `plan_entitlements` exists, but no storage entitlement is seeded. `usage_counters` is built for period counters, not a running total.

Proposal:

- Seed `plan_entitlements` with the feature key `storage.bytes` per plan. The values are a product decision (M-D4). Suggested: Starter 25 GB, Professional 250 GB, Enterprise 2 TB, with add-on packs later (Phase 14).
- Add a new table `storage_usage (company_id PK, bytes_used, bytes_reserved, updated_at)`, updated in the same transaction as the upload session (reserve), worker completion (commit actual bytes, release the reservation) and archive purge (release).
- An upload request that would exceed the entitlement returns 403 `quota-exceeded`. A nightly reconciliation job recalculates `bytes_used` from `property_media` and `document_versions` and alerts on drift.
- At 80% and 100% of the quota, emit `storage.quota_warning` (notifications arrive in Phase 12).

## 3. Image processing

| Aspect | Recommendation |
|---|---|
| Library | `sharp` (libvips): fast, memory-efficient, reads HEIC through libheif. It runs in the worker only, never in the API process. |
| Master | The original is decoded, auto-rotated from EXIF orientation and converted to sRGB. It is stored as a private master (JPEG quality 90, longest side at most 4,096 px). The raw upload is deleted after processing (M-D3); this cuts stored bytes by roughly 60% and still allows re-generating sizes later. |
| Sizes | WebP: `thumb` 320 px, `small` 640 px, `medium` 1,280 px, `large` 1,920 px (longest side, never enlarged). This covers list rows, cards, record pages and full-screen views at 1× and 2×. |
| Compression | WebP quality 80 (about 40–60% of an equivalent JPEG). The browser chooses the size through `srcset`. AVIF is not generated in Phase 4 (slow to encode); it can be added later from the master. |
| Content-addressed keys | Each variant key includes a short content hash, so the cached objects never change and can be cached for a year once served publicly (§6). |
| Metadata | **All EXIF, IPTC and XMP metadata is stripped from served images**, including GPS location, which can reveal an occupied home (privacy). The row keeps only width, height, byte size, MIME type, SHA-256 checksum, and the capture date if the product owner wants it (M-D7). GPS is never stored. |
| Accessibility | WCAG 2.2 AA (ADR-002) needs a text alternative. **Gap S-3:** `property_media` has `caption` but no `alt_text`. Add `alt_text` (required before an image can be the cover of a published listing), defaulting to the room label. |
| Failure | A decode failure, or an image over the pixel limit, sets the row to `failed` with a user-facing reason. The quarantine object is deleted. |

## 4. Floor plans

| Aspect | Recommendation |
|---|---|
| Supported formats | JPEG, PNG, WebP, HEIC and PDF. SVG is refused (XSS). CAD formats (DWG, DXF) are not supported; users export to PDF. |
| Validation | As in §2.2 and §2.4. In addition, images at least 800 px on the longest side (readability), and PDFs with at most 50 pages. The first page is the plan; extra pages are kept for download. |
| Preview generation | Images: the same sizes as photos, plus lossless PNG for `large` so lines stay sharp. PDF: the first page is rendered to PNG at 150 dpi in the worker (`pdftoppm` from Poppler, in its own process with time and memory limits), then resized as an image. The PDF itself is served only as a download. |
| Data | `media_type = 'floor_plan'`. **Gap S-3:** add `page_count` (for PDFs) and `floor_label` (for example "Ground floor"). `room_label` exists but means a room, not a floor. |
| Publishing checklist | M3's checklist gains "at least N photos" and "a floor plan" as **configurable** checks. Both are off by default, following the settings pattern of D2. |

## 5. Access control

| Audience | Rule in M4 |
|---|---|
| **Staff, view** | `property.view` scope on the property (M2 rules) to see property and unit media. For listing media, `listing.view` scope on the listing (M3 rules). Download URLs are issued per request, valid for 15 minutes. |
| **Staff, upload and edit** | Property and unit media: `property.update`. Listing media (attach, order, cover, alt text): `listing.update`. Archiving media: `property.archive` or `listing.archive`. Agents therefore manage media on listings assigned to them, consistent with D1. |
| **Landlord** | Not in M4. Portal endpoints and the linked-scope resolver come in Phases 5–7 (issue #12). When built, landlords see the size variants of media on properties they own (not masters). Portal memberships stay blocked by the guard until then. |
| **Tenant** | Not in M4. Later: media of their leased unit and its property, sizes only. Maintenance photos are a separate collection (Phase 8). |
| **Maintenance staff** | No property gallery access in M4 (the `assigned` scope covers property details; work-order photos arrive in Phase 8). |
| **Future website and portal feeds** | Deferred with PRP-10 (D5). M4 prepares for it: variant keys are content-addressed, and a `media.published` event fires when a listing is published, so a later feed service can copy the variants of published listings to a public, CDN-served location and remove them on unpublish or withdrawal. |

`property_media.uploaded_by` is set from the membership. Every upload, edit, reorder, cover change, archive and restore is audited.

## 6. Performance

| Aspect | Phase 4 (private) | With feeds (PRP-10) |
|---|---|---|
| CDN | Signed `GET` URLs go straight to R2 or S3. Staff traffic is small and not repeated. | A custom domain on Cloudflare's CDN in front of a public bucket of published-listing variants only. Masters and floor-plan PDFs never go there. |
| Browser caching | `Cache-Control: private, max-age=900` (matching the URL lifetime). The API returns the URL set (`srcset`) with each media item, so lists do not call once per image. | `public, max-age=31536000, immutable` (content-hashed keys). |
| API | Gallery lists use one query per property or listing, ordered by `sort_order`. URL signing is local computation, with no network call. | Feeds read only published data. |
| Upload throughput | Direct-to-storage upload; the API only signs. Worker concurrency is configurable per instance (default 4 images in parallel); scale by queue depth (P1-D §16.1). | — |

**Storage lifecycle policy:**

| Prefix or state | Rule |
|---|---|
| `quarantine/` | Bucket lifecycle rule: delete after 1 day (catches abandoned uploads). |
| Incomplete multipart uploads | Abort after 1 day. |
| Expired `upload_sessions` (never confirmed) | Cleanup job releases the quota reservation after 1 hour. |
| Archived media | Kept and restorable for 90 days, then purged by a job: objects deleted, `storage_usage` released, audit entry. The period is a product decision (M-D8). |
| Media referenced as evidence (inspections, Phase 7) | Excluded from the purge (legal hold, as for documents). |

## 7. Cost management

Prices are R2 list prices at the time of writing (storage US$0.015/GB-month, Class A US$4.50 per million, Class B US$0.36 per million, no egress). Confirm them at procurement.

### 7.1 Per-item assumptions

| Item | Stored size |
|---|---|
| Photo: master (≤4,096 px JPEG q90) | about 1.5 MB |
| Photo: 4 WebP sizes | about 0.6 MB together |
| **Photo total** | **about 2.1 MB** (about 4.6 MB if raw originals are kept: M-D3) |
| Floor plan (image or PDF plus preview) | about 3 MB |
| Average listing (20 photos and 1 floor plan) | about 45 MB |

### 7.2 Per-company estimates (first year)

| Company profile | New listings/year | Storage after 1 year | R2 storage cost/month at year end | Write operations/year (about 8 per file) |
|---|---|---|---|---|
| Small agency | 150 | about 7 GB | about US$0.10 | about 25k (about US$0.11) |
| Medium agency or manager | 1,500 | about 68 GB | about US$1.00 | about 250k (about US$1.13) |
| Large (100k-listing scale target) | 20,000 | about 900 GB | about US$13.50 | about 3.4M (about US$15) |

### 7.3 Platform growth assumptions

| Assumption | Value |
|---|---|
| Companies at end of year 1 | 300 (70% small, 25% medium, 5% large) |
| Listings per year | about 140k |
| Storage at end of year 1 | about 6.3 TB, about US$95/month |
| Storage at end of year 3 | about 3× companies and 2.5× listings per company: about 45 TB, about US$680/month (before archive purge) |

### 7.4 Bandwidth

| Scenario | Volume | R2 | AWS S3 for comparison |
|---|---|---|---|
| Phase 4, staff only | about 1M image views/month at about 150 KB | US$0 egress; read operations about US$0.36 | about 150 GB, about US$13.50 |
| With website feeds (PRP-10), year 1 | about 20M image views/month (CDN hit rate above 90%) | US$0 egress; at most 2M origin reads, about US$0.72 | about 3 TB, about US$270 (before CDN) |

**Conclusion:** storage dominates cost, and its biggest lever is M-D3 (keep a capped master, not the raw upload). The bandwidth cost of public feeds is what favours R2 over S3.

## 8. Database impact

### 8.1 Existing schema used as-is

- `property_media`: type, storage key or external URL, MIME, size, dimensions, checksum, caption, room label, sort order, `processing_status` (pending, ready, failed, rejected), `derivatives` JSON, `uploaded_by`, `archived_at`.
- `outbox_events` for job hand-off.
- `scheduled_jobs` (timezone-aware, idempotency key, `locked_until`, attempts) for timed work.
- `plan_entitlements` and `audit_logs`.

### 8.2 Gaps found

| ID | Gap | Proposed change (migration 0018) |
|---|---|---|
| S-1 | **A photo can belong to only one listing** (`property_media.listing_id`), so the same photos cannot serve a sale and a rental listing, and relisting (D3) cannot carry the gallery over without copying files. The one-cover-per-listing index is tied to that column. | New `listing_media (company_id, listing_id, media_id, sort_order, is_cover)`: primary key `(company_id, listing_id, media_id)`, composite foreign keys, a unique partial index for one cover per listing, and an index `(company_id, listing_id, sort_order)`. Media rows belong to the property (and optionally a unit). Listings select and order them; relist copies the `listing_media` rows. `property_media.listing_id` is deprecated: kept null, removal planned for Phase 16 cleanup. |
| S-2 | `property_media` has no `updated_at`/`version`, so caption, order and cover edits cannot use `If-Match` (ADR-003). | Add `updated_at` and `version`; the existing generic trigger then maintains both. |
| S-3 | Missing `alt_text` (WCAG 2.2 AA), `original_filename`, `page_count`, `floor_label`, `rejection_reason`, `processed_at`. | Add the columns, with length checks. |
| S-4 | No storage entitlement and no running storage total. | Seed `plan_entitlements` `storage.bytes` per plan (M-D4). New `storage_usage` table with row-level security. |
| S-5 | No record of upload intents between signing and confirmation (quota reservation, expected size and checksum, expiry). | New `upload_sessions (id, company_id, target_type, target_id, media_type, declared_mime, declared_size, sha256, quarantine_key, status, expires_at, created_by)`, generic so Phase 10 documents can reuse it. Row-level security and composite keys. |
| S-6 | The audit service only records `actor_type = 'user'`. Worker actions (expiry, processing results) need `system`. | No schema change (`system` is already allowed). Code change: a system context for the worker; `listing_status_history.changed_by` stays null for system changes. |

### 8.3 New indexes

| Index | Serves |
|---|---|
| `property_media (company_id, processing_status) WHERE processing_status = 'pending'` | Stuck-job sweeper |
| `property_media (company_id, archived_at) WHERE archived_at IS NOT NULL` | Archive purge |
| `listing_media (company_id, listing_id, sort_order)` and the unique cover index | Listing gallery |
| `listing_media (company_id, media_id)` | "Used in listings" and foreign-key checks |
| `upload_sessions (expires_at) WHERE status = 'pending'` | Expired-session cleanup |
| `listings (company_id, mandate_expires_on) WHERE status IN ('available','reserved','under_contract')` | Listing expiry. **Already exists** (`listings_mandate_expiry_idx`). |

### 8.4 Migration requirements

- Migration 0018 is additive only: new tables, columns, indexes and seeds, plus a comment deprecating `listing_id`. There is no production data yet, so no backfill is needed.
- New tables get the same row-level security policies, grants and composite keys as Phase 2. The catalogue tests from M1 check them automatically.
- Database verification (`verify.sh`), the column-mapping test and the OpenAPI contract test must pass.

## 9. Background worker

### 9.1 Process

| Aspect | Recommendation |
|---|---|
| Form | A separate Node process in the same repository (`apps/worker`), reusing the API's database, audit, storage and settings code. It is deployed separately and scaled by queue depth (P1-D §16.1). It has no HTTP surface apart from a health endpoint. |
| Queue (M-D6) | PostgreSQL-backed, with no new infrastructure: an **outbox relay** turns `outbox_events` into jobs, and workers claim them with `FOR UPDATE SKIP LOCKED`, with retries and back-off. One queue per workload (`media`, `schedule`, `maintenance`) so a burst of uploads cannot delay expiry jobs. A dedicated broker (for example Redis with BullMQ) can replace it behind the same port when volume requires. |
| Tenant safety | Each job carries `company_id`. The worker runs work through `TenantDb.run` with a system context, so row-level security applies to the worker too. |
| Idempotency | Every handler is safe to run twice: status checks before transitions, unique `scheduled_jobs.idempotency_key`, and storage writes to deterministic keys. |
| Observability | Logs include job id, company id and attempt. Failed jobs stay visible with `last_error`. Alert on queue age above 15 minutes. |

### 9.2 Scheduled jobs

| Job | Schedule | Behaviour |
|---|---|---|
| **Listing expiry** (M3 limitation) | Hourly sweep, jittered (P1-D §16.2) | Listings in available, reserved or under contract whose `mandate_expires_on` is before **today in the property's time zone** move to `expired` through the same status service as the API (D3: terminal, unpublished, `closed_at` set). Reason "Mandate expired". Status history has `changed_by` null; audit records actor `system`. Outbox event `listing.status_changed`. Hourly runs mean each time zone expires shortly after its local midnight. |
| Mandate expiring soon | Daily, per time zone | Emits `listing.mandate_expiring` (14 and 7 days ahead) for notifications in Phase 12. Event only; no notification code in M4. |
| Upload session cleanup | Every 15 minutes | Expires unconfirmed sessions and releases reserved quota. |
| Stuck processing sweeper | Every 15 minutes | Re-queues `pending` media older than 30 minutes, up to the retry limit, then marks it `failed`. |
| Archived media purge | Daily | Purges media archived more than 90 days ago (M-D8), unless held. |
| Storage reconciliation | Daily | Recalculates `storage_usage` and alerts on drift. |
| Housekeeping | Daily and monthly | Deletes expired `idempotency_keys`; monthly `app.ensure_monthly_partitions()` for `audit_logs`. |

### 9.3 Image processing queue

| Step | Detail |
|---|---|
| Trigger | `media.uploaded` outbox event, written by the confirmation endpoint |
| Job | Scan, then sniff, decode, master, sizes and (for PDFs) first-page preview. Write objects, update the row (`ready`, dimensions, derivatives, `processed_at`), commit `storage_usage`, delete the quarantine object, then audit entry and `media.processed` event. |
| Limits | Per-job time limit of 2 minutes for images and 5 minutes for PDFs. Memory capped by limiting `sharp` concurrency. PDF rendering runs in a separate process that is killed on timeout. |
| Retries | 5 attempts with exponential back-off for temporary errors (storage, scanner). No retry for content errors (invalid file, malware). |
| Throughput | About 1–2 s per 12-MP photo on one vCPU, so a 4-vCPU worker processes about 7,000–10,000 photos per hour. |
| Tests | Integration tests against SeaweedFS, with ClamAV in Docker. The EICAR test file must be rejected, and a mislabelled PNG, a decompression bomb, an encrypted or scripted PDF, and EXIF GPS stripping are all covered. |

## 10. Risks and mitigations

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R-1 | **Data residency** for Ghanaian and Qatari companies if media is stored in the EU | Medium | High (legal) | Legal confirmation before production (M-D1). Per-cell storage configuration allows in-region S3 without code changes. |
| R-2 | R2 does not support pre-signed `POST` policies, so size limits cannot be enforced by policy | High (known) | Medium | Signed `Content-Length` on `PUT`, a `HEAD` check on confirm, a worker size check, and quarantine lifecycle deletion. An integration test against real R2 before go-live. |
| R-3 | Malware scanner outage or stale signatures | Medium | High | Fail-closed (files stay pending). A signature-age check. Images re-encoded regardless. Alert on queue age. |
| R-4 | Malicious images (decompression bombs, parser exploits) | Medium | High | Pixel and dimension limits, a separate worker process with memory caps, timely `sharp`/libvips updates (dependency scanning in CI), and no processing in the API. |
| R-5 | Location or personal data leaking through EXIF | High if unmitigated | High (privacy) | Strip all metadata from served images and never store GPS (M-D7). |
| R-6 | Cross-tenant media access through id guessing or forged keys | Low | Critical | Server-generated keys, a permission check before every URL, 15-minute URLs, row-level security, and cross-company negative tests. |
| R-7 | Storage cost growth beyond plan pricing | Medium | Medium | Capped master instead of raw (M-D3), quotas per plan (M-D4), archive purge (M-D8), daily reconciliation. |
| R-8 | Worker backlog delays photos after bulk uploads | Medium | Low–Medium | Per-workload queues, autoscaling on queue depth, per-company concurrency limits (P1-D §16.2), and the UI shows "processing". |
| R-9 | **No uploaded video in M4** (PRP-06 says "upload or external link") | Certain if M-D2 is accepted | Medium | External links (YouTube, Vimeo, Matterport and similar, allow-listed) in M4. Uploaded video needs transcoding (FFmpeg or a managed video service) and a cost model; propose it as a separate milestone. |
| R-10 | Accessibility: images without text alternatives on published listings | Medium | Medium (WCAG 2.2 AA) | `alt_text` column; required for the cover of published listings; defaults from the room label. |
| R-11 | Gallery UI not yet wireframed (issue #7) | Certain | Low for M4, Medium for M6 | M4 is API and worker only; wireframes for issue #7 are delivered before M6 as planned. |
| R-12 | Worker system actions break the audit assumption that every actor is a user | Certain | Low | System context with `actor_type = 'system'` (S-6); tests check audit rows for expiry and processing. |

## 11. Decisions requested before M4 starts

| ID | Question | Recommendation |
|---|---|---|
| M-D1 | Storage provider and data location | Cloudflare R2, EU-jurisdiction bucket per environment, behind a provider-neutral S3 adapter. AWS S3 in-region per cell only if legal review requires it for Ghana or Qatar. |
| M-D2 | Uploaded video in M4? | No. External video and virtual-tour links (allow-listed hosts) in M4. Uploaded video with transcoding becomes its own milestone after cost review. |
| M-D3 | Keep raw originals? | No. Keep a private master (≤4,096 px, JPEG q90) and delete the raw upload after processing. |
| M-D4 | Storage quotas per plan | Starter 25 GB, Professional 250 GB, Enterprise 2 TB; add-ons in Phase 14. |
| M-D5 | Listing galleries | Media belongs to the property or unit; listings select and order it through a new `listing_media` table; relist copies the selection. |
| M-D6 | Job queue technology | PostgreSQL-backed queue (outbox relay plus `SKIP LOCKED`); replaceable behind a port. |
| M-D7 | Image metadata | Strip all metadata from served images; never store GPS. Store the capture date only if you want it shown (default: not stored). |
| M-D8 | Archived media retention | 90 days restorable, then purged (evidence media excluded). |

Once these are approved, the M4 plan is:

- **Migration 0018:** S-1 to S-5 (S-6 is a code change).
- **Storage and scanner ports**, with R2/S3 and ClamAV adapters.
- **Upload endpoints:** request, confirm, list, reorder, cover, edit (caption and alt text), archive, restore, and signed URL sets.
- **The worker:** outbox relay, media queue, listing expiry and the jobs in §9.2.
- **Tests:** against SeaweedFS and ClamAV in Docker.
