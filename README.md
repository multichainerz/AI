# MPM AIHub

MPM AIHub is an on-premises control plane for internal AI chat, models, documents, memory, agents, MCP tools, policies, and operations.

## Current status

The locally implementable Phase 1 foundation is complete, and the Phase 2 controlled-chat, Phase 3 document/OCR, private-scope Phase 4 knowledge, zero-tool Phase 5 Hermes, governed MCP Phase 6, AI operations Phase 7, and pilot-readiness Phase 8 foundations are on-premise acceptance candidates. Phase 6 remains intentionally disconnected from live Hermes until per-run capability propagation passes interoperability testing. Live identity-provider, LiteLLM/vLLM, SeaweedFS, Unlimited OCR, Supermemory, Hermes, GPU, SIEM, network-security, recovery, load, training, pilot, and formal-approval acceptance remain environment-dependent. The repository currently contains:

- a responsive React administrative console for desktop and mobile;
- a Node.js/Fastify API foundation;
- shared TypeScript API contracts;
- a PostgreSQL/Prisma domain schema;
- an envelope-encryption package for the AIHub secrets vault;
- expiring, revocable administrator sessions with scoped foundation roles;
- authenticated, write-only connection credential APIs;
- a dashboard workflow for configuring LiteLLM, vLLM, Supermemory, SeaweedFS, OCR, and enterprise OIDC;
- credential-aware connection diagnostics with bounded timeouts, persisted health state, and audit events;
- typed health adapters for OpenAI-compatible endpoints, SeaweedFS S3, OIDC, MCP, and HTTP services;
- service-specific operational settings for model aliases, health routes, diagnostic timeouts, and SeaweedFS S3 behavior;
- PostgreSQL-native `pg-boss` queues with retry, heartbeat, and dead-letter policies;
- a dedicated worker runtime with persisted liveness records;
- authenticated Operations APIs and dashboard controls for queue health, probes, and dead-letter recovery;
- append-only connection revision history and guarded non-secret configuration rollback;
- queue-definition degradation, confirmed recovery actions, and bounded worker-history retention;
- persisted chat conversations and messages with ownership isolation;
- an approved-model chat route that resolves encrypted LiteLLM credentials only inside the API;
- OpenAI-compatible token streaming, cancellation, bounded context, failure handling, and usage metadata;
- OIDC authorization-code sign-in with PKCE, nonce and state validation, verified ID tokens, group allowlisting, and opaque revocable local sessions;
- a responsive Chat workspace for enterprise users with an explicitly identified administrator-preview recovery path;
- PostgreSQL-backed per-user request limiting, response feedback, and rolling 24-hour operator telemetry;
- ownership-scoped document upload with file sniffing, checksums, classification, quarantine approval, retention, and audited deletion;
- generation-safe `pg-boss` conversion and OCR jobs with LibreOffice/Poppler page rendering and retry-safe artifacts;
- SeaweedFS S3 storage for originals, page images, OCR text, Markdown, and structured OCR metadata;
- backend-only Unlimited OCR integration with bounded multimodal requests, timeouts, and same-origin endpoint enforcement;
- a responsive Documents workspace for upload, lifecycle review, content preview, artifacts, reprocessing, and operational metrics;
- durable publication of ready document generations to self-hosted Supermemory as the sole semantic index;
- private ownership-derived memory containers, local authorization rechecks, source-aware chat, deletion propagation, and retryable synchronization;
- a responsive administrator Memory workspace for publication health, failures, reindexing, and deletion recovery;
- encrypted dashboard configuration and health diagnostics for an isolated Hermes API server;
- immutable Hermes agent profiles with explicit activation, suspension, model assignment, private-knowledge permission, timeout, concurrency, and version history;
- PostgreSQL-backed agent run ledgers with `pg-boss` execution, cancellation, outputs, failures, sources, and audit evidence;
- fail-closed Hermes capability and toolset preflight, mandatory single-turn safe mode, zero native tools, runtime/profile revocation checks, approval denial, and a global kill switch;
- a responsive Agents workspace for desktop and mobile with profile lifecycle, runtime control, run submission, live status, cancellation, outcomes, and source provenance;
- a stateless MCP `2026-07-28` gateway with legacy `2025-11-25` compatibility, authenticated Streamable HTTP transport validation, and server discovery;
- hashed, one-time-visible, revocable gateway credentials plus short-lived per-run capability persistence;
- exact agent-version tool grants, exact group/administrator-role constraints, owner-only resource enforcement, and current-session revalidation;
- a governed tool-call ledger with idempotency protection, global and per-tool kill switches, audit events, and bounded internal handlers;
- expiring human approvals with explicit reviewer reasons and full authorization revalidation before approved work is queued;
- a responsive Integrations workspace for tool registry, grants, gateway credentials, approvals, calls, and metrics;
- a unified AI operations control room that distinguishes live, last-verified, and configuration-only health evidence;
- durable automated and operator-raised incidents with ownership, acknowledgement, resolution, and audit history;
- layered input, output, retrieval, model-access, tool-use, and data-egress guardrail posture;
- immutable chat, retrieval, OCR, tool-use, safety, and permission evaluation evidence with separate promotion authority;
- a promoted-evidence gate that fails closed before activating an exact Hermes agent profile version;
- a PostgreSQL-backed production-readiness ledger with seeded controls, owners, evidence, blockers, waivers, and optimistic revisions;
- append-only external Security, Infrastructure, Product, and Business decisions bound to exact readiness snapshots, with stale-approval invalidation;
- distinct process-liveness and database-readiness probes, API request correlation, graceful shutdown, and independent web-container health checks;
- high-level product and phased delivery documents.

## Prerequisites

- Node.js 24 or newer
- pnpm 10 or newer
- PostgreSQL for database-backed development

## Commands

```bash
pnpm install
pnpm db:generate
pnpm typecheck
pnpm test
pnpm verify
pnpm security:audit
pnpm dev
pnpm dev:worker
```

The web application defaults to `http://localhost:5173` and the API to `http://localhost:4000`.

## Configuration model

Service endpoints and credentials are entered through AIHub. The only external bootstrap values are the PostgreSQL connection string, the master key used to unlock the encrypted configuration vault, and the initial administrator setup token. Production deployment mounts these as protected files rather than routine environment variables.

For a local container deployment, run `node scripts/generate-bootstrap.mjs` once and then `docker compose up --build`. See [`deploy/BOOTSTRAP.md`](deploy/BOOTSTRAP.md) for production handling requirements.

The initial Compose deployment applies committed Prisma and `pg-boss` migrations before starting the API and worker. The bootstrap administrator token is submitted once to create a random, server-side session and is not reused as an API credential. The browser receives only an `HttpOnly`, `SameSite=Strict` session cookie; stored service secrets are write-only and their plaintext values are never returned by the API.

Authorized administrators can run `POST /api/v1/admin/connections/:id/test` from the dashboard. AIHub resolves the encrypted credential only inside the API process, blocks redirects during HTTP checks, and returns a sanitized `HEALTHY`, `DEGRADED`, or `UNREACHABLE` result to the browser.

Controlled chat requires exactly one enabled, successfully tested LiteLLM connection with a primary model alias. Enterprise access also requires exactly one healthy OIDC connection and at least one allowed group. AIHub streams the configured OpenAI-compatible chat route without returning infrastructure or identity-provider credentials to the browser. Conversations, final responses, cancellation/failure state, token usage, latency, feedback, sessions, and audit metadata are persisted in PostgreSQL. The scoped platform administrator remains available as a visibly labelled preview and recovery path; it does not replace enterprise sign-in for pilot acceptance.

Document processing requires exactly one enabled and healthy SeaweedFS connection and one enabled and healthy OCR connection. Uploaded content remains quarantined until an administrator approves it. The worker converts supported PDFs, Office Open XML files, and images into page images, invokes the configured OCR endpoint, and stores normalized outputs in SeaweedFS while PostgreSQL remains the lifecycle and audit system of record.

Knowledge retrieval requires exactly one enabled and healthy Supermemory connection. AIHub publishes each approved, ready document through a generation-safe `pg-boss` job using a stable custom ID and an ownership-derived private container tag. Supermemory remains the only semantic index; PostgreSQL stores lifecycle, authorization provenance, source evidence, and synchronization state, not embeddings. Retrieval results are re-authorized against the current local document owner, status, and publication before they can enter a model request. Department, project, organization, and agent-shared scopes remain a later Phase 4 gate pending MPM identity and ownership rules.

Hermes execution requires exactly one enabled and healthy Hermes connection, a strong API-server key, an active safe-mode profile, and the global runtime switch. AIHub refuses to enable that switch until Hermes passes a live authenticated capability and zero-enabled-toolset check, and the worker repeats the same preflight before each run. Phase 5 is restricted to one-turn, zero-tool work with optional requesting-user private knowledge. Hermes must run in an isolated container with no PostgreSQL, SeaweedFS administration, Coolify, Docker, host-filesystem, or unrestricted network access. Its provider bootstrap must separately route its approved model alias to MPM LiteLLM/vLLM because the current upstream API does not offer remote administrator configuration.

The Phase 6 MCP endpoint is `POST /api/v1/mcp/`; its administration APIs are under `/api/v1/admin/tooling`. AIHub uses two independent bearer factors: a revocable server credential configured once in the isolated Hermes MCP client and a short-lived capability bound to an exact AIHub agent run. The latter is stored only as a digest. The dashboard can stage tools, exact-version grants, and the gateway credential, but Phase 5 remains zero-tool until the worker can mint and safely convey that per-run capability and the deployed Hermes version passes protocol, leakage, revocation, and recovery acceptance.

Phase 7 operations APIs are under `/api/v1/admin/operations`. PostgreSQL remains the incident, evidence, and audit system of record. The dashboard reports PostgreSQL and `pg-boss` state live, while service connections are explicitly labelled as retained credential-aware checks rather than continuous monitoring. Completed evaluation evidence is immutable, promotion requires a separate scope and retained rationale, and Hermes agent activation requires a promoted `agent:<profile-slug>` candidate for the exact current version. GPU metrics, scheduled probes, notifications, SIEM delivery, and representative MPM regression data remain target-environment acceptance work.

Phase 8 readiness APIs are under `/api/v1/admin/operations/readiness`. AIHub records target-environment control evidence and externally issued authority decisions without claiming to grant those approvals. Updating any control invalidates earlier approval snapshots. `/healthz` reports process liveness; `/readyz` additionally requires an unlocked runtime and a live PostgreSQL query. Formal pilot approval remains impossible to demonstrate locally without MPM approvers and the deployed recovery, security, network, and load evidence.

Non-secret connection settings are validated against a per-service allowlist before storage and are included in immutable configuration revisions. Unknown keys and settings belonging to a different service type are rejected. Rollback creates a new revision and preserves current credentials rather than reactivating historical secrets. TLS certificate verification remains strict; private CA lifecycle support is an explicit target-environment gate rather than an unsafe bypass switch.

See [`docs/AIHUB_PRD.md`](docs/AIHUB_PRD.md), [`docs/AIHUB_PHASED_PLAN.md`](docs/AIHUB_PHASED_PLAN.md), the [`Phase 1 operations runbook`](docs/PHASE_1_RUNBOOK.md), the [`Phase 2 chat runbook`](docs/PHASE_2_CHAT_RUNBOOK.md), the [`Phase 3 document runbook`](docs/PHASE_3_DOCUMENT_RUNBOOK.md), the [`Phase 4 memory runbook`](docs/PHASE_4_MEMORY_RUNBOOK.md), the [`Phase 5 Hermes runbook`](docs/PHASE_5_HERMES_RUNBOOK.md), the [`Phase 6 MCP and approvals runbook`](docs/PHASE_6_MCP_APPROVALS_RUNBOOK.md), the [`Phase 7 AI operations runbook`](docs/PHASE_7_AI_OPERATIONS_RUNBOOK.md), and the [`Phase 8 production-pilot runbook`](docs/PHASE_8_PRODUCTION_PILOT_RUNBOOK.md).
