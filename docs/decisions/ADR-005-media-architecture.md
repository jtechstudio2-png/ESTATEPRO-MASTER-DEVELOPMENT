# ADR-005 — Media storage, processing and retention

| | |
|---|---|
| Status | Accepted (product owner, "Milestone 4 Decisions Approved") |
| Context | [M4 Media Architecture Verification Report](../phase-4/M4-MEDIA-ARCHITECTURE-VERIFICATION.md) |
| Policy | [Media Ownership and Retention Policy](../policies/MEDIA-OWNERSHIP-AND-RETENTION-POLICY.md) |

| ID | Decision |
|---|---|
| M-D1 | Cloudflare R2 is the primary store, with AWS S3 as fallback. All storage access goes through a provider-agnostic `StoragePort` (S3 API), configured by endpoint, region, bucket and credentials. |
| M-D2 | Video and virtual tours are accepted as external links only (YouTube, Vimeo, Matterport). Direct video upload is deferred. |
| M-D3 | Raw uploads are not retained. A private master image of at most 4,096 px is kept for reprocessing. |
| M-D4 | Storage quotas: Starter 25 GB, Professional 250 GB, Enterprise 2 TB (`plan_entitlements.storage.bytes`). |
| M-D5 | `listing_media` links listings to media (selection, order, one cover per listing). `property_media.listing_id` is deprecated. |
| M-D6 | Background work uses PostgreSQL-backed queues (`scheduled_jobs` claimed with `FOR UPDATE SKIP LOCKED`); no broker. |
| M-D7 | All metadata is stripped from served media; GPS is never retained. |
| M-D8 | Archived media is recoverable for 90 days, then permanently deleted, unless under legal hold. |
