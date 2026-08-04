# Changelog

Every release is one commit on `main` whose subject is the version (`ai-vX.Y.Z`),
tagged with the same name. Entries below are newest first. Releases before
ai-v1.25.0 predate this file and are backfilled from the commit bodies; releases
before ai-v1.19.0 are summarized per series.

## ai-v1.33.0 — 2026-08-05

A coherence pass over the dashboard, before Phase 4 adds surfaces to it.

- **fix four admin views that stayed operable during a forced password change.**
  `requireAdmin` answers `403 PASSWORD_CHANGE_REQUIRED` for that session, but
  Models, Prompts, Guardrails and Memory all treated "signed in" as "usable" —
  so an administrator mid-password-change got a full workspace whose every
  request failed. One shared `adminAccess(session)` now derives *usable* and
  *what it grants* in a single place, and every admin view reads from it
- **give Memory the same screen shape as the rest of Platform.** Signed out it
  rendered one bare sentence with no page title and no way forward, while
  Models, Prompts and Guardrails each showed a titled workspace and a lock panel
  with a recovery action. All four now match
- unify the view contract: every admin view takes `session` and reports expiry
  as `onSessionExpired`, replacing two competing conventions (`session` +
  `onSessionExpired` in four views, `unlocked` + `scopes` + `onUnauthorized` in
  five). Chat, Knowledge and Agents keep their own dual-identity props but use
  the same callback name
- collapse the twelve copies of the session-expiry closure in `app.tsx` into
  two — one for admin-only views, one for the views that also hold an
  enterprise session
- merge 101 duplicate CSS rules across the Models, Prompts and Guardrails
  blocks, which were copy-pasted three times and differed only by accent colour;
  Memory now shares them (2,023 → 1,922 lines, every selector's computed
  declarations proven unchanged)
- correct the Overview copy that still placed agent memory on VM2; knowledge and
  agent memory have been VM1 pgvector tables since ai-v1.30.0
- remove `GET /api/v1/connections/catalog`, an unauthenticated echo of a
  constant the dashboard already imports from `@orcasynapse/contracts` and which
  nothing has ever called
- cover the locked state of all four governance screens, and that they present
  the same shell

## ai-v1.32.0 — 2026-08-05

Cohesion pass over the memory work: make the whole policy load-bearing, and give
the person a memory is about a way to see and delete it.

- **enforce every policy field, not just the ceiling.** `retentionDays`,
  `maximumItemsPerOwner`, `recallLimit` and `recallMinimumScore` were stored,
  documented, and editable while the worker used hardcoded values and never
  stamped `retentionUntil` — so every captured memory had no expiry regardless
  of what the policy said. The active policy now resolves once per run and
  reaches the store on both recall and capture
- stamp `retentionUntil` from the policy in force **at capture**, so lengthening
  retention later cannot retroactively extend items already stored under a
  shorter promise
- fall back to the shipped defaults (365 days, 500 items, 6 recalled, 0.4 floor)
  when no policy is active, so an installation nobody configured still bounds
  and expires what it stores
- **ship the self-service surface the ceiling work only described.** Enterprise
  principals open **Memory** from the Chat toolbar to see everything stored
  about them and forget any of it. Both the listing and the deletion take the
  owner from the authenticated session, never the request; another person's
  memory returns `404`, indistinguishable from one that does not exist
- drop the orphan `MemorySyncStatus` enum, unreferenced since
  `DocumentMemoryPublication` was removed in migration 0003 — the last trace of
  the external memory service in the schema
- add `apps/api/src/memory/routes.test.ts` covering the scope gate, the reason
  requirement on every deletion and purge, `cache-control: no-store` on
  remembered content, and the locked state
- cover the self-service routes and the policy limits reaching the store,
  including a suspended policy being ignored rather than enforced

## ai-v1.31.0 — 2026-08-05

Make what agents remember governable: one installation-wide ceiling, and a
surface where an administrator can see and delete everything stored.

- add `MemoryPolicy` with the prompt-template lifecycle — `DRAFT → ACTIVE →
  SUSPENDED`, one active policy enforced by a partial unique index,
  `expectedRevision` on every mutation, and a decision reason in the audit
  trail. Deliberately no evaluation-evidence gate: guardrails and prompts
  require evidence because they change model behavior, and this is a
  data-retention control
- `maximumCaptureMode` caps every agent at once. A profile may be narrower but
  never wider, so setting the ceiling to `RECALL_ONLY` stops all capture
  fleet-wide without editing a single profile
- **the ceiling is read at capture time, not at submission**, so suspending
  capture applies to runs already in flight
- refuse to edit an active policy: runs are being measured against it, and
  editing in place would move the boundary under work already admitted
- add a **Platform → Memory** view listing every stored item with its owner,
  agent, provenance and expiry; delete one or purge everything for one person,
  each requiring a reason
- add `memory:read` (PLATFORM_ADMIN, SECURITY_ADMIN, OPERATIONS_ADMIN, AUDITOR)
  and `memory:manage` (PLATFORM_ADMIN, SECURITY_ADMIN)
- scope self-service deletion by the same SQL predicate as retrieval, so a stray
  identifier can never reach another person's memory
- keep remembered content out of the audit trail entirely — the trail records
  that memory changed, the reason, and the count, never what it said
- add docs/AGENT_MEMORY_RUNBOOK.md
- cover the lifecycle, the ceiling narrowing a permissive profile at capture
  time, revision conflicts, scoped and administrative deletion, and purge

## ai-v1.30.0 — 2026-08-05

Give agents memory again, on OrcaSynapse's own pgvector plane, and make what
gets stored a choice an administrator makes per agent.

- add the `AgentMemory` table and `AgentMemoryStore`, mirroring `DocumentChunk`
  and `DocumentVectorStore`: hybrid cosine + lexical recall over an HNSW index,
  with the (owner, agent) scope as a predicate inside every statement rather
  than a namespace handed to a service, so nothing a caller supplies can widen it
- add `memoryMode` to a profile version, the dashboard-facing choice of what an
  agent does. `DOCUMENTS_ONLY` is the default, so an upgrade stores nothing
  about anyone until someone decides otherwise:

  | Mode | Recall | Captures |
  | --- | --- | --- |
  | `DOCUMENTS_ONLY` | documents only | nothing |
  | `RECALL_ONLY` | documents + memory | nothing |
  | `LEARN_USER` | documents + memory | what the person says |
  | `LEARN_EXCHANGE` | documents + memory | both sides of the turn |

- materialize the mode into `memory:agent:read` / `memory:agent:write` run
  capabilities, frozen onto the run exactly like `knowledge:private:read`, so
  editing a profile cannot change what an in-flight run may do
- recall before submission and inject through the existing hardened-instruction
  path as a `RECALLED MEMORY` block carrying the same untrusted-data framing as
  knowledge excerpts, and telling the model to prefer what the user says now
- **`LEARN_USER` stores the person's turn and never the model's output**, so an
  answer the model got wrong once cannot become a durable fact that later runs
  retrieve and treat as established; `LEARN_EXCHANGE` opts into that trade
- prune on write rather than on a timer: expired items are dropped and the
  oldest beyond the per-agent cap are trimmed, matching how this codebase keeps
  other append-only tables bounded
- capture failures are logged and swallowed - the run completed and the person
  has their answer, so losing a memory is not a reason to retract it
- cover every mode, the owner and agent boundaries, expiry, trimming,
  scoped deletion, and the profile-delete cascade

## ai-v1.29.0 — 2026-08-05

Remove Supermemory. VM2 now runs exactly one plane — the Hermes runtime — and
holds no durable data store of its own.

- delete ~450 lines from the VM2 installer: the checksum-verified binary
  download, the systemd unit and service account, the 600-second first-boot
  model wait, the API-key capture from journald, the disposable document check,
  the Hermes memory-provider bootstrap, and the memory registration round trip
- **stop gating agent runs on a remote memory plane** — the worker previously
  refused every run with `SUPERMEMORY_UNAVAILABLE`/`SUPERMEMORY_UNHEALTHY`, so
  a VM2 memory outage stopped all agent execution
- simplify the ONLINE rule to the single plane that now exists, in both the
  post-enroll trust proof and the heartbeat client
- remove the `/:nodeId/memory` route, `registerMemory`, the diagnostics
  adapter, the AI-Ops component, and the `supermemoryVersion` invitation
  artifact along with its release-pin contract
- drop `SUPERMEMORY` from the `ServiceKind` enum (migration 0008 recreates the
  type, since PostgreSQL cannot remove an enum value in place, and disposes of
  the obsolete rows first) and drop `HermesNodeEnrollment.supermemoryVersion`
- retire the `supermemory-local` and `hermes-native-memory` onboarding
  components through the existing withdrawal reaper, and rename the knowledge
  attestation to `knowledge-index` — it has queried `DocumentChunk` and nothing
  else since the pgvector migration
- stop gating the dashboard's Knowledge workspace on the VM2 memory service,
  which never served document knowledge after that migration

Cross-conversation agent memory is not part of this release. Within a
conversation nothing changes: OrcaSynapse replays bounded complete-turn history
on every run. A governed replacement served from OrcaSynapse's own pgvector
plane is the next planned change.

## ai-v1.28.2 — 2026-08-05

Shorten every install command to the canonical `curl -fsSL` form.

- replace the four long flag names with `-fsSL` in the README, the enrollment
  runbook, the dashboard's generated VM2 install and removal commands, and the
  installer's own recovery message; `deploy/BOOTSTRAP.md` already used this
  form, so the estate is now consistent
- drop `--progress-bar` outright: it decorated a 21 KB download that finishes
  before it can render, and the installer draws its own progress once running
- keep fail-on-error, quiet, show-errors, and follow-redirects behavior
  unchanged — those cannot move into the script, because they govern the fetch
  that delivers it
- guard the canonical form in test-release-consistency.sh so the verbose
  spelling cannot return

## ai-v1.28.1 — 2026-08-05

Fix the front-page architecture diagram, which did not render, and give the
README the visual design it never had.

- fix Mermaid node labels that used `\n` for line breaks, which GitHub renders
  literally instead of wrapping — the README diagram and the ones in
  ARCHITECTURE.md and CURRENT_STATE_HANDOFF.md were all affected (introduced in
  ai-v1.28.0)
- replace the README's Mermaid block with `docs/assets/orcasynapse-architecture.svg`,
  a branded diagram matching the wordmark that shows both planes, what
  PostgreSQL actually holds, the optional SIEM egress, and the credential
  boundary
- add `docs/assets/orcasynapse-installer.svg`, a faithful rendering of the VM1
  installer's terminal output — the README's first picture of the product
- restructure the README so the architecture comes before the install command,
  trim the badge row, and rewrite the feature list with bolded lead-ins and a
  documentation index

## ai-v1.28.0 — 2026-08-05

The public-descriptor and brand-coherence release: the repository now tells the
truth about the product it contains.

- adopt the Business Source License 1.1 (`BUSL-1.1`), converting to Apache-2.0
  per release after four years; add SECURITY.md, CONTRIBUTING.md, this
  changelog, and issue/PR templates
- rewrite the README and docs/ARCHITECTURE.md for the real architecture:
  document knowledge lives in a local pgvector index (extract → chunk → BGE-M3
  embed → HNSW retrieval, originals never retained); Supermemory backs Hermes
  agent memory on VM2 only; the audit trail and SIEM forwarding are documented
  for the first time, including the new docs/AUDIT_TRAIL_RUNBOOK.md
- correct the PRD (the pgvector non-goal became the implementation), annotate
  the phased plan's superseded knowledge phase, fix the stale migration name in
  the prompt runbook, and sync the enrollment runbook and deploy/BOOTSTRAP.md
  with the reworked installers (six-step VM1 flow, DEGRADED enrollment window,
  remover state-root overrides)
- make the dashboard's Knowledge workspace stop describing the removed
  Supermemory pipeline: uploads are no longer gated on the VM2 memory service,
  the supported-format label is derived from the contract instead of a stale
  hardcoded list, and indexing/failure/delete copy names the local pipeline
- rewrite docs/CURRENT_STATE_HANDOFF.md to the current state and fix the
  wordmark's ON-PREMISE/ON-PREMISES inconsistency
- add license, description, and repository metadata to every package manifest

## ai-v1.27.0 — 2026-08-05

Trust-state honesty and contract widening.

- gate the post-enroll trust proof's ONLINE claim on both planes, matching the
  heartbeat client: a fresh install reports DEGRADED until Supermemory exists
- write the Hermes `.env` inference values raw instead of JSON-quoted
- widen `hermesVersion`/`installerVersion` to 256 characters in contracts and
  the `HermesRuntimeNode` columns (migration 0007) for digest-pinned
  private-registry references
- remove the dead `documentsPath`/`searchPath` fields from `registerMemory`
  and the strict connection contract
- restructure `rotate-installation-key.sh` into the shared three-step flow

## ai-v1.26.0 — 2026-08-04

One terminal experience for the installer family.

- extract `scripts/lib/installer-ui.sh` as the canonical installer UI and embed
  it verbatim in the self-contained scripts between markers;
  `scripts/sync-installer-ui.sh --check` is the CI drift test
- role accents distinguish the scripts: VM1 blue, VM2 enrollment cyan,
  decommission red, key rotation amber; every banner shows its version
- rework VM1 into a six-step flow with preflight checks, a persistent
  secret-free install log, readiness diagnostics, and a machine-readable
  completion marker
- honor `ORCASYNAPSE_*_STATE_ROOT` overrides in the remover, clean recorded
  image layers even when the container is already gone, and stamp the remover
  with its own `INSTALLER_VERSION` — a twelfth release surface enforced by
  `test-release-consistency.sh`

## ai-v1.25.0 — 2026-08-04

Restore fresh VM1 installability and turn CI truthful again. First tagged
release.

- copy the `packages/knowledge` manifest into the api and worker images so
  `pnpm install --frozen-lockfile` can resolve the workspace graph again
  (fresh installs had been broken since ai-v1.20.0)
- run the compose postgres service on `pgvector/pgvector:pg17`, matching CI, so
  the migrator can create the vector extension; reindex pre-existing data
  volumes once after the musl-to-glibc base change
- make `run_with_progress` report real failures in non-interactive mode across
  all three installer copies instead of printing `[ OK ]`
- rewrite `verify-postgres-integration.mjs` for Drizzle (the Prisma-based
  script had turned CI red) with a disposable-database deployment run twice for
  idempotency and DDL assertions on the vector column, HNSW index, and enums
- add `test-docker-build-closure.sh` and `test-release-consistency.sh` as CI
  guards, plus a non-blocking compose-build job

## ai-v1.22.0 – ai-v1.24.3 — 2026-08-04

The audit era: the trail written from every governed path became readable,
forwardable, and observable.

- `GET /api/v1/admin/audit/events` behind the `audit:read` scope, keyset-paged,
  exact-match filters; an Audit trail dashboard view under Operations
  (ai-v1.22.0, ai-v1.22.2)
- SIEM forwarding with a keyset cursor and at-least-once delivery, forwarding
  health (`HEALTHY`/`BEHIND`/`FAILING`/`NOT_CONFIGURED`) in the audit view, and
  an AI-Ops component that opens incidents when the destination rejects batches
  (ai-v1.24.0 – ai-v1.24.3)
- conversation-scoped knowledge: pin documents to a conversation
  (`ChatConversationDocument`, `AgentRun.knowledgeDocumentIds`), with a chat
  Knowledge picker and the dashboard's first jsdom interaction test
  (ai-v1.23.0 – ai-v1.23.4)
- `SUPPORTED_DOCUMENT_TYPES` as the single source of truth binding the upload
  picker, the 415-rejecting upload route, and the extractor (ai-v1.22.1)
- onboarding became completable from the dashboard: architecture decision,
  component attestation, and the activation control (ai-v1.22.3)
- timer-driven stale-executor reaping in operations (ai-v1.23.3); dead code
  from the ORM and retrieval transitions removed, including `ToolActionDispatch`
  and `DocumentMemoryPublication` (ai-v1.21.12, ai-v1.22.0)

## ai-v1.19.0 – ai-v1.21.11 — 2026-08-03 – 2026-08-04

The Drizzle and local-knowledge era.

- migrated every manager, the worker, and the inference gateway from Prisma to
  Drizzle ORM against a structurally verified baseline migration, then removed
  Prisma entirely; data-layer tests run against real per-file migrated
  PostgreSQL databases
- moved enterprise document knowledge from Supermemory into a local pgvector
  index (`DocumentChunk` with 1024-dimension BGE-M3 embeddings, HNSW cosine
  retrieval, in-flight extraction, originals never stored), removing the
  dependency behind the outstanding Supermemory release contradiction
- hardened worker run durability: approval-state discovery, slot-based
  dispatch, honest shutdown, history-trim correctness, and lease release

## ai-v1.0.0 – ai-v1.18.x — 2026-08-02 – 2026-08-03

The foundation series: the two-VM product took shape.

- VM1 control plane (Fastify API, React dashboard, worker, PostgreSQL via
  Docker Compose) with envelope-encrypted secrets, local administrator
  provisioning, the offline Installation Key, and the public one-line bootstrap
- VM2 Agentic System enrollment: Ed25519 node identity, one-time claims, signed
  replay-protected heartbeats, digest-pinned Hermes container, checksum-verified
  Supermemory Local, resumable recovery journal, and the decommission flow
- governed Hermes-first Chat with durable Agent Runs, immutable Profile
  distributions, prompts, guardrails, model routes, the node-scoped inference
  gateway, operations/incidents/evidence, and OIDC enterprise access
