# Phase 4 Knowledge and Memory Runbook

## Purpose

This runbook covers the private-scope Phase 4 acceptance candidate. AIHub publishes approved normalized documents to self-hosted Supermemory, retrieves supporting evidence for Chat, and displays synchronization health in the Memory workspace.

## Data boundary

- Supermemory is the only semantic index. AIHub does not create PostgreSQL vectors or a second embedding store.
- PostgreSQL remains authoritative for document ownership, lifecycle, publication state, audit records, and the source evidence attached to completed assistant messages.
- S3-compatible object storage remains authoritative for original files and generated OCR artifacts.
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
2. The document worker converts/OCRs it and commits a ready normalized generation.
3. The worker creates or updates one PostgreSQL publication record and submits `aihub.memory.index` through `pg-boss`.
4. The memory worker publishes the normalized content with `taskType=superrag`, a stable custom ID, and the derived private container tag.
5. Publication becomes `READY` only after Supermemory reports indexing complete.
6. Chat searches only the current user's derived container. AIHub then rechecks every hit locally and stores allowed sources on the assistant message.

## Operations and recovery

Use the Memory workspace to inspect queued, processing, ready, failed, and deletion-pending records.

- `FAILED` on a ready document: use **Retry sync** to submit a new generation-safe upsert.
- `FAILED` on a deleted document: use **Retry sync** to resubmit remote deletion.
- `READY`: use **Reindex** after correcting a remote index issue.
- Long-running `PROCESSING`: inspect worker liveness, the `aihub.memory.index` queue, Supermemory health, and request/indexing timeouts before retrying.

Reprocessing a document temporarily removes it from retrieval eligibility until the new local generation and its memory publication are both ready. Local deletion immediately removes retrieval eligibility even if remote deletion is delayed.

## Acceptance checks

- A representative ready document reaches `READY` in Memory without duplicate publication records.
- Chat answers a known evaluation question and displays the correct supporting source.
- Another user cannot retrieve the document through Chat or direct API manipulation.
- Disabled, failed, reprocessing, rejected, and deleted documents cannot enter model context.
- Reindex is idempotent for the active generation.
- Local deletion makes the source unavailable immediately and removes the remote item predictably.
- Queue retry, worker restart, Supermemory outage, timeout, and recovery paths do not corrupt publication state.
- Logs, audit metadata, API responses, and browser state contain no Supermemory credential.

## Current limitations

The candidate implements private per-owner knowledge only. Organization, department, project, and agent-shared scopes require approved identity claims, membership rules, document ownership policy, inheritance behavior, and revocation semantics. Do not simulate shared scope by weakening the ownership check or by sharing one broad container tag.
