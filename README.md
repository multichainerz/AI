# MPM AIHub

MPM AIHub is an on-premises control plane for internal AI chat, models, documents, memory, agents, MCP tools, policies, and operations.

## Current status

The locally implementable Phase 1 foundation is complete, and the Phase 2 controlled-chat, Phase 3 document/OCR, private-scope Phase 4 knowledge, zero-tool Phase 5 Hermes, governed MCP Phase 6, AI operations Phase 7, pilot-readiness Phase 8, and Phase 9 cohesion/onboarding foundations are on-premise acceptance candidates. Phase 9 now includes the evidence-backed component gate, architecture-mode record, resumable setup journey, secret-free Profile Distribution source, standby lifecycle, and bounded Hermes activity projection. Automatic certificate-bound node enrollment, runtime Profile installation/reconciliation, delegation, conditional native memory, and all target-environment acceptance remain pending. AIHub's Phase 6 per-run handoff remains fail-closed until a hardened Hermes build advertises and passes the required private-context interoperability contract. Live identity-provider, LiteLLM/vLLM, Unlimited OCR, Supermemory, Hermes, GPU, SIEM, network-security, recovery, load, training, pilot, and formal-approval acceptance remain environment-dependent. The repository currently contains:

Phase 9 has been recalibrated against current primary component documentation. In particular, AIHub's generic OpenAI-compatible OCR client is a deployment contract to prove rather than an upstream Unlimited-OCR guarantee; Supermemory Local's private embedded store and local embedding are the streamlined defaults; Qwen3 Embedding is optional; Hermes built-in memory remains active and constrained even when Supermemory is used; LiteLLM is externally configured and validated unless a pinned management API is deliberately adopted; and one 96 GB GPU is not assumed to run Laguna, OCR, and embedding workloads concurrently.

- a responsive React administrative console for desktop and mobile;
- a Node.js/Fastify API foundation;
- shared TypeScript API contracts;
- a PostgreSQL/Prisma domain schema;
- an envelope-encryption package for AIHub's PostgreSQL-backed encrypted credential store;
- expiring, revocable administrator sessions with scoped foundation roles;
- authenticated, write-only connection credential APIs;
- a dashboard workflow for configuring LiteLLM, vLLM, Supermemory, OCR, Hermes, and enterprise OIDC;
- a versioned model catalogue with workload assignments, serving-connection validation, bounded limits, safe legacy adoption, and evaluation-gated activation;
- versioned chat guardrail policies with local input ceilings, approved per-request LiteLLM assignments, safety-evaluation gates, permanent fail-closed adoption, and sanitized rejection audits;
- versioned chat-system prompts with content checksums, CHAT and SAFETY evaluation gates, permanent fail-closed adoption, and runtime audit provenance;
- credential-aware connection diagnostics with bounded timeouts, persisted health state, and audit events;
- dashboard-controlled scheduled connection monitoring with PostgreSQL leases, multi-instance-safe claims, stale-lease recovery, and explicit evidence freshness;
- typed health adapters for OpenAI-compatible endpoints, OIDC, MCP, and HTTP services;
- service-specific operational settings for model aliases, health routes, and diagnostic timeouts;
- PostgreSQL-native `pg-boss` queues with retry, heartbeat, and dead-letter policies;
- a dedicated worker runtime with persisted liveness records;
- authenticated Operations APIs and dashboard controls for queue health, probes, and dead-letter recovery;
- append-only connection revision history and guarded non-secret configuration rollback;
- queue-definition degradation, confirmed recovery actions, and bounded worker-history retention;
- persisted chat conversations and messages with ownership isolation;
- an approved-model chat route that resolves encrypted LiteLLM credentials only inside the API;
- OpenAI-compatible token streaming, cancellation, bounded context, failure handling, and usage metadata;
- OIDC authorization-code sign-in with PKCE, nonce and state validation, verified ID tokens, group allowlisting, scoped administrator-group mapping, and opaque revocable local sessions;
- a responsive Chat workspace for enterprise users with an explicitly identified administrator-preview recovery path;
- PostgreSQL-backed per-user request limiting, response feedback, and rolling 24-hour operator telemetry;
- ownership-scoped document upload with file sniffing, checksums, classification, quarantine approval, retention, and audited deletion;
- generation-safe `pg-boss` conversion and OCR jobs with LibreOffice/Poppler page rendering and retry-safe transient intermediates;
- application-encrypted, shared transient staging for source files, page images, and normalized content, with automatic expiry and purge after publication;
- backend-only Unlimited OCR integration with bounded multimodal requests, timeouts, and same-origin endpoint enforcement;
- a responsive Documents workspace for upload, lifecycle review, staging visibility, bounded retry, and operational metrics;
- durable publication of ready document generations to self-hosted Supermemory as the sole semantic index;
- private ownership-derived memory containers, local authorization rechecks, source-aware chat, deletion propagation, and retryable synchronization;
- a responsive administrator Memory workspace for publication health, failures, reindexing, and deletion recovery;
- a persistent Phase 9 component-compatibility register, topology-derived readiness, immutable automated/external evidence, fail-closed environment gates, and an eight-stage responsive Deployment workspace;
- a short-lived atomic single-use installation claim, root-authorized recovery-claim flow, and customer-held encrypted credential-key recovery kit with retained verification evidence;
- encrypted dashboard configuration and health diagnostics for an isolated Hermes API server;
- immutable Hermes Profiles with `DRAFT`, evidence-gated `STANDBY`, `ACTIVE`, and `SUSPENDED` lifecycle, model assignment, private-knowledge permission, timeout, concurrency, and version history;
- secret-free Profile Distribution sources containing `SOUL.md`, checksummed Skill references, and deterministic SHA-256 digests pinned to new runs;
- PostgreSQL-backed agent run ledgers with `pg-boss` execution, cancellation, outputs, failures, sources, and audit evidence;
- bounded ingestion of documented Hermes Runs SSE lifecycle, tool, and subagent events, excluding token deltas, hidden prompts, chain-of-thought, credentials, tool arguments, and tool results;
- fail-closed Hermes capability and toolset preflight, mandatory single-turn safe mode, zero native tools, runtime/profile revocation checks, approval denial, and a global kill switch;
- a responsive Agents workspace for desktop and mobile with profile lifecycle, runtime control, run submission, live status, cancellation, outcomes, and source provenance;
- a stateless MCP `2026-07-28` gateway with legacy `2025-11-25` compatibility, authenticated Streamable HTTP transport validation, and server discovery;
- hashed, one-time-visible, revocable gateway credentials plus digest-only, retry-safe short-lived per-run capabilities;
- private-header-scoped MCP tool discovery and calls, with no run credential in prompts or tool arguments;
- exact agent-version tool grants, exact group/administrator-role constraints, owner-only resource enforcement, and current-session revalidation;
- a governed tool-call ledger with idempotency protection, global and per-tool kill switches, audit events, and bounded internal handlers;
- expiring human approvals with explicit reviewer reasons, a transactional PostgreSQL action outbox, worker lease recovery, bounded retry, and full authorization revalidation before approved work is queued;
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
pnpm verify:postgres
pnpm security:audit
pnpm dev
pnpm dev:worker
```

CI runs `pnpm verify:postgres` against a disposable PostgreSQL 17 schema. Operators can run the same migration acceptance check by setting `AIHUB_INTEGRATION_DATABASE_URL` to an explicitly disposable database; the verifier creates and removes only its generated `aihub_verify_*` schema.

The web application defaults to `http://localhost:5173` and the API to `http://localhost:4000`.

## Configuration model

Service endpoints and credentials are entered through AIHub's PostgreSQL-backed encrypted credential store; no HashiCorp Vault or Vault KV service is used. Installation trust requires a protected PostgreSQL connection string, separately mounted credential-encryption key, and short-lived single-use installation claim rather than routine connector environment variables.

For a release-bundle deployment on a clean Debian or Ubuntu server, run `sudo ./scripts/install-aihub.sh`. For local development, build first, then run `node scripts/generate-bootstrap.mjs` and `docker compose up -d --no-build`. See [`deploy/BOOTSTRAP.md`](deploy/BOOTSTRAP.md) for recovery and production handling requirements.

The installer's pinned runtime manifest applies committed Prisma and `pg-boss` migrations before starting the API and worker. The claim is consumed under a PostgreSQL advisory lock and cannot be replayed. The browser receives only an `HttpOnly`, `SameSite=Strict` session cookie. Routine administration transitions to scoped OIDC administrator groups; local root authority can explicitly issue an audited replacement claim for break-glass recovery. Stored service secrets remain write-only and their plaintext values are never returned by the API.

Authorized administrators can run `POST /api/v1/admin/connections/:id/test` from the dashboard. AIHub resolves the encrypted credential only inside the API process, blocks redirects during HTTP checks, and returns a sanitized `HEALTHY`, `DEGRADED`, or `UNREACHABLE` result to the browser.

Controlled chat requires exactly one enabled, successfully tested LiteLLM connection with a primary model alias. Enterprise access also requires exactly one healthy OIDC connection and at least one allowed user or administrator group. OIDC role-group precedence maps platform, security, operations, and auditor groups into separate scoped administrator sessions. AIHub streams the configured OpenAI-compatible chat route without returning infrastructure or identity-provider credentials to the browser. Conversations, final responses, cancellation/failure state, token usage, latency, feedback, sessions, and audit metadata are persisted in PostgreSQL.

The Models workspace can stage versioned chat, agent, OCR, and embedding routes against dashboard-managed serving connections. Drafts do not interrupt the legacy connection alias. After the first evaluated route is activated for a workload, AIHub fails closed instead of falling back to free-form aliases; chat requires one active default, and agent-profile activation requires a matching active agent route. AIHub records and enforces the route but does not reconfigure LiteLLM, vLLM, OCR, or Supermemory upstream.

The Guardrails workspace stages versioned chat policies containing a local input ceiling and ordered names that already exist in LiteLLM. Activation requires exact promoted `POLICY` evidence including the safety category and a healthy effective LiteLLM route. After first activation, suspension fails closed. AIHub attaches the names to every chat request and records sanitized outcomes, while classifier configuration, hook modes, and credentials remain upstream.

The Prompts workspace stages the exact system instruction used by direct AIHub chat. Activation requires promoted `PROMPT` evidence for the exact `prompt:<slug>` and version, including both chat and safety categories. Content changes require a new version. Once prompt governance is first activated, missing or suspended prompt state fails closed. Runtime audits record the prompt identifier, version, and SHA-256 checksum without duplicating its content; prompt text cannot grant access to tools, memory, connectors, or infrastructure.

Document processing requires exactly one enabled and healthy OCR connection. Uploaded content remains quarantined until an administrator approves it. AIHub encrypts the upload in a shared API/worker scratch volume, converts supported PDFs, Office Open XML files, and images into transient page images, invokes the configured OCR endpoint, and publishes one normalized representation to Supermemory. The whole document scratch prefix is purged as soon as Supermemory confirms publication and otherwise expires after 24 hours. The scratch volume is not a repository, is excluded from backup, and is not exposed for browsing or download.

Enterprise repositories remain authoritative for original files. PostgreSQL stores document identity, checksum, classification, ownership, lifecycle, retention, publication, provenance, and audit metadata—never the source bytes or normalized document body. Supermemory owns the durable normalized knowledge and semantic graph. A failed publication can be retried only while transient staging remains available; after purge or expiry, AIHub requires a fresh upload or connector fetch from the enterprise source.

Knowledge retrieval requires exactly one enabled and healthy Supermemory connection. AIHub publishes each approved, ready document through a generation-safe `pg-boss` job using a stable custom ID and an ownership-derived private container tag. Supermemory remains the only semantic index; PostgreSQL stores lifecycle, authorization provenance, source evidence, and synchronization state, not embeddings. Retrieval results are re-authorized against the current local document owner, status, and publication before they can enter a model request. Department, project, organization, and agent-shared scopes remain a later Phase 4 gate pending MPM identity and ownership rules.

Hermes execution requires exactly one enabled and healthy Hermes connection, a strong API-server key, an active safe-mode Profile, and the global runtime switch. AIHub validates the documented run-submission, run-status, run-events SSE, and run-stop capabilities before enabling execution, and the worker repeats the relevant preflight before each run. Standard Hermes remains zero-tool; governed MCP mode additionally requires the hardened AIHub private-context and redaction capability contract. Hermes must run in an isolated container with no PostgreSQL, enterprise-storage administration, deployment-control-plane, Docker, host-filesystem, or unrestricted network access. Its provider bootstrap must separately route its approved model alias to MPM LiteLLM/vLLM because the current upstream API does not expose remote administrator configuration.

AIHub Profile Distribution versions govern the desired `SOUL.md`, checksummed Skill references, model alias, limits, and policy as one SHA-256-addressed release. Standby and activation require the exact distribution digest as onboarding evidence when the Phase 9 catalog is initialized. AIHub does not claim that saving a Profile installs it into an upstream Hermes node: automated node enrollment and reconciliation remain target-deployment work until the selected Hermes build provides a documented mutation contract or MPM approves a hardened deployment adapter.

The Phase 6 MCP endpoint is `POST /api/v1/mcp/`; its administration APIs are under `/api/v1/admin/tooling`. AIHub uses two independent bearer factors: a revocable server credential stored in the dashboard-managed Hermes connection and a short-lived capability bound to an exact AIHub agent run. The latter is reproducible across worker retries but stored only as a digest. AIHub passes both in non-model-visible private run context, scopes discovery and calls by a transport header, and clears the run digest on completion. Governed mode remains fail-closed until the deployed hardened Hermes version advertises redaction and prompt-isolation guarantees and passes protocol, leakage, revocation, and recovery acceptance; standard Hermes remains zero-tool.

Phase 7 operations APIs are under `/api/v1/admin/operations`. PostgreSQL remains the incident, evidence, scheduling-control, lease, and audit system of record. Administrators can enable bounded scheduled credential-aware connection checks from the dashboard; the feature is disabled by default, and results are labelled live only while they remain within the configured freshness window. Completed evaluation evidence is immutable, promotion requires a separate scope and retained rationale, and Hermes agent activation requires a promoted `agent:<profile-slug>` candidate for the exact current version. GPU metrics, notifications, SIEM delivery, representative MPM regression data, and deployed-endpoint monitoring acceptance remain target-environment work.

Phase 8 readiness APIs are under `/api/v1/admin/operations/readiness`. AIHub records target-environment control evidence and externally issued authority decisions without claiming to grant those approvals. Updating any control invalidates earlier approval snapshots. `/healthz` reports process liveness; `/readyz` additionally requires an unlocked runtime and a live PostgreSQL query. Formal pilot approval remains impossible to demonstrate locally without MPM approvers and the deployed recovery, security, network, and load evidence.

Non-secret connection settings are validated against a per-service allowlist before storage and are included in immutable configuration revisions. Unknown keys and settings belonging to a different service type are rejected. Rollback creates a new revision and preserves current credentials rather than reactivating historical secrets. TLS certificate verification remains strict; private CA lifecycle support is an explicit target-environment gate rather than an unsafe bypass switch.

See [`docs/AIHUB_PRD.md`](docs/AIHUB_PRD.md), [`docs/AIHUB_PHASED_PLAN.md`](docs/AIHUB_PHASED_PLAN.md), the [`Phase 9 cohesion, optimization, and onboarding plan`](docs/PHASE_9_COHESION_ARCHITECTURE_ONBOARDING_PLAN.md), the [`model control runbook`](docs/MODEL_CONTROL_RUNBOOK.md), the [`guardrail control runbook`](docs/GUARDRAIL_CONTROL_RUNBOOK.md), the [`prompt control runbook`](docs/PROMPT_CONTROL_RUNBOOK.md), the [`Phase 1 operations runbook`](docs/PHASE_1_RUNBOOK.md), the [`Phase 2 chat runbook`](docs/PHASE_2_CHAT_RUNBOOK.md), the [`Phase 3 document runbook`](docs/PHASE_3_DOCUMENT_RUNBOOK.md), the [`Phase 4 memory runbook`](docs/PHASE_4_MEMORY_RUNBOOK.md), the [`Phase 5 Hermes runbook`](docs/PHASE_5_HERMES_RUNBOOK.md), the [`Phase 6 MCP and approvals runbook`](docs/PHASE_6_MCP_APPROVALS_RUNBOOK.md), the [`Phase 7 AI operations runbook`](docs/PHASE_7_AI_OPERATIONS_RUNBOOK.md), and the [`Phase 8 production-pilot runbook`](docs/PHASE_8_PRODUCTION_PILOT_RUNBOOK.md).
