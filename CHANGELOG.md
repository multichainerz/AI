# Changelog

Every release is one commit on `main` whose subject is the version (`vX.Y.Z`),
tagged with the same name. Entries below are newest first. The `v0.x` and
`v1.x` entries each cover a phase of the early development line rather than a
single change.

## v0.9.0 — 2026-08-06

Agent memory becomes what it claims to be: extracted facts, in the third person,
with a profile and a version chain.

- **Stop storing whole turns.** Of 21 stored "memories" on the pilot, every one
  was a question, a command, a greeting, the model describing itself, or the
  operator's own system prompt — and recall embeds a new question, so the
  highest-scoring hits were the least useful rows in the store.
  `MemoryDistiller` extracts durable facts about the person after the answer is
  delivered, and a distiller that cannot be reached stores nothing rather than
  quietly reinstating the behaviour it replaces.
- **Keep extracted facts in the third person.** The pilot stored a first-person
  sentence, which reads later as the assistant describing itself. A fact opening
  with a first-person pronoun is dropped rather than rewritten, because a model
  that mis-attributed the speaker may have got the attribution wrong too.
- **A profile: the facts an agent is told regardless of the question.** Semantic
  search cannot retrieve a fact that resembles no question, so each fact is
  classified `STATIC`, `DYNAMIC` or `EPISODIC`, and an **ABOUT THIS PERSON** block
  is injected with no similarity search — bounded twice and trimmed a whole fact
  at a time, since half a fact is worse than one fewer.
- **Version chains: a corrected fact stops being recalled without being lost.** A
  similarity floor cannot decide this — "loves Adidas" and "prefers Puma" are not
  near-duplicates, yet one plainly retires the other — so the model decides,
  inside the distillation call already being made. Supersede and insert happen in
  one transaction, so no reader ever sees both as current, and candidates are
  shown numbered rather than by id.
- Three follow-ups the pilot forced: the distiller had no room to think, so a
  truncated answer read as "nothing learned"; supersession retired a near-
  identical episodic row while leaving the always-injected one live; and the
  chain columns were never populated at all.
- **CI goes green after 76 consecutive red runs.** `verify` typechecked before
  building, and cross-package types resolve through each package's emitted
  `dist/index.d.ts` — so on a fresh checkout, which is every CI run, the
  importing files' inferred types collapsed to `any`. It never reproduced on a
  development machine, because a leftover `dist/` satisfies the import.

## v0.8.0 — 2026-08-05 – 2026-08-06

Toolset admission, and a signed desired-state document the runtime actually
applies.

- **Toolset admission is the boundary that lets a runtime have tools at all.**
  Hermes executes its own tools server-side, so OrcaSynapse cannot scope an
  individual call — admission is the boundary available, which makes drift the
  thing to fail on. A run is refused when the runtime has a toolset enabled that
  nobody admitted, naming it. With nothing admitted this is exactly the zero-tool
  boundary it replaces.
- **The control plane gains a signing identity.** `ControlPlaneSigningKey` is an
  Ed25519 identity whose private half is sealed with the same envelope scheme as
  connection secrets. The document has to be *signed* rather than merely
  authenticated, because a node acts on it — anything able to answer the node's
  request could otherwise reconfigure it. It is carried base64-encoded and those
  exact bytes are signed, so a shell verifier on the node never has to reproduce
  a canonical JSON serialization.
- **VM2 consumes it**, which closes the loop from an operator's decision in the
  dashboard to what the runtime is running. The control plane's public key is
  pinned at enrollment, and a node that never received one applies nothing rather
  than trusting an unsigned document. An empty admission set is an instruction,
  not an omission.
- Admission becomes something an operator can see and decide, with drift raised
  as an alert rather than left to be inferred from failing chats.
- Two corrections found by watching the runtime rather than the config file:
  dropping the `no_mcp` sentinel re-enabled every globally enabled MCP server,
  and the sentinel alone does not govern a globally enabled toolset —
  `agent.disabled_toolsets`, subtracted after every other rule, is what produced
  the admitted set on the pilot.
- A cohesion pass collapses three copies of `canonicalize` into one, refuses
  signed bodies containing numbers (`JSON.stringify(1.0)` is `1` where jq emits
  `1.0`), and makes the secret-envelope version guard reachable.
- The safety argument behind consequential-call blocking is corrected: `maxTurns`
  is a boundary OrcaSynapse declares about its own profiles and never transmits.

## v0.7.0 — 2026-08-05

A readable chat transcript, administrable retrieval, and tool approvals.

- **Tell the two speakers apart.** User and assistant turns rendered as identical
  729px rows distinguished only by an avatar tint, so a transcript was a wall of
  text you could not scan. The person's turn is now a bounded card and the
  agent's is open content, the composer is aligned with the transcript, and six
  of the header's seven actions move behind one overflow menu — they had left the
  title 219px of a 912px column.
- **Surface what the runtime can actually do.** A new catalogue route reads
  Hermes's own toolset and skill endpoints — a live node reports 28 toolsets and
  67 skills, none of which the dashboard had ever shown — and states the policy
  plainly rather than leaving an empty screen to be interpreted.
- **Document retrieval becomes administrable**, closing an asymmetry: memory
  recall had a governed policy while knowledge retrieval was two constants in the
  worker. `knowledgeRecallLimit` and `knowledgeMinimumScore` join `MemoryPolicy`,
  defaulting to exactly the previous values.
- **Consequential tools can be approved instead of refused.** `invoke()` threw
  before any grant or human was consulted; it now records the call as
  `APPROVAL_PENDING` and opens a `ToolApproval`. No migration was needed — the
  table, the status and the TTL were all already in the schema, and only the code
  had been removed. Approval authorises the call and not the data, and the inline
  wait is capped at five minutes independent of the configured TTL.
- An approval nobody can see is a boundary nobody can operate, so a **Waiting on
  you** panel lists every blocked call with its exact arguments and when the
  decision lapses.
- **Stop reporting token usage the runtime never measured.** Hermes returns an
  all-zero usage block for providers that do not report it, and a completed run
  always consumes input tokens — so zeroes beside real output mean silence, not a
  measurement of zero.

## v0.6.0 — 2026-08-05

The audits taken before the next phase of work, and the shakeout a fresh
containerised install produced.

- **A coherence pass over the dashboard.** Four admin views stayed operable
  during a forced password change, so an administrator mid-change got a full
  workspace whose every request failed; one shared `adminAccess(session)` now
  derives what is usable and what it grants. Every admin view takes the same
  props, replacing two competing conventions, and 101 duplicate CSS rules across
  three copy-pasted blocks are merged.
- **Four high-severity advisories in shipped dependencies**, closed by pnpm
  overrides. `pnpm security:audit` had been a package script since the first
  release and was never wired into CI, which is why they went unnoticed; it is
  blocking now.
- **A fresh containerised install was unusable, and only building one showed
  it.** Both call sites constructed the embedder with no cache directory, so the
  library defaulted to a folder under `node_modules` that every shipped image
  makes unwritable — the first embedding failed with `EACCES` in any container,
  which left every chat turn `RUNNING` and every upload stranded in `CONVERTING`.
  It never showed up in tests, which run outside a container.
- **Three more the sandbox exposed**: uploads exceeded nginx's 60-second read
  timeout because the API loaded ~2 GB of weights and embedded inline; a crash
  mid-ingest stranded a document forever, since agent runs had lease reclamation
  and documents had nothing; and an air-gapped install could never embed
  anything, because the code had always claimed the model must be seeded at
  install time and nothing ever did the seeding.
- PDF ingestion gets its first end-to-end test, which immediately caught that
  moving extraction ahead of the insert made the recorded byte size read `0` —
  pdf.js takes ownership of the typed array it is handed and detaches it.

## v0.5.0 — 2026-08-05

Supermemory is removed, and agent memory returns on OrcaSynapse's own pgvector
plane under a governed policy.

- **VM2 now runs exactly one plane** — the Hermes runtime — and holds no durable
  data store of its own. Around 450 lines leave the VM2 installer, and the worker
  stops refusing every run on a remote memory plane's health, which had made a
  VM2 memory outage stop all agent execution.
- **`AgentMemory` mirrors `DocumentChunk`**: hybrid cosine and lexical recall
  over an HNSW index, with the (owner, agent) scope as a predicate inside every
  statement rather than a namespace handed to a service, so nothing a caller
  supplies can widen it.
- `memoryMode` on a profile version is the dashboard-facing choice of what an
  agent does — `DOCUMENTS_ONLY` by default, so an upgrade stores nothing about
  anyone until someone decides otherwise — materialized into run capabilities
  frozen onto the run, so editing a profile cannot change what an in-flight run
  may do. `LEARN_USER` stores the person's turn and never the model's output, so
  an answer the model got wrong once cannot become a durable fact.
- **`MemoryPolicy` is one installation-wide ceiling.** `maximumCaptureMode` caps
  every agent at once, and it is read at capture time rather than at submission,
  so suspending capture applies to runs already in flight. An active policy
  cannot be edited in place, because runs are being measured against it.
- **The whole policy becomes load-bearing.** `retentionDays`,
  `maximumItemsPerOwner`, `recallLimit` and `recallMinimumScore` were stored,
  documented and editable while the worker used hardcoded values and never
  stamped an expiry. `retentionUntil` is now stamped from the policy in force at
  capture, so lengthening retention later cannot retroactively extend what is
  already stored under a shorter promise.
- The person a memory is about can see and delete it: both the listing and the
  deletion take the owner from the authenticated session and never from the
  request. Remembered content stays out of the audit trail entirely — the trail
  records that memory changed, the reason and the count, never what it said.

## v0.4.0 — 2026-08-04 – 2026-08-05

Release engineering, one terminal experience for the installer family, and a
repository that tells the truth about the product it contains.

- **Fresh VM1 installability restored.** The `packages/knowledge` manifest is
  copied into the api and worker images so a frozen-lockfile install can resolve
  the workspace graph again, and compose runs postgres on a pgvector image
  matching CI, so the migrator can create the extension.
  `test-docker-build-closure.sh` and `test-release-consistency.sh` join CI as
  guards.
- **`scripts/lib/installer-ui.sh` becomes the canonical installer UI**, embedded
  verbatim in the self-contained scripts between markers, with
  `sync-installer-ui.sh --check` as the drift test. Role accents distinguish the
  scripts, VM1 becomes a six-step flow with preflight checks and a secret-free
  install log, and the remover carries its own `INSTALLER_VERSION` — a twelfth
  release surface the consistency test enforces.
- **The Business Source License 1.1** is adopted, converting to Apache-2.0 per
  release after four years, alongside SECURITY.md, CONTRIBUTING.md, this
  changelog, and issue and pull-request templates.
- The README and `docs/ARCHITECTURE.md` are rewritten for the real architecture —
  document knowledge in a local pgvector index, originals never retained — and
  the audit trail and SIEM forwarding are documented for the first time. The
  README gains a branded architecture diagram and a rendering of the installer's
  own output.
- Every install command shortens to the canonical `curl -fsSL` form, guarded in
  `test-release-consistency.sh` so the verbose spelling cannot return.

## v0.3.0 — 2026-08-04

The audit era: the trail written from every governed path became readable,
forwardable and observable.

- `GET /api/v1/admin/audit/events` behind the `audit:read` scope, keyset-paged
  with exact-match filters, and an Audit trail view under Operations.
- SIEM forwarding with a keyset cursor and at-least-once delivery, forwarding
  health reported as `HEALTHY`/`BEHIND`/`FAILING`/`NOT_CONFIGURED`, and an AI-Ops
  component that opens an incident when the destination rejects batches.
- Conversation-scoped knowledge: documents pin to a conversation
  (`ChatConversationDocument`, `AgentRun.knowledgeDocumentIds`), with a chat
  Knowledge picker and the dashboard's first jsdom interaction test.
- `SUPPORTED_DOCUMENT_TYPES` becomes the single source of truth binding the
  upload picker, the 415-rejecting upload route and the extractor.
- Onboarding becomes completable from the dashboard — architecture decision,
  component attestation and the activation control — and operations reaps stale
  executors on a timer. Dead code from the ORM and retrieval transitions is
  removed, including `ToolActionDispatch` and `DocumentMemoryPublication`.

## v0.2.0 — 2026-08-04

The Drizzle and local-knowledge era.

- Every manager, the worker and the inference gateway move from Prisma to Drizzle
  ORM against a structurally verified baseline migration, and Prisma is removed
  entirely. Data-layer tests run against real per-file migrated PostgreSQL
  databases.
- Enterprise document knowledge moves from Supermemory into a local pgvector
  index: `DocumentChunk` with 1024-dimension BGE-M3 embeddings, HNSW cosine
  retrieval, in-flight extraction, and originals never stored.
- Worker run durability is hardened: approval-state discovery, slot-based
  dispatch, honest shutdown, history-trim correctness and lease release.

## v0.1.0 — 2026-07-30 – 2026-08-04

The foundation series: the two-VM product took shape.

- VM1 control plane — Fastify API, React dashboard, worker, PostgreSQL via Docker
  Compose — with envelope-encrypted secrets, local administrator provisioning,
  the offline Installation Key and the public one-line bootstrap.
- VM2 Agentic System enrollment: Ed25519 node identity, one-time claims, signed
  replay-protected heartbeats, a digest-pinned Hermes container,
  checksum-verified Supermemory Local, a resumable recovery journal and the
  decommission flow.
- Governed Hermes-first Chat with durable Agent Runs, immutable Profile
  distributions, prompts, guardrails, model routes, the node-scoped inference
  gateway, operations/incidents/evidence, and OIDC enterprise access.
