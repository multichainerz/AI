# OrcaSynapse Current-State Handoff

Last verified: 2026-08-05 (Asia/Jakarta)

This document is the sanitized transfer context for continuing OrcaSynapse work in another session. Read it before changing code. It records the repository state, decisions already made, verified behavior, and the pending work. It intentionally contains no passwords, installation keys, API keys, enrollment claims, or private-key material.

## Start here

- Repository: <https://github.com/multichainerz/AI>
- Local workspace: `C:\Users\Veros\Documents\GitHub\MPM`
- Branch: `main`, synchronized with `origin/main`.
- Baseline release: **ai-v1.29.0** (this file ships in that release commit; `git log -1` gives the hash). Releases are tagged starting at `ai-v1.25.0`.
- Baseline verification: `pnpm verify` passes — 80 test files, 618 tests, typecheck, production build, and `drizzle-kit check` all green. `pnpm verify:postgres` passes against a pgvector server.

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
3. VM2 runs the agent runtime and holds no durable store. Knowledge lives in OrcaSynapse's local pgvector index and never transits VM2. Cross-conversation agent memory is not part of this release; a governed pgvector-backed replacement is the next planned change.
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
- PostgreSQL 17 with pgvector, Drizzle ORM 0.45 (migrations under `packages/database/drizzle/migrations`, currently 0000–0008, applied by the runtime migrator)
- Docker Compose for VM1; official Hermes container on VM2

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
| `scripts/install-orcasynapse.sh` | VM1 installer (sources `scripts/lib/installer-ui.sh`; six steps incl. preflight) |
| `scripts/install-agentic-node.sh` | VM2 enrollment installer (self-contained; served by the VM1 API) |
| `scripts/remove-agentic-node.sh` | VM2 destructive uninstall (self-contained; served by the VM1 API) |
| `scripts/lib/installer-ui.sh` | Canonical installer terminal UI; `scripts/sync-installer-ui.sh` syncs the embedded copies |
| `scripts/test-*.sh` | CI-run conformance and recovery tests |
| `compose.yaml` | VM1 postgres (pgvector image), migrate, api, worker, web services |

## Release convention

One commit per release on `main`: subject `ai-vX.Y.Z`, body = summary sentence plus lowercase verb-first bullets. The version is bumped in the same commit across **12 surfaces** (root + 8 workspace `package.json`, `packages/contracts/src/version.ts`, `INSTALLER_VERSION` in `scripts/install-agentic-node.sh` and `scripts/remove-agentic-node.sh`) — `scripts/test-release-consistency.sh` enforces the set. Add the CHANGELOG.md entry in the same commit, then tag `ai-vX.Y.Z` and push the tag. License: BUSL-1.1.

## What is implemented

- **VM1 installation**: public tarball bootstrap with upgrade/erase recovery; six-step branded installer with preflight, persistent secret-free log, versioned banner/summary, completion marker, and a one-time reindex guard for pre-pgvector data volumes.
- **AI Inference**: guided discovery/validation for vLLM, llama.cpp, SGLang, Ollama, TGI and compatible servers; node-scoped gateway at `/internal/v1` with request limits counted in `InferenceGatewayRequest`.
- **Agentic System**: one-time claims, Ed25519 identity, signed replay-protected enrollment and heartbeats, digest-pinned Hermes image, resumable recovery journal, drain/suspend/revoke/remove lifecycle. VM2 runs a single plane, so a node is ONLINE exactly when its Hermes API port answers.
- **Chat**: governed Hermes Agent Runs with durable leases, resumable streams, cancellation, telemetry, feedback, fork/archive/export, and **conversation-scoped knowledge pinning** (`ChatConversationDocument`, `AgentRun.knowledgeDocumentIds`).
- **Knowledge**: local pipeline — supported formats bound to `SUPPORTED_DOCUMENT_TYPES` (txt, md, html, csv, json, pdf, docx, pptx, xlsx; images 415-rejected), in-flight extraction, 1024-dim BGE-M3 embeddings, HNSW cosine retrieval, owner-scoped predicate, originals never stored.
- **Audit**: append-only trail readable at `GET /api/v1/admin/audit/events` (`audit:read`, keyset paging) with a dashboard view under Operations; SIEM forwarding with at-least-once delivery and health (`NOT_CONFIGURED`/`HEALTHY`/`BEHIND`/`FAILING`) observed by AI Ops incidents. See `docs/AUDIT_TRAIL_RUNBOOK.md`.
- **Onboarding**: completable from the dashboard — architecture decision, component attestation, step updates, activation control with named blockers.
- **Operations**: topology, incidents, workflow metrics, release evidence, timer-driven stale-executor reaping, audit-forwarding component.
- **Enterprise access**: local administrator + Installation-Key break-glass recovery (rotatable via `scripts/rotate-installation-key.sh`), optional OIDC/Microsoft Entra ID.

Client-side only (do not describe as API capabilities): conversation search, export, and retry — `GET /conversations` accepts no query parameter.

## Removed dependency: the VM2 memory service

Removed in ai-v1.29.0. The external memory service that previously ran on VM2 silently substituted a narrower embedding model than it was configured with (upstream issue #1336), which was one reason to stop depending on it. OrcaSynapse's own embeddings run locally on VM1 through `LocalBgeM3Embedder`, which asserts the vector width per batch and is backed by a `vector(1024)` column that rejects anything else.

## Pending work

**Phase 4 — the Hermes experience** (deliberately deferred for deeper review):

| Option | Size | Blocker |
| --- | --- | --- |
| 4a slash-command passthrough | ~1 week | needs Hermes API docs or a reachable VM2 — `HermesRunSubmission` has no command channel; OrcaSynapse knows only `/v1/capabilities`, `/v1/runs`, `/v1/toolsets` |
| 4b multi-turn conversations | ~1 month | `maxTurns = 1` is enforced in the DB check constraint, the baseline migration, and `z.literal(1)` — lifting it is a product/safety decision |
| 4c governed tool calling | ~1 quarter | the `ToolActionDispatch` executor was removed and must be rebuilt; `ToolApproval` remains as its substrate (0 writers / 1 reader is expected residue) |

Smaller headroom: interaction-test coverage exists only for chat (`chat-knowledge.interaction.test.tsx`); other views are render-level.

## Local lab deployment

The development host uses WSL `Ubuntu-26.04` with LXD virtual machines `synapse-dashboard` (VM1) and `synapse-agent` (VM2). LXD addresses are dynamic:

```powershell
wsl.exe -d Ubuntu-26.04 -u root -- /snap/bin/lxc list --format compact
```

After the WSL/LXD environment resumes, guest agents take time to initialize — a transient `LXD VM agent is not currently running` is not an OrcaSynapse regression. The lab's VM2 predates ai-v1.29.0 and still carries the removed memory service; re-enroll it to match the current single-plane layout.

Never include a node private key, installation key, administrator password, or enrollment claim in another session.

## Useful verification commands

```powershell
git status -sb
pnpm verify                    # ORCASYNAPSE_TEST_DATABASE_URL must point at a pgvector server
pnpm verify:postgres           # ORCASYNAPSE_INTEGRATION_DATABASE_URL, full-migration proof
bash scripts/sync-installer-ui.sh --check
bash scripts/test-release-consistency.sh
bash scripts/test-docker-build-closure.sh
```

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
