# AIHub Delivery and Acceptance Plan

This plan replaces the earlier component-heavy phase history. The target architecture is AIHub/PostgreSQL, isolated Hermes/Supermemory, and vLLM.

## Phase A — Simplified foundation

Status: implemented and source-verified; all migrations pass against a fresh PostgreSQL 17 database.

- Node.js/TypeScript monorepo with React/Vite, Fastify, Prisma, and PostgreSQL domain-state reconciliation.
- Docker Compose release topology for web, API, worker, migrations, and PostgreSQL.
- encrypted configuration, permanent Installation Key activation, recovery-kit controls, bounded administrator sessions, optional OIDC, audits, and responsive dashboard.
- no Redis/Valkey, object-store dependency, or duplicate vector plane.

Exit: `pnpm verify`, clean-database migrations, repeatable Installation Key activation, key rotation, and backup ownership are demonstrated.

## Phase B — Direct inference and governed Chat

Status: implemented; real endpoint acceptance remains environment-dependent.

- vLLM is the only Chat/Agent serving connection.
- versioned model catalogue, prompts, deterministic guardrails, streaming/cancellation, usage telemetry, feedback, and PostgreSQL limits.
- authenticated internal inference gateway for Hermes and Supermemory.
- caller model selection is replaced with the approved active Agent alias; vLLM secrets never leave AIHub.

Exit: representative Qwen/Laguna route passes chat template, reasoning/tool-call, streaming, cancellation, context, concurrency, and error-mapping tests on the RTX 6000 PRO 96 GB server.

## Phase C — Ephemeral documents and durable knowledge

Status: implemented for UTF-8 TXT ingestion and Supermemory publication.

- encrypted transient scratch, quarantine, classification, checksums, retention, purge, and audited deletion.
- direct TXT normalization.
- explicit rejection of rich files and images until a future extraction requirement is reviewed.
- durable normalized publication to `mpm-knowledge` in Supermemory.
- PostgreSQL reauthorization of every retrieved enterprise result.

Exit: real files demonstrate success, malformed-input failure, retry/expiry, publication, owner isolation, deletion, and zero source bytes after purge.

## Phase D — Isolated Hermes and durable agent memory

Status: implemented and source-verified; clean-VM acceptance remains.

- one-time enrollment bundle, node-generated Ed25519 identity, signed replay-protected heartbeats, lifecycle actions, and dashboard status.
- official Hermes container using AIHub's inference gateway.
- checksum-verified Supermemory Local installation with local embeddings.
- native Hermes Supermemory provider using `mpm-agent-{identity}`.
- automatic endpoint registration in AIHub without standing SSH trust.
- immutable Profile Distribution and governed agent-run lifecycle.

Exit: a clean isolated VM enrolls end to end; agent memory survives restarts; profile namespaces cannot cross; revocation disables Hermes and its managed Supermemory route; backups restore Hermes and Supermemory consistently.

## Phase E — Optional governed tools

Status: implemented behind fail-closed controls; production disabled until accepted.

- MCP protocol boundary, short-lived run capability, registered tools, profile grants, risk classification, approval records, cancellation, and revocation.
- zero-tool is the default posture.
- the VM installer explicitly writes Hermes `platform_toolsets.api_server: [no_mcp]`; AIHub verifies the resolved `/v1/toolsets` surface before each run.
- prompts, Skills, or Hermes memory cannot grant a tool or broaden a profile grant.

Exit: protocol, authorization, argument validation, approval, replay, timeout, cancellation, output redaction, and post-approval revocation tests pass with the exact hardened Hermes build.

## Phase F — Operations and production onboarding

Status: dashboard controls implemented; customer evidence remains.

- quick-start path for PostgreSQL + vLLM and a single Hermes/Supermemory enrollment.
- advanced target-environment gate, connection checks, compatibility evidence, model/prompt/policy evaluations, incidents, scheduled monitoring, recovery controls, and activation record.
- dashboard-generated evidence remains distinct from customer attestations.

Production exit requires:

- exact AIHub, PostgreSQL, Node.js, Hermes image, Supermemory binary/SDK, vLLM, model, driver, and CUDA pins;
- customer-approved TLS or mTLS and firewall matrix;
- enterprise OIDC group mappings and retained login/logout/revocation tests;
- PostgreSQL point-in-time recovery and consistent Hermes/Supermemory restore drills;
- GPU context/concurrency/thermal/cancellation/soak evidence;
- representative MPM model, memory, document, guardrail, and adversarial evaluations;
- monitoring, alert routing, SIEM retention, runbooks, training, and named owners;
- formal Pilot and Production approval.

## Architecture invariants

These are not optional phase choices:

1. AIHub is the enterprise authorization and policy boundary.
2. vLLM serves models; it does not own routing policy or credentials exposed to runtimes.
3. Hermes executes agents only in its constrained environment.
4. Supermemory is the sole semantic graph/vector plane.
5. PostgreSQL owns AIHub control/audit/job state, not embeddings.
6. Original enterprise files remain in enterprise systems; AIHub staging is ephemeral.
7. No LiteLLM, Redis, Valkey, S3, SeaweedFS, MinIO, or AIHub pgvector dependency is introduced without a new reviewed requirement.
8. Environment-dependent controls are reported as unproven until evidence exists.
