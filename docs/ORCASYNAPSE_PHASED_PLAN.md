# OrcaSynapse Cohesion and Delivery Plan

This plan records what the current release implements and what remains environment-specific. OrcaSynapse is the enterprise control plane around one isolated Hermes runtime and one approved OpenAI-compatible inference service.

> **Revision note:** the external memory plane described by Phase 0 and Phase 3 was removed in stages. Document ingestion, embedding, and retrieval moved into a local pgvector index inside OrcaSynapse's PostgreSQL (v0.2.0–1.21), and the remaining agent-memory service was removed from VM2 entirely (v0.5.0). Phase entries below are preserved as the historical delivery record; the invariants section reflects the current architecture.

> **Interface note:** the current public navigation uses **Dashboard** and **Session**. Historical phase entries below retain the **Home** and **Chat** names used when that work shipped.

## Product architecture

The dashboard has six product areas with one owner each:

1. **Dashboard** — the full-screen readiness command center, existing workspace metrics, and the next useful action.
2. **Session** — the employee-facing governed Hermes conversation surface.
3. **Knowledge** — local extraction and pgvector ingestion, status, provenance, retention, and deletion.
4. **Agents** — immutable Hermes Profiles, runtime policy, runs, safe events, tools, and approvals.
5. **Platform** — AI Inference, Agentic System enrollment, optional Enterprise Access, models, prompts, and guardrails.
6. **Operations** — health, incidents, Hermes run state, release evidence, and Production acceptance.

## Completed application phases

### Phase 0 — Contract proof and architecture freeze

- Verified Supermemory Local authentication, file upload, status, deletion, and search contracts against the deployed VM2 service; new nodes use v0.0.7-rc.2 for its upstream large-document workflow fix.
- Verified UTF-8 TXT ingestion end to end.
- Recorded the honest rich-file limitation: the local API accepts PDF, DOCX, and images, but extraction can fail without the upstream cloud extractor.
- Froze VM1, VM2, and inference ownership and the six-area information architecture.

### Phase 1 — Cohesive dashboard foundation

- Replaced duplicate top-level destinations with Home, Chat, Knowledge, Agents, Platform, and Operations.
- Preserved legacy hashes while emitting canonical routes.
- Extracted capability-based Home from the application shell.
- Home now requires healthy inference, an online Hermes node, enabled execution policy, and an active Profile instead of counting connection records.

### Phase 2 — Simplified Platform setup

- Reduced setup to AI Inference, Agentic System, and optional Enterprise Access.
- Added inference discovery and validation rather than requiring guessed API paths.
- Gated the VM2 installer on administrator and inference readiness.
- Kept Production evidence and recovery details available without blocking development use.

### Phase 3 — Supermemory-native Knowledge *(superseded by the local pgvector knowledge plane — see revision note)*

- Replaced scratch storage, conversion, OCR, document workers, and publication retry queues with a bounded streaming relay to Supermemory.
- Retained metadata only in PostgreSQL and zero source bytes in OrcaSynapse.
- Merged Documents and Memory into one Knowledge workspace and removed the duplicate Memory API/screen.
- Added owner-derived namespace tags, duplicate detection, projected indexing state, and direct deletion.

### Phase 4 — Hermes-first Chat

- Removed the direct inference Chat implementation.
- Bound every conversation to an active immutable Agent Profile, a stable Hermes memory key, and bounded complete-turn history.
- Created one durable Agent Run per message with a distinct idempotency key, explicit cancellation, a single PostgreSQL result writer, and a resumable cursor-based event stream.
- Added structured message deltas, tool and subagent activity, allow-once or deny approval decisions, reload recovery, Markdown responses, and first-token, reasoning-token, latency, and throughput telemetry.
- Added rename, search, fork, archive/restore, safe JSON export, retry, feedback, and guarded permanent deletion without duplicating the Agents execution surface.
- Kept model credentials and policy at OrcaSynapse; the browser talks only to the control plane.

### Phase 5 — Hermes-aligned Agents and tools

- Uses Hermes concepts: Profiles, `SOUL.md`, Skills, sessions, runs, and managed configuration.
- Supports immutable Profile revisions, standby validation, activation, suspension, runtime kill switch, and safe run inspection.
- Removed the duplicate task composer from Agents; Chat is the single user execution surface.
- Retired and blocked the removed document-memory resynchronization handler. Governed MCP remains zero-tool by default. The read-only metadata handler is implemented but unreachable: no shipped Hermes advertises the private run-context contract it requires, and Hermes forwards no caller identity to an MCP server, so a call cannot be owner-scoped.

### Phase 6 — Correlated operations

- Simplified the runtime executor to one durable workload: Hermes Agent Runs.
- Correlates Chat messages with Agent Runs and preserves sanitized Hermes events.
- Operations owns service topology, incidents, guardrail posture, workflow metrics, release evidence, and Production acceptance.

### Phase 7 — Removal and codebase closure

- Removed obsolete document, memory-publication, and tool-action processors.
- Removed duplicate Memory UI/API paths and inactive scratch volumes.
- Added a migration that closes unfinished legacy work, disables obsolete grants, and drops retired staging schema.
- Updated architecture, PRD, runbooks, and public positioning to match shipped behavior.

## Environment acceptance still required

These are customer deployment gates, not missing dashboard architecture:

- TLS/mTLS and firewall evidence for the actual VM1, VM2, and inference networks.
- Exact image/release pins and signed artifact policy.
- PostgreSQL and Hermes backup/restore drills against the customer RPO/RTO.
- GPU capacity, concurrency, cancellation, and soak tests with the selected model.
- OIDC/Microsoft Entra ID group mapping and deprovisioning acceptance.
- Owner-scope isolation testing between users inside the organization. Tenancy is achieved per deployment: one installation serves one organization, so there is no in-installation tenant boundary to certify.
- Security, infrastructure, product, and business Production sign-off.

## Architecture invariants

1. OrcaSynapse owns enterprise identity, authorization, policy, orchestration, and audit.
2. Hermes is the only normal Chat and agent-execution path.
3. VM2 runs the agent runtime and holds no durable store; knowledge lives in OrcaSynapse's local pgvector index and never transits VM2.
4. PostgreSQL owns control state, metadata, extracted knowledge chunks, and their embeddings — never original source files.
5. Original files remain authoritative in enterprise systems; failed ephemeral ingestion requires re-upload.
6. Inference servers serve models but do not own enterprise policy or credentials.
7. No Redis, Valkey, pg-boss, LiteLLM, object store, external vector database service, or OCR stack is required; pgvector ships inside the bundled PostgreSQL image.
8. Customer-environment controls remain visibly unproven until real evidence is recorded.
