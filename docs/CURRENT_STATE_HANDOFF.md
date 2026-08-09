# OrcaSynapse Current-State Handoff

Last verified: 2026-08-07 (Asia/Jakarta)

This document is the sanitized transfer context for continuing OrcaSynapse work in another session. Read it before changing code. It records the repository state, decisions already made, verified behavior, and the pending work. It intentionally contains no passwords, installation keys, API keys, enrollment claims, or private-key material.

## Start here

- Repository: <https://github.com/multichainerz/AI>
- Local workspace: `C:\Users\Veros\Documents\GitHub\MPM`
- Branch: `main`.
- Baseline release: **v2.8.0** (this file ships in that release commit; `git log -1` gives the hash). Releases are tagged starting at `v0.4.0`.
- Baseline verification: `pnpm verify` passes — 1,039 tests, typecheck, production build, and `drizzle-kit check` all green. `pnpm verify:postgres` passes against a pgvector server; `pnpm security:audit` reports no known vulnerabilities; and the four static guards (`sync-installer-ui.sh --check`, `test-release-consistency.sh`, `test-docker-build-closure.sh`, `test-csp-closure.sh`) pass.
- Both installers are covered end to end by lifecycle tests that execute `main()`: `scripts/test-orcasynapse-installer-smoke.sh` (VM1) and `scripts/test-agentic-installer-smoke.sh` (VM2, including decommission). Both need root and a systemd host — a WSL Ubuntu 24.04 instance with `[boot] systemd=true` is enough.

**Check what is actually on the remote before assuming a deployment tests your
work.** `install.sh` defaults to `ORCASYNAPSE_REF=main` and builds the images
from a GitHub tarball of that ref, so an unpushed release is invisible to every
install. `git log --oneline origin/main..main` should be empty; nineteen
releases once accumulated locally while the pilot could only ever have fetched
`v1.1.0`.

Do not copy credentials from terminals, VM environment files, Docker secrets, PostgreSQL, or service logs into issues, commits, or future handoff documents.

## Product definition

OrcaSynapse is an on-premises identity, policy, orchestration, inference-gateway, and observability plane for an isolated Hermes agent runtime. It is not another agent framework, model server, source-file repository, OCR product, or external vector database service.

The operator journey:

1. Install VM1 with the public one-line installer.
2. Sign in with the generated temporary local administrator and change the password.
3. Connect and validate one OpenAI-compatible AI Inference endpoint.
4. Generate the VM2 installer and one-time enrollment claim.
5. Install the Agentic System on VM2; the installer provisions Hermes, managed policy, node identity, and signed monitoring.
6. Create and activate the first Hermes Profile.
7. Use Chat, Knowledge, Agents, Platform, and Operations from one dashboard.
8. Add OIDC or Microsoft Entra ID later for enterprise access and RBAC.

## Architectural invariants

1. OrcaSynapse owns enterprise identity, authorization, policy, encrypted configuration, orchestration, audit, and inference mediation.
2. Hermes is the only normal Chat and agent-execution path. Chat must never call the model directly.
3. VM2 runs the agent runtime and holds no durable store. Knowledge lives in OrcaSynapse's local pgvector index and never transits VM2. Cross-conversation agent memory ships as a governed pgvector-backed store, scoped to one person and one agent, with an installation-wide policy cap. See the agent-memory entry under What is implemented.
4. PostgreSQL stores control-plane state, metadata, sessions, audit, durable run state, extracted knowledge chunks, and their embeddings — never original enterprise files or model weights.
5. Source files are never persisted in OrcaSynapse: extraction happens in flight, and a failed ingestion requires re-upload.
6. AI Inference serves models but does not own policy or durable memory.
7. Hermes receives a node-scoped OrcaSynapse inference credential; the inference server credential stays on VM1.
8. Hermes runs alone on isolated VM2; small native Hermes files such as `MEMORY.md` and `USER.md` remain additive runtime state.
9. No Redis, Valkey, pg-boss, LiteLLM, object store, external vector database service, or OCR stack. pgvector is required and ships inside the bundled `pgvector/pgvector:pg17` PostgreSQL image.
10. Tenancy is per deployment: one installation serves one organization; `ownerSubject` scopes user data inside it. Do not reintroduce multi-tenancy as pending work.

## Runtime topology

```mermaid
flowchart LR
  Browser["Browser"] --> VM1["VM1: OrcaSynapse"]
  VM1 <--> PostgreSQL["PostgreSQL 17 + pgvector<br/>(control state, knowledge chunks,<br/>embeddings, audit trail)"]
  VM1 --> Inference["OpenAI-compatible AI Inference"]
  VM1 <-->|"governed runs, policy, telemetry"| Hermes["VM2: Hermes"]
  VM1 -.->|"optional audit forwarding"| SIEM["Customer SIEM"]
```

## Technology and repository map

- Node.js 24+, pnpm 10, TypeScript 7 (strict: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`)
- React 19 and Vite 8 for the dashboard; Fastify 5 API; Vitest 4
- PostgreSQL 17 with pgvector, Drizzle ORM 0.45 (migrations under `packages/database/drizzle/migrations`, currently 0000–0025, applied by the runtime migrator)
- Docker Compose for VM1; Hermes installed natively under systemd on VM2 (`orcasynapse-hermes.service`), pinned to an approved git commit

| Path | Responsibility |
| --- | --- |
| `apps/web` | Dashboard and operator workflows |
| `apps/api` | Authentication, connections, inference gateway, Chat, Agents, Knowledge, Operations, onboarding, audit, and runtime-node APIs |
| `apps/worker` | Durable Hermes Agent Run reconciliation and lifecycle processing |
| `packages/contracts` | Shared validated API contracts and `ORCASYNAPSE_VERSION` |
| `packages/database` | Drizzle schema (`src/drizzle/schema.ts` is the source of truth), migrations, testing harness |
| `packages/knowledge` | Local document pipeline: extraction (unpdf/officeparser), chunking, BGE-M3 embedding, pgvector retrieval |
| `packages/runtime-clients` | Hermes server-side client and connection resolver |
| `packages/security` | Password hashing, envelope encryption, capability checks, recovery-kit primitives |
| `install.sh` | Public VM1 bootstrap (self-contained; embeds the UI library) |
| `scripts/install-orcasynapse.sh` | VM1 installer (sources `scripts/lib/installer-ui.sh`; seven steps incl. preflight and embedding-model seed) |
| `scripts/install-agentic-node.sh` | VM2 enrollment installer (self-contained; served by the VM1 API) |
| `scripts/remove-agentic-node.sh` | VM2 destructive uninstall (self-contained; served by the VM1 API) |
| `scripts/lib/installer-ui.sh` | Canonical installer terminal UI; `scripts/sync-installer-ui.sh` syncs the embedded copies |
| `scripts/lib/public-scheme.sh` | The `--public-scheme` declaration: parsed from the command line (sudo strips the environment), recorded in `.local/state/public-scheme`, read back by install and rotation |
| `scripts/test-*.sh` | CI-run conformance and recovery tests |
| `compose.yaml` | VM1 postgres (pgvector image), migrate, api, worker, web services |

## Release convention

One commit per release on `main`: subject `vX.Y.Z`, body = summary sentence plus lowercase verb-first bullets. The version is bumped in the same commit across **12 surfaces** (root + 8 workspace `package.json`, `packages/contracts/src/version.ts`, `INSTALLER_VERSION` in `scripts/install-agentic-node.sh` and `scripts/remove-agentic-node.sh`) — `scripts/test-release-consistency.sh` enforces the set. Add the CHANGELOG.md entry in the same commit, then tag `vX.Y.Z` and push the tag. License: BUSL-1.1.

## What is implemented

- **VM1 installation**: public tarball bootstrap with upgrade/erase recovery; seven-step branded installer with preflight, persistent secret-free log, versioned banner/summary, completion marker, and a one-time reindex guard for pre-pgvector data volumes.
- **AI Inference**: guided discovery/validation for vLLM, llama.cpp, SGLang, Ollama, TGI and compatible servers; node-scoped gateway at `/internal/v1` with request limits counted in `InferenceGatewayRequest`.
- **Agentic System**: one-time claims, Ed25519 identity, signed replay-protected enrollment and heartbeats, commit-pinned native Hermes under systemd, resumable recovery journal, drain/suspend/revoke/remove lifecycle. VM2 runs a single plane, so a node is ONLINE exactly when its Hermes API port answers. The installer refuses to adopt a Hermes it did not install, and passes `--force-commit` so the control plane's approved revision always wins over whatever the host already had.
- **Chat**: governed Hermes Agent Runs with durable leases, resumable streams, cancellation, telemetry, feedback, fork/archive/export, and **conversation-scoped knowledge pinning** (`ChatConversationDocument`, `AgentRun.knowledgeDocumentIds`).
- **Knowledge**: local pipeline — supported formats bound to `SUPPORTED_DOCUMENT_TYPES` (txt, md, html, csv, json, pdf, docx, pptx, xlsx; images 415-rejected), in-flight extraction, 1024-dim BGE-M3 embeddings, HNSW cosine retrieval, owner-scoped predicate, originals never stored.
- **Audit**: append-only trail readable at `GET /api/v1/admin/audit/events` (`audit:read`, keyset paging) with a dashboard view under Operations; SIEM forwarding with at-least-once delivery and health (`NOT_CONFIGURED`/`HEALTHY`/`BEHIND`/`FAILING`) observed by AI Ops incidents. See `docs/AUDIT_TRAIL_RUNBOOK.md`.
- **Onboarding**: completable from the dashboard — architecture decision, component attestation, step updates, activation control with named blockers.
- **Operations**: topology, incidents, workflow metrics, release evidence, timer-driven stale-executor reaping, audit-forwarding component.
- **Agent memory**: pgvector recall scoped to (owner, profile), version chains with model-judged supersession, an always-injected profile of static and dynamic facts, session-end distillation, forget batches with `dryRun`, and a quality metric. See `docs/AGENT_MEMORY_RUNBOOK.md`.
- **Benchmarks**: deterministic suites executed against the live stack — `CHAT_QUALITY` through a real agent run, `RETRIEVAL` through the document vector plane, `MEMORY` through recall. Nothing is judged by a model. A completed run files itself into the evaluation ledger as the evidence a promotion is gated on. See `docs/BENCHMARK_RUNBOOK.md`.
- **Runtime desired state**: VM2 consumes the signed document
  (`GET /api/v1/runtime-nodes/:nodeId/desired-state`, v0.8.0/1.42.0),
  verifies the signature against its pinned control-plane key, and applies the
  admitted toolset allowlist. Since v1.4.0 the installer reconciles once
  before it finishes, so a node is governed on arrival rather than after the
  first five-minute tick, and reports what was admitted in its completion panel.
- **Design system**: Tailwind 3 with `cva`, no Radix — the container's `style-src 'self'` forbids the inline styles and injected `<style>` elements its overlays need. Primitives live in `apps/web/src/ui/`; Inter and JetBrains Mono are self-hosted under `apps/web/public/fonts/`.
- **Enterprise access**: local administrator + Installation-Key break-glass recovery (rotatable via `scripts/rotate-installation-key.sh`), optional OIDC/Microsoft Entra ID.

Client-side only (do not describe as API capabilities): conversation search, export, and retry — `GET /conversations` accepts no query parameter.

## Removed dependency: the VM2 memory service

Removed in v0.5.0. The external memory service that previously ran on VM2 silently substituted a narrower embedding model than it was configured with (upstream issue #1336), which was one reason to stop depending on it. OrcaSynapse's own embeddings run locally on VM1 through `LocalBgeM3Embedder`, which asserts the vector width per batch and is backed by a `vector(1024)` column that rejects anything else.

## Pending work

**Phase 4 — the Hermes experience.** The original plan was written before the
runtime was reachable. Driving the live Hermes replaced most of its assumptions:

| Item | State |
| --- | --- |
| 4a slash-command passthrough | **Not buildable.** Hermes has no command channel, and the heartbeat is push-only — its response is discarded. |
| 4b multi-turn | **Reframed.** `maxTurns = 1` is declared at five points but never transmitted: the run submission carries no turn field and Hermes exposes no turn control. Conversational multi-turn already works via `conversationHistory`. What actually keeps a run single-step is that no toolset is admitted. |
| 4c governed tool calling | **Split.** Hermes-native approvals work end to end (`AgentRunApproval`). The OrcaSynapse MCP path is inert — see below. Toolset admission shipped in v0.8.0–1.42.0. |

**The governed MCP plane is inert, and the blocker is owner scoping.**
`assertGovernedToolBoundaryFor` requires `private_run_context:
"orcasynapse_mcp_headers_v1"`, a contract that exists only in this repository;
no shipped Hermes advertises it. Declaring the server in VM2's managed config
would remove the prompt-leak risk that requirement guarded, but it does not make
the path usable: Hermes invokes a tool as `session.call_tool(name, arguments)`
with no session, run, or user forwarded, over a connection shared by every run
and every person. OrcaSynapse therefore cannot scope a call to its requester,
and owner scope is a SQL predicate that needs exactly that. Tools exposed this
way could only be ones safe for *any* user of a given profile. Settle which
tools those are — or obtain per-run credentials from Hermes — before building.

**Other open items:** a node enrolled before v0.8.0 has no pinned
control-plane key and must be re-enrolled to receive one — without it the node
applies no desired state rather than trusting an unsigned document. Agent memory is retrieval over stored turns rather
than a memory layer — Hermes ships a `MemoryProvider` ABC (`on_session_end`
fact extraction, `prefetch`, tool-shaped recall) that is the principled fix.
Interaction-test coverage exists only for chat; other views are render-level.

## Deployment estate

The pilot runs on a bare-metal LXD host reached over its HTTPS API with a client
certificate. Instances are on a private `10.0.0.0/20` network:

| Instance | Role |
| --- | --- |
| `mpm-vm1` | control plane — API, dashboard, worker, PostgreSQL/pgvector |
| `mpm-vm2` | Hermes runtime, no durable store |
| `mpm-llm` | llama.cpp serving the chat model |

The inference connection points at `mpm-llm` over the private network, so the
estate has no dependency on any developer workstation. Addresses are dynamic;
list them through the LXD API rather than assuming.

A development workstation may also run PostgreSQL for the test suite. On WSL the
localhost port relay goes stale when idle — restart the cluster immediately
before a database-backed suite if connections are refused.

**How a deployment gets its code.** `install.sh` reads
`ORCASYNAPSE_GITHUB_REPOSITORY` (default `multichainerz/AI`) and
`ORCASYNAPSE_REF` (default `main`), resolves the ref to a commit through the
GitHub API, downloads that commit's tarball, and `compose.yaml` builds every
image from it. There is no registry and no published artifact, so what is on
`main` *is* what deploys. Migrations need no manual step: compose runs a
dedicated `migrate` service, and both `api` and `worker` wait on
`service_completed_successfully`.

## Useful verification commands

```powershell
git status -sb
pnpm verify                    # ORCASYNAPSE_TEST_DATABASE_URL must point at a pgvector server
pnpm verify:postgres           # ORCASYNAPSE_INTEGRATION_DATABASE_URL, full-migration proof
pnpm security:audit           # blocking in CI: a high in a production dependency
bash scripts/sync-installer-ui.sh --check
bash scripts/test-release-consistency.sh
bash scripts/test-docker-build-closure.sh
bash scripts/test-csp-closure.sh   # reads apps/web/dist; builds it if absent
git log --oneline origin/main..main   # must be empty before a deployment test
```

On Windows the three installer shell tests (`test-public-installer-recovery.sh`,
`test-agentic-installer-recovery.sh`, `test-installer-secret-permissions.sh`) do
not run: Git Bash hands a POSIX temp path to Windows `curl.exe`, which cannot
open it, and the secret test needs Linux `sudo`. CI runs all three on
`ubuntu-latest`. `bash -n install.sh scripts/*.sh scripts/lib/*.sh` does work
locally and catches syntax breakage.

Local test database convention: `docker run -d --name orca-base -p 15432:5432 -e POSTGRES_USER=orca -e POSTGRES_PASSWORD=orca -e POSTGRES_DB=postgres pgvector/pgvector:pg17`, then `ORCASYNAPSE_TEST_DATABASE_URL=postgresql://orca:orca@127.0.0.1:15432/postgres`.

Avoid dumping complete environment files or unredacted logs because they may contain credentials.

## Production gates still outside code-only acceptance

- Customer-approved TLS/mTLS and firewall evidence.
- Signed, immutable image and binary policy.
- PostgreSQL and Hermes backup/restore drills against defined RPO/RTO.
- GPU concurrency, cancellation, and soak testing with the chosen model.
- OIDC/Microsoft Entra ID group mapping and deprovisioning acceptance.
- Owner-scope isolation testing between users inside the organization.
- Infrastructure, security, product, and business approval.
