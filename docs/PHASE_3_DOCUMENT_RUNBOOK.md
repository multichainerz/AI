# Phase 3 Document and OCR Runbook

## Current operating mode

The Phase 3 candidate is an on-premises, governed content-extraction pipeline backed by PostgreSQL, `pg-boss`, an application-encrypted scratch volume, LibreOffice/Poppler, and an administrator-configured Unlimited OCR endpoint. AIHub is not an enterprise file repository. Original documents remain authoritative in the enterprise system that supplied them.

Approved content is held only long enough to convert, OCR, normalize, and publish through Phase 4 to Supermemory. Supermemory is the durable normalized knowledge and semantic graph. PostgreSQL stores metadata, ownership, provenance, lifecycle, publication, and audit state; it does not store source bytes or normalized document bodies.

## Deployment

Apply the committed Prisma and queue migrations, build the images, and start the API and worker:

```bash
pnpm --filter @aihub/database prisma:migrate:deploy
pnpm jobs:migrate
pnpm build
pnpm dev
pnpm dev:worker
```

The worker image includes headless LibreOffice and Poppler. API and worker instances must mount the same private scratch volume at `AIHUB_DOCUMENT_SCRATCH_DIR`. The directory is created with owner-only permissions, encrypted by AIHub before bytes reach disk, excluded from backups, and unavailable through the browser. A multi-host deployment requires an approved shared private volume or a future direct-fetch connector; node-local scratch is not sufficient.

## Required AIHub connections

Configure, enable, and successfully test:

- **OCR:** internal OpenAI-compatible endpoint, model alias, chat-completions path, per-page inference timeout, and write-only API key when required.
- **Supermemory:** internal Memory API used for the durable normalized publication that completes ingestion.
- **OIDC:** enterprise issuer, client registration, callback, claim mappings, and at least one allowed group for end-user access.

Routine endpoints and credentials are entered in AIHub. Only the protected PostgreSQL URL, master key, bootstrap token, and deployment-owned scratch mount are installation bootstrap dependencies.

## Supported inputs and limits

- PDF, PNG, JPEG, TXT, DOCX, XLSX, and PPTX;
- one file per request;
- 50 MB maximum source file size;
- 500 converted pages maximum;
- 25 MB maximum per converted page image;
- 20 million characters maximum for normalized content;
- 24-hour maximum scratch lifetime, extended when a valid processing generation is queued.

AIHub checks signatures and extensions, calculates SHA-256, normalizes the file name, and rejects empty, unsupported, oversized, or duplicate active uploads. Quarantine is an authorization step, not malware scanning; add an approved scanner at the ingress boundary when MPM policy requires one.

## Lifecycle

1. An authorized user uploads a document or a future connector fetches it from an approved enterprise source.
2. AIHub encrypts the source into a document-scoped scratch prefix and stores metadata in PostgreSQL.
3. A scoped administrator approves or rejects the quarantine item with a recorded reason. Rejection purges the prefix immediately.
4. Approval increments the processing generation and submits a singleton conversion job through `pg-boss`.
5. The worker writes generation-scoped page images to scratch. Plain UTF-8 text follows a direct path.
6. Page-based content submits a bounded OCR job containing identifiers and page metadata only—never file bytes or extracted text.
7. The worker writes one normalized Markdown representation to scratch and queues a generation-safe Supermemory publication.
8. Supermemory confirms durable publication, after which AIHub purges the entire document scratch prefix and records the purge timestamp.
9. A failed publication can be retried only before scratch expiry. After purge or expiry, a fresh upload or connector fetch is required.

Lifecycle states are `QUARANTINED`, `QUEUED`, `CONVERTING`, `OCR_PENDING`, `OCR_PROCESSING`, `READY`, `FAILED`, `REJECTED`, `DELETING`, and `DELETED`. `READY` means extraction completed; `DocumentMemoryPublication` separately records whether durable knowledge publication succeeded.

## Access, retention, and deletion

- Enterprise users can see only records owned by their stable AIHub subject.
- Administrators require separate read, review, reprocess, and delete scopes.
- Documents cannot be deleted while processing or memory synchronization is active.
- `retentionUntil` governs the durable knowledge record and deletion authorization, not scratch lifetime.
- Deletion before retention expiry requires a scoped administrator, a force flag, and a reason.
- Deletion purges any remaining scratch immediately and queues semantic deletion in Supermemory while retaining a tombstoned PostgreSQL audit record.

## API surface

- `GET|POST /api/v1/documents`
- `GET /api/v1/documents/metrics`
- `GET|DELETE /api/v1/documents/:documentId`
- `POST /api/v1/documents/:documentId/quarantine-decision`
- `POST /api/v1/documents/:documentId/reprocess`

There is no document-body, extracted-text, or intermediate-artifact download API. Responses use `Cache-Control: no-store`.

## Failure and recovery behavior

- Queue payloads carry document IDs, generations, and page media types only.
- Generation-specific scratch prefixes make retries idempotent; a conversion retry clears its own generation prefix first.
- Workers claim only the active generation. Stale or duplicate deliveries are skipped.
- Failed conversion, OCR, or publication retains scratch until the 24-hour deadline for bounded retry.
- A periodic worker sweep purges expired prefixes. Unpublished records become `FAILED/STAGING_EXPIRED`; successfully published knowledge remains ready.
- If publication succeeds but purge fails, memory remains `READY`, the document records `STAGING_PURGE_FAILED`, and the sweeper retries the purge.
- Operators correct the cause before redriving dead letters. A redrive does not recreate expired source content.

## Phase 3 acceptance still required

- Validate representative MPM PDFs, scans, Office files, and images against the real converter and OCR model.
- Measure OCR accuracy, ordering, tables, handwriting, latency, throughput, and GPU contention.
- Verify scratch encryption at rest, mount isolation, owner-only permissions, capacity alarms, 24-hour expiry, post-publication purge, crash recovery, and backup exclusion.
- Verify cross-user isolation, administrator scopes, forced-retention deletion, session revocation, and credential isolation.
- Test worker termination, retry, dead-letter redrive, publication outage, purge failure, and source re-upload after expiry.
- Approve enterprise-source ownership, classification, retention, deletion, malware-scanning, maximum-size, and operational ownership policies.
