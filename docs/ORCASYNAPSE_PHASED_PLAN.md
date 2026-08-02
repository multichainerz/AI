# OrcaSynapse Delivery and Acceptance Plan

This plan replaces the earlier component-heavy phase history. The target architecture is OrcaSynapse/PostgreSQL, isolated Hermes/Supermemory, and one approved OpenAI-compatible inference server.

## Phase A — Simplified foundation

Status: implemented and source-verified; all migrations pass against a fresh PostgreSQL 17 database.

- Node.js/TypeScript monorepo with React/Vite, Fastify, Prisma, and PostgreSQL domain-state reconciliation.
- Docker Compose release topology for web, API, worker, migrations, and PostgreSQL.
- encrypted configuration, PostgreSQL-backed local administrator login, forced first-password replacement, offline Installation Key recovery, recovery-kit controls, bounded sessions, optional OIDC, audits, and responsive dashboard.
- no Redis/Valkey, object-store dependency, or duplicate vector plane.

Exit: `pnpm verify`, clean-database migrations, repeatable local-account provisioning, Installation Key recovery/rotation, and backup ownership are demonstrated.

## Phase B — Direct inference and governed Chat

Status: implemented; real endpoint acceptance remains environment-dependent.

- one provider-neutral Inference Server connection serves Chat and Agent workloads.
- versioned model catalogue, prompts, deterministic guardrails, streaming/cancellation, usage telemetry, feedback, and PostgreSQL limits.
- authenticated internal inference gateway for Hermes and Supermemory.
- caller model selection is replaced with the approved active Agent alias; upstream inference secrets never leave OrcaSynapse.

Exit: representative Qwen/Laguna route passes chat template, reasoning/tool-call, streaming, cancellation, context, concurrency, and error-mapping tests on the RTX 6000 PRO 96 GB server.

## Phase C — Ephemeral documents and durable knowledge

Status: implemented for UTF-8 TXT ingestion and Supermemory publication.

- encrypted transient scratch, quarantine, classification, checksums, retention, purge, and audited deletion.
- direct TXT normalization.
- explicit rejection of rich files and images until a future extraction requirement is reviewed.
- durable normalized publication to `orcasynapse-knowledge` in Supermemory.
- PostgreSQL reauthorization of every retrieved enterprise result.

Exit: real files demonstrate success, malformed-input failure, retry/expiry, publication, owner isolation, deletion, and zero source bytes after purge.

## Phase D — Isolated Hermes and durable agent memory

Status: implemented and source-verified; clean-VM acceptance remains.

- one-time enrollment claim resolved through the customer-owned OrcaSynapse origin, with JSON-bundle fallback, node-generated Ed25519 identity, signed replay-protected heartbeats, lifecycle actions, and dashboard status.
- official Hermes container using OrcaSynapse's inference gateway.
- checksum-verified Supermemory Local installation with local embeddings.
- native Hermes Supermemory provider using `orcasynapse-agent-{identity}`.
- automatic endpoint registration in OrcaSynapse without standing SSH trust.
- immutable Profile Distribution and governed agent-run lifecycle.

Exit: a clean isolated VM enrolls end to end; agent memory survives restarts; profile namespaces cannot cross; revocation disables Hermes and its managed Supermemory route; backups restore Hermes and Supermemory consistently.

## Phase E — Optional governed tools

Status: implemented behind fail-closed controls; production disabled until accepted.

- MCP protocol boundary, short-lived run capability, registered tools, profile grants, risk classification, approval records, cancellation, and revocation.
- zero-tool is the default posture.
- the VM installer explicitly writes Hermes `platform_toolsets.api_server: [no_mcp]`; OrcaSynapse verifies the resolved `/v1/toolsets` surface before each run.
- prompts, Skills, or Hermes memory cannot grant a tool or broaden a profile grant.

Exit: protocol, authorization, argument validation, approval, replay, timeout, cancellation, output redaction, and post-approval revocation tests pass with the exact hardened Hermes build.

## Phase F — Operations and production onboarding

Status: dashboard controls implemented; customer evidence remains.

- public GitHub VM1 bootstrap plus one OrcaSynapse-hosted VM2 script that installs and enrolls Hermes and Supermemory.
- quick-start path for PostgreSQL + an inference server and a single Hermes/Supermemory enrollment.
- advanced target-environment gate, connection checks, compatibility evidence, model/prompt/policy evaluations, incidents, scheduled monitoring, recovery controls, and activation record.
- dashboard-generated evidence remains distinct from customer attestations.

Production exit requires:

- exact OrcaSynapse, PostgreSQL, Node.js, Hermes image, Supermemory binary/SDK, inference backend, model, driver, and CUDA pins;
- customer-approved TLS or mTLS and firewall matrix;
- enterprise OIDC group mappings and retained login/logout/revocation tests;
- PostgreSQL point-in-time recovery and consistent Hermes/Supermemory restore drills;
- GPU context/concurrency/thermal/cancellation/soak evidence;
- representative OrcaSynapse model, memory, document, guardrail, and adversarial evaluations;
- monitoring, alert routing, SIEM retention, runbooks, training, and named owners;
- formal Pilot and Production approval.

## Phase G — Enterprise identity and tenant isolation

Status: instance-wide OIDC/RBAC is implemented; true multi-tenancy remains future work.

- current: PostgreSQL local administrator with Installation Key recovery, OIDC discovery, PKCE, issuer/JWK validation, allowed-group checks, and mappings to platform roles;
- supported identity path: Microsoft Entra ID, AD FS, or another enterprise identity provider when it exposes an OpenID Connect issuer;
- not implemented: direct LDAP bind/domain-join authentication;
- not implemented: a Tenant/Organization/Workspace domain boundary with tenant-scoped database keys, queries, audit records, agent profiles, memory namespaces, quotas, and administrative delegation.

Exit: a tenant identifier is mandatory on every tenant-owned record and authorization decision; cross-tenant negative tests cover APIs, jobs, audits, profiles, documents, Chat, and Supermemory identity namespaces; provisioning/deprovisioning and OIDC group changes are demonstrated end to end.

## Architecture invariants

These are not optional phase choices:

1. OrcaSynapse is the enterprise authorization and policy boundary.
2. The selected inference backend serves models; it does not own routing policy or credentials exposed to runtimes.
3. Hermes executes agents only in its constrained environment.
4. Supermemory is the sole semantic graph/vector plane.
5. PostgreSQL owns OrcaSynapse control/audit/job state, not embeddings.
6. Original enterprise files remain in enterprise systems; OrcaSynapse staging is ephemeral.
7. No LiteLLM, Redis, Valkey, S3, SeaweedFS, MinIO, or OrcaSynapse pgvector dependency is introduced without a new reviewed requirement.
8. Environment-dependent controls are reported as unproven until evidence exists.
