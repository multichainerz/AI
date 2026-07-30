# Phase 3 Document and OCR Runbook

## Current operating mode

The Phase 3 candidate provides an on-premises, governed document pipeline backed by PostgreSQL, `pg-boss`, S3-compatible object storage, LibreOffice/Poppler, and an administrator-configured Unlimited OCR endpoint. Approved enterprise identities can manage their own documents. Scoped administrators can review quarantine decisions and inspect fleet-level metrics.

This phase does not publish content to Supermemory or expose it to Chat or Hermes. Those paths remain default-denied until Phase 4 adds permission-aware synchronization and retrieval.

## Deployment

Apply the committed Prisma and queue migrations, build the images, and start the API and worker:

```bash
pnpm --filter @aihub/database prisma:migrate:deploy
pnpm jobs:migrate
pnpm build
pnpm dev
pnpm dev:worker
```

The worker image includes headless LibreOffice and Poppler. The API and worker both need access to PostgreSQL and the configured internal service endpoints. Routine endpoint and credential values are entered in AIHub; only the protected database URL, master key, and bootstrap token remain installation bootstrap values.

## Required AIHub connections

Configure, enable, and successfully test exactly one connection of each kind:

- **S3:** endpoint, bucket, signing region, optional path-style addressing, object-operation timeout, and a least-privilege application access-key pair with an optional temporary session token. Grant only the bucket and object read, write, delete, and health-check permissions required by the pipeline. The API stores quarantined originals; the worker stores page and normalized artifacts.
- **OCR:** internal OpenAI-compatible endpoint, model alias, chat-completions path, per-page inference timeout, and write-only API key when required.
- **OIDC:** enterprise issuer, client registration, callback, claim mappings, and at least one allowed group for end-user document access.

The runtime fails closed when S3 or OCR is missing, disabled, not healthy, or ambiguous. Service credentials are decrypted only in backend memory and are never returned to the browser.

## Supported inputs and limits

- PDF, PNG, JPEG, TXT, DOCX, XLSX, and PPTX;
- one file per request;
- 50 MB maximum original file size;
- 500 converted pages maximum;
- 25 MB maximum per converted page image;
- 20 million characters maximum for normalized text and Markdown.

AIHub checks file signatures and extensions, calculates SHA-256, normalizes the file name, and rejects empty, unsupported, oversized, or duplicate active uploads. An arbitrary ZIP renamed to an Office extension can still reach quarantine but will fail conversion; use an approved malware-scanning control in front of or inside the quarantine workflow when required by MPM policy.

## Lifecycle

1. An authorized user uploads a document with classification and retention metadata.
2. AIHub stores the original under a quarantine key and records its ownership, checksum, lifecycle, artifact, and audit records in PostgreSQL.
3. A scoped administrator approves or rejects the quarantine item with a recorded reason.
4. Approval increments the processing generation and submits one singleton conversion job through `pg-boss`.
5. The worker converts supported content into page images. Plain UTF-8 text follows a direct normalization path.
6. Page-based content submits one singleton OCR job. OCR runs sequentially per document to keep GPU pressure predictable.
7. AIHub stores normalized text, Markdown, JSON metadata, checksums, page count, completion state, and audit events.
8. Failed or completed records may be reprocessed as a new generation. Obsolete referenced artifacts are cleaned without deleting the active generation records.

Lifecycle states are `QUARANTINED`, `QUEUED`, `CONVERTING`, `OCR_PENDING`, `OCR_PROCESSING`, `READY`, `FAILED`, `REJECTED`, `DELETING`, and `DELETED`.

## Access and retention

- Enterprise users receive explicit `documents:use` capability and can see only records owned by their stable AIHub subject.
- Administrators require separate read, review, reprocess, and delete scopes.
- Quarantine approval and rejection are administrator-only actions.
- Documents cannot be deleted while processing.
- Deletion before `retentionUntil` requires a scoped administrator, an explicit force flag, and a recorded reason.
- Successful deletion removes referenced S3 objects and normalized database content while retaining the tombstoned document and audit history.

## API surface

- `GET|POST /api/v1/documents`
- `GET /api/v1/documents/metrics`
- `GET|DELETE /api/v1/documents/:documentId`
- `POST /api/v1/documents/:documentId/quarantine-decision`
- `POST /api/v1/documents/:documentId/reprocess`
- `GET /api/v1/documents/:documentId/artifacts/:artifactId/download`

Document responses use `Cache-Control: no-store`. Downloads require the same ownership or administrator authorization as document inspection.

## Failure and recovery behavior

- Queue submission failures mark the generation failed and remain visible for reprocessing.
- Conversion and OCR jobs use retries, exponential backoff, heartbeat expiry, singleton generation keys, and the shared dead-letter queue.
- Workers claim only the active document generation. Stale or duplicate deliveries complete as skipped work rather than mutating a newer generation.
- Reprocessing writes generation-specific S3 keys and updates the active artifact references idempotently.
- Missing page artifacts, invalid UTF-8, converter failures, OCR rejection, timeouts, oversized results, and storage failures are surfaced as sanitized failure states.
- Operators can inspect queue state and redrive dead letters from Operations. A redrive should follow root-cause correction; it does not replace document-level reprocessing.

## Phase 3 acceptance still required

- Validate representative MPM PDFs, scans, DOCX, XLSX, and PPTX files against the real converter and Unlimited OCR model.
- Measure OCR accuracy, page ordering, tables, handwriting behavior, latency, throughput, and GPU contention.
- Exercise S3 credentials, bucket policy, addressing mode, TLS, capacity, object corruption, backup, restore, and lifecycle procedures.
- Verify cross-user isolation, administrator scopes, forced-retention deletion, session revocation, and credential isolation.
- Test worker termination during conversion and OCR, queue retries, dead-letter redrive, and new-generation reprocessing.
- Approve classification, retention, deletion, malware-scanning, maximum-size, and operational ownership policies.
- Demonstrate that deleted or expired content is removed according to policy before Phase 4 publishes any content to Supermemory.
