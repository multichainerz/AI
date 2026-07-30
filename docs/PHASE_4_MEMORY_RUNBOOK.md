# Phase 4 Knowledge and Memory Runbook

## Purpose

This runbook covers the private-scope Phase 4 acceptance candidate. AIHub publishes approved normalized documents to self-hosted Supermemory, retrieves supporting evidence for Chat, and displays synchronization health in the Memory workspace.

## Data boundary

- Supermemory is the only semantic index. AIHub does not create PostgreSQL vectors or a second embedding store.
- PostgreSQL remains authoritative for document ownership, lifecycle, publication state, audit records, and the source evidence attached to completed assistant messages.
- Enterprise repositories remain authoritative for original files. AIHub keeps extraction inputs and intermediates only in encrypted, time-bounded scratch.
- Supermemory owns the durable normalized knowledge and semantic graph. Its persistent data must be backed up as production data, not treated as a disposable cache.
- PostgreSQL does not contain enough document content to rebuild Supermemory by itself. A clean rebuild requires refetching authorized enterprise sources or re-uploading them through AIHub.
- Container tags are derived by AIHub from a hash of the stable owner subject. Clients cannot provide or override them.
- Every remote retrieval hit is re-authorized against PostgreSQL before it is added to the model context.
- The model receives retrieved text as untrusted reference material, not as system instructions.

The integration follows the current Supermemory document ingestion, search, deletion, and container-tag interfaces documented by the vendor:

- [Add a document](https://supermemory.ai/docs/api-reference/ingest/add-document)
- [Search documents](https://supermemory.ai/docs/api-reference/documents/search-documents)
- [Delete a document](https://supermemory.ai/docs/api-reference/ingest/delete-document-by-id-or-customid)
- [Container tags](https://supermemory.ai/docs/concepts/container-tags)
- [Self-hosting overview](https://supermemory.ai/docs/self-hosting/overview)

Validate these contracts against the exact pinned on-premises Supermemory release before promotion.

The current adapter publishes normalized text directly to the document API. Do not enable a second connector-driven ingestion path that bypasses AIHub's generation, ownership, publication, deletion, and reconciliation controls.

## Configuration

An authorized administrator configures Supermemory in AIHub under Integrations/connection settings. No routine endpoint or key belongs in a frontend environment variable.

Required values:

- internal HTTPS base URL;
- write-only API key, if the deployment requires one;
- health path used by connection diagnostics.

Optional service-specific settings:

- document and search paths;
- request and indexing timeouts;
- indexing poll interval;
- retrieval limit and relevance threshold.

The API and worker resolve and decrypt the active connection at request time. The key is never returned to the browser or written into queue payloads.

## Normal flow

1. A user uploads a document and an administrator approves quarantine.
2. The document worker converts/OCRs it and writes one normalized generation to encrypted scratch.
3. The worker creates or updates one PostgreSQL publication record and submits `aihub.memory.index` through `pg-boss`.
4. The memory worker publishes the normalized content with `taskType=superrag`, a stable custom ID, and the derived private container tag.
5. Publication becomes `READY` only after Supermemory reports indexing complete.
6. AIHub purges the source, page images, and normalized scratch content for the document.
7. Chat searches only the current user's derived container. AIHub then rechecks every hit locally and stores allowed sources on the assistant message.

## Operations and recovery

Use the Memory workspace to inspect queued, processing, ready, failed, and deletion-pending records.

- `FAILED` on a ready document: use **Retry sync** only while the UI marks the publication retryable and transient staging has not expired.
- `FAILED` on a deleted document: use **Retry sync** to resubmit remote deletion.
- `READY`: no reindex action is offered after scratch purge. Re-ingestion requires a fresh enterprise-source fetch or upload.
- Long-running `PROCESSING`: inspect worker liveness, the `aihub.memory.index` queue, Supermemory health, and request/indexing timeouts before retrying.

Back up and restore Supermemory's configured persistent data using the method approved for the exact pinned release. Test the backup as the primary recovery path. Separately demonstrate a clean rebuild by refetching a representative authorized corpus from its enterprise system of record and running it through AIHub again. Direct uploads whose enterprise originals are unavailable are intentionally not rebuildable after scratch purge; that limitation must be accepted or replaced with an enterprise-source connector before production.

Reprocessing a document temporarily removes it from retrieval eligibility until the new local generation and its memory publication are both ready. Local deletion immediately removes retrieval eligibility even if remote deletion is delayed.

## Acceptance checks

- A representative ready document reaches `READY` in Memory without duplicate publication records.
- Chat answers a known evaluation question and displays the correct supporting source.
- Another user cannot retrieve the document through Chat or direct API manipulation.
- Disabled, failed, reprocessing, rejected, and deleted documents cannot enter model context.
- A failed publication retries idempotently while scratch exists and fails closed after scratch expiry.
- Local deletion makes the source unavailable immediately and removes the remote item predictably.
- Queue retry, worker restart, Supermemory outage, timeout, and recovery paths do not corrupt publication state.
- A restored Supermemory instance passes retrieval and deletion checks, and an empty instance can rebuild a representative corpus from approved enterprise sources.
- Logs, audit metadata, API responses, and browser state contain no Supermemory credential.

## Current limitations

The candidate implements private per-owner knowledge only. Organization, department, project, and agent-shared scopes require approved identity claims, membership rules, document ownership policy, inheritance behavior, and revocation semantics. Do not simulate shared scope by weakening the ownership check or by sharing one broad container tag.
