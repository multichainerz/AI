# Changelog

Every release is one commit on `main` whose subject is the version (`ai-vX.Y.Z`),
tagged with the same name. Entries below are newest first. Releases before
ai-v1.25.0 predate this file and are backfilled from the commit bodies; releases
before ai-v1.19.0 are summarized per series.

## ai-v1.49.0 — 2026-08-06

Version chains: a corrected fact stops being recalled, without being lost.

`remember()` was a plain `INSERT`. "The user works in Jakarta" and a later "the
user works in Bandung" both persisted, both recalled, and nothing said which was
current — so the agent could confidently assert something the person had already
corrected.

**The decision is model-judged, not threshold-judged.** A similarity floor cannot
do this: "The user loves Adidas sneakers" and "The user prefers Puma" are not
near-duplicates, yet the second plainly retires the first, and a change of mind
is the common case rather than an edge case. So candidates come from a
moderate-floor search and the model decides — inside the distillation call that
was already being made, at no extra cost.

- add `version`, `parentMemoryId`, `rootMemoryId`, `isLatest`, `supersededAt`
  and `supersededReason`, with a partial index on the current-facts predicate.
- **supersede and insert in one transaction**, so no reader ever sees both the
  old fact and its replacement as current, nor loses the old one without the new
  one landing. That guarantee is the thing an external memory service could not
  give and owning the plane does.
- recall, profile and the current-facts predicate all filter `isLatest`. A
  retired fact stays for audit but is never recalled — the point of superseding
  is that the agent stops asserting it.
- the prompt shows the candidate facts **numbered, never by id**: a number
  cannot be mangled into a different memory, and an index naming a fact that was
  never offered is ignored rather than applied.
- cap one turn at three retirements. A model that decides everything is
  superseded must not be able to empty the store.
- supersession is scoped by owner and agent like every other statement, so a
  borrowed id cannot retire someone else's fact.

## ai-v1.48.0 — 2026-08-06

A profile: the facts an agent is told regardless of the question.

Semantic search cannot retrieve a fact that resembles no question. On the pilot,
`prefers answers in Indonesian` was stored correctly and never returned, because
a language preference has nothing in common — vector-wise — with "what should I
prepare for the event?". No `recallMinimumScore` fixes that; the fact needs to
bypass search entirely.

- classify each extracted fact as `STATIC` (role, location, language, standing
  preferences), `DYNAMIC` (a current project or deadline), or `EPISODIC` (the
  default — reached only by search). The distiller decides as it extracts, and
  is told to prefer EPISODIC when unsure, because a wrong STATIC fact is
  repeated on every message forever.
- inject an **ABOUT THIS PERSON** block into every prompt, built from STATIC
  plus recent DYNAMIC with **no similarity search**. Bounded twice — ten facts
  and 1200 characters — and trimmed a whole fact at a time, since half a fact is
  worse than one fewer. An empty profile says nothing is established yet rather
  than implying the person has no preferences.
- the parser accepts a bare string as well as the classified object, filing it
  as EPISODIC: a model that ignored the format still extracted a fact, and
  losing it is worse than filing it where only search reaches it. An
  unrecognised scope falls back to EPISODIC for the same reason it is the
  default — the least privileged scope, not the most.
- an undistilled turn is never profile material; a whole turn shown on every
  message would put a question in front of the model forever.
- show the scope in the memory view, so an operator can see exactly which facts
  are always-on and delete one that should not be.

A profile is a view over stored facts, not a separate document — which is how
Supermemory models it too, and why this is a column and a query rather than a
new table.

## ai-v1.47.0 — 2026-08-06

Keep extracted facts in the third person.

The pilot stored `Saya bekerja di Jakarta` — first person, which reads later as
the assistant describing itself rather than the person it is about. A 2.6B model
mirrors the language and person of its input, so the prose instruction telling it
to use the third person was simply ignored.

- add worked examples to the distillation instruction, including a non-English
  one, because examples steer a small model where rules do not.
- **reject a fact whose opening word is a first-person pronoun**, in English or
  Indonesian. The fact is dropped, not rewritten: a model that mis-attributed the
  speaker may have got the attribution wrong too, and guessing at a rewrite would
  store a sentence nobody said. Only the opening word counts — "The user prefers
  that I ask first" is a legitimate fact.
- ask for facts in the user's own language but grammatical within it, rather than
  mixed, since BGE-M3 matches a question best in the language it was asked.

Supermemory grounds extraction with the person's name ("User is Dhravya…") so
facts read "Dhravya is doing great". That is deliberately not copied: our rows
are already scoped by `ownerSubject` in SQL, so a name would duplicate identity
into stored content that then rides along into prompts, exports, and logs.

## ai-v1.46.1 — 2026-08-06

Fix a type error `ai-v1.46.0` shipped.

`memory-distiller.test.ts` narrowed `fetcher.mock.calls[0]` straight to a tuple,
which `tsc` rejects. It was written after the last typecheck of that release and
vitest does not typecheck, so the suite passed while `pnpm typecheck` failed —
which is exactly the gap `pnpm verify` exists to close and which was not run
again before tagging.

Also corrects documentation that shipped claims the live runtime disproved. The
memory runbook still said model-distilled capture was "deliberately not
implemented" hours after `ai-v1.46.0` implemented it; ARCHITECTURE, the phased
plan and the PRD described the governed MCP surface as default-deny with one
working handler, when it is unreachable — no shipped Hermes advertises the
private run-context contract it requires, and Hermes forwards no caller identity
to an MCP server, so a call cannot be scoped to its requester.

## ai-v1.46.0 — 2026-08-06

Agent memory stores extracted facts instead of whole turns.

Capturing raw turns does not produce memory, and the pilot proved it. Of 21
stored "memories", every one was a question (`what is your name?`), a command
(`Summarize the main considerations…`), a greeting, the model describing itself
(`I am LFM, which stands for Liquid Foundation Model…`), or the operator's own
system prompt. Recall then embeds a new question and matches previous
*questions*, so the highest-scoring hits were the least useful rows in the
store — which is why memory never visibly helped.

- add `MemoryDistiller`: after the answer is delivered, one model call extracts
  durable facts about the person and returns an empty list when the turn taught
  nothing, which is the common case. The instruction names the categories that
  actually polluted the store — questions, tasks, greetings, the assistant's own
  self-description, system prompts, inferences — because each was observed.
- **a distiller that cannot be reached stores nothing.** Falling back to raw
  turns would quietly reinstate the behaviour this replaces.
- parse strictly: a fenced or prose-wrapped answer is read where it clearly
  contains an array, and anything else yields no facts. A model that ignored
  "JSON only" also ignored the prohibitions, so its prose must not become a
  memory through a salvage attempt.
- add `distillCapture` to the memory policy, on by default and editable from
  the Memory card. A profile only reaches capture by opting into a LEARN mode,
  and the behaviour being replaced is measurably not memory.
- record `distilled` on the `memory.captured` audit event, so the trail
  distinguishes an extracted fact from a stored turn without recording either.

## ai-v1.45.2 — 2026-08-06

Suppress unadmitted toolsets with `agent.disabled_toolsets`.

`ai-v1.45.1` kept the `no_mcp` sentinel and still did not work: admitting
`clarify` left the runtime reporting `['bfl', 'clarify']`. The sentinel governs
MCP servers, and `bfl` is not one — a toolset enabled globally runs regardless
of the platform allowlist.

`agent.disabled_toolsets` is subtracted after every other rule. Naming every
unadmitted toolset there produced exactly `['clarify']` on the pilot, verified
by hand before this was written rather than after.

- the reconciler now maintains two settings: `platform_toolsets.api_server`
  allowlists the admitted names beside the sentinel, and
  `agent.disabled_toolsets` names everything the runtime knows about that was
  not admitted.
- the runtime's own catalogue supplies the complete name list, since the desired
  state carries only what was admitted. If it is unavailable the admitted set
  still applies and nothing extra is suppressed that pass — the control plane
  keeps refusing runs until one succeeds.
- the rewrite moved from awk to python3 because it now maintains two blocks
  idempotently, which is verified: applying the same admission twice leaves the
  file byte-identical, so Hermes is not restarted for nothing.

## ai-v1.45.1 — 2026-08-06

Keep the `no_mcp` sentinel when applying an admitted toolset.

Found by watching the runtime rather than the config file: admitting `clarify`
alone left Hermes reporting `['bfl', 'clarify']` enabled. Hermes treats an
explicit toolset list as an allowlist for its own toolsets, but dropping the
sentinel also re-enables every globally enabled MCP server — so one admission
silently brought up Black Forest Labs image generation as well.

The control plane then refused every run over the unadmitted toolset, which is
the ai-v1.40.0 boundary working exactly as intended; the drift it caught was
real. The reconciler now writes the sentinel in every case, admitted names or
not, which suppresses the defaults while explicit names still take effect.

When OrcaSynapse's own MCP server becomes admittable the sentinel would suppress
that too, so the desired-state document will need to distinguish a native
toolset from an MCP server. Noted at the point of change.

## ai-v1.45.0 — 2026-08-06

The runtime applies the toolset allowlist OrcaSynapse admitted for it.

`ai-v1.41.0` began serving a signed desired-state document and nothing consumed
it. VM2 now does, which closes the loop from an operator's decision in the
dashboard to what the runtime is actually running.

- **pin the control plane's public key at enrollment.** A node that never
  received one applies nothing rather than trusting an unsigned document, so a
  node enrolled before `ai-v1.41.0` stays fail-closed until it is re-enrolled.
- add a reconciler that fetches the document with the same signed-request scheme
  as the heartbeat, verifies the Ed25519 signature over the exact bytes it
  received before parsing them, and refuses a document addressed to another node
  so one cannot be replayed across runtimes.
- rewrite only the `api_server` toolset list in the managed policy, leaving every
  other managed setting exactly as the installer wrote it, and restart Hermes
  only when the file actually changed.
- **treat an empty admission set as an instruction.** It restores the `no_mcp`
  sentinel, so revoking every toolset returns the runtime to tool-free rather
  than leaving whatever was already enabled in place.
- run it on a five-minute timer, and teach the remover to stop, disable and
  delete the new unit so removal stays complete.

## ai-v1.44.0 — 2026-08-06

Stop asserting a boundary that is never transmitted, and describe the estate
that actually exists.

- **correct the safety argument behind consequential-call blocking.** It read
  "MCP is request/response and `maxTurns = 1` means the agent cannot come back
  later", but `maxTurns` is a boundary OrcaSynapse declares about its own
  profiles and never sends: the run submission carries no turn field and Hermes
  exposes no turn control. Blocking has to hold because there is no channel to
  answer a call that already returned — which is true on its own. What actually
  keeps a run single-step is that no toolset is admitted.
- correct the same claim where `maxTurns` is defined, so the contract stops
  implying it limits the runtime rather than refusing profiles that ask for more.
- rewrite the current-state handoff, which still described a WSL lab with
  instances that no longer exist and a Phase 4 plan written before the runtime
  was reachable. It now records what driving the live Hermes established: the
  command channel does not exist, conversational multi-turn already works, and
  the governed MCP plane is blocked on owner scoping rather than on effort —
  Hermes invokes a tool as `session.call_tool(name, arguments)` with no session,
  run or user forwarded, over a connection shared by every run and every person,
  so a call cannot be scoped to its requester.

## ai-v1.43.0 — 2026-08-06

Cohesion cleanup from a full-codebase audit. No behaviour changes.

- **collapse three copies of `canonicalize` into one.** Two managers and a test
  each carried an identical implementation, which meant the test validated the
  algorithm against its own copy and could never catch a divergence. The test
  now imports the implementation it verifies.
- **refuse signed bodies containing numbers.** The runtime node installer signs
  with `jq -cS` and the control plane verifies with `canonicalize`; the two
  agree on strings, booleans, null, arrays and ASCII keys, but not on
  non-integer numbers — `JSON.stringify(1.0)` is `1` where jq emits `1.0`. No
  signed body carries a number today, and `assertSignableBody` now fails loudly
  on the verification path instead of leaving the trap armed for whoever adds
  the first numeric field.
- **make the secret envelope version guard reachable.** `decrypt` refuses any
  `encryptionVersion` other than 1, but `drizzle-connection-manager` built the
  envelope inline with `1` hardcoded, so a row written under a future format
  would have been presented as version 1 and failed later as a confusing
  authentication-tag error. `storedEnvelope` now narrows once, in
  `@orcasynapse/security`, and throws a format error instead. The OIDC and
  runtime-client read paths already checked this correctly and are unchanged.
- **remove dead code**: `booleanConfiguration` (no references anywhere), and the
  `updateOnboardingStep` / `updateOnboardingComponent` dashboard clients, which
  had no caller. Their backend routes remain — they are a real API, and
  `updateStep` still lets an operator mark a stage blocked with a note.
- de-duplicate the two byte-copying envelope helpers that had drifted into the
  same file, narrow seven symbols exported but used only within their own file,
  and drop `controlPlanePublicKey` from the public manager interface.

## ai-v1.42.0 — 2026-08-05

Toolset admission becomes something an operator can see and decide.

- add a **Toolset admission** panel to Governed tools, merging the runtime's
  reported catalogue with this installation's decisions. Every toolset the
  runtime knows about is listed with its admission state; admitting one permits
  the runtime to enable it at all.
- surface drift as an alert. A toolset the runtime has enabled that nobody
  admitted is the state that refuses every run, so it is named rather than left
  for someone to infer from failing chats.
- keep an admitted toolset on screen even when the runtime never reported it.
  Hiding it would make a pending revocation look like it had already happened.
- require a reason of at least three characters to admit or revoke, matching
  every other governed decision in the console.
- treat the runtime catalogue as informative rather than load-bearing: if the
  runtime is unreachable the panel still renders from recorded admissions
  instead of blanking the page.

## ai-v1.41.0 — 2026-08-05

The control plane gains a signing identity, and can state what a node should be.

Nothing consumes the document yet, so no runtime behaviour changes. The node
side lands separately, which keeps the installer out of this release.

- add `ControlPlaneSigningKey`: an Ed25519 identity generated on first use,
  private half sealed with the same envelope scheme as connection secrets.
  Runtime nodes already sign what they report upward; this is the other
  direction, and it has to be *signed* rather than merely authenticated,
  because a node acts on the document — anything able to answer the node's
  request could otherwise reconfigure it.
- serve `GET /api/v1/runtime-nodes/:nodeId/desired-state`, authenticated by the
  node's own signature exactly like the heartbeat, so one node cannot read
  another's desired state and a revoked node is refused before a document
  exists.
- carry the document base64-encoded and sign those exact bytes. The verifier is
  a shell script on the runtime host, and it must not have to reproduce a
  canonical JSON serialization to check a signature — it decodes what it was
  given, verifies, and only then parses.
- state an empty admission set explicitly rather than omitting it. "Enable
  nothing" is an instruction; a node that received no list must not be free to
  keep whatever it already had running.
- return `controlPlanePublicKeyPem` and `desiredStatePath` from enrollment, so
  a node pins the key it will verify against at the moment it joins.

## ai-v1.40.0 — 2026-08-05

Toolset admission: the boundary that lets a runtime have tools at all.

Nothing observable changes for an existing installation. With no toolset
admitted this is exactly the zero-tool boundary it replaces, and a fresh
install admits nothing.

- add `RuntimeToolsetAdmission`, recording which Hermes toolsets an operator
  permits the runtime to enable, who decided, and why. The row survives
  revocation so the reason stays on record; absence means never admitted,
  which refuses identically.
- replace the zero-tool boundary with one that refuses a run when the runtime
  has a toolset enabled that nobody admitted, naming it. Hermes executes its
  own tools server-side, so OrcaSynapse cannot scope an individual call the way
  it scopes its own governed tools — admission is the boundary available, which
  makes drift the thing to fail on.
- resolve admissions per run rather than caching them, so a revocation takes
  effect on the next run instead of whenever a worker happens to restart.
- expose `GET /admin/tooling/toolsets` on `tools:read` and
  `PUT /admin/tooling/toolsets/:name` on `tools:manage`, audited as
  `tool.toolset_admitted` / `tool.toolset_revoked`.
- assert that the governed-MCP boundary still fails closed against the
  capabilities document a real Hermes returns. `private_run_context:
  "orcasynapse_mcp_headers_v1"` is OrcaSynapse's own name for a handoff no
  shipped Hermes advertises, and the existing tests only ever exercised it
  against a mock that claimed support — so the path was never reachable in
  practice and nothing said so.

## ai-v1.39.2 — 2026-08-05

Stop reporting token usage the runtime never measured.

- treat an all-zero usage block on a run that produced output as **unreported**
  rather than as a measurement of zero. Hermes returns
  `{input_tokens: 0, output_tokens: 0, total_tokens: 0}` for providers that do
  not report usage — llama.cpp behind an OpenAI-compatible gateway among them —
  and every completed run on the pilot had recorded `0|0|0` while plainly
  producing output. A completed run always consumes input tokens, because
  instructions are never empty, so zeroes against real output mean silence.
- apply the same reading to the `run.completed` event, which carries both the
  zeroed usage block and the output that proves work happened. Other event types
  are untouched: a `tool.start` legitimately has no tokens to report.
- show **Not reported** rather than `0 tokens` for a conversation whose messages
  were never measured, in both the chat summary and the runtime strip. Summing
  nulls as zeroes had put the false claim back at the aggregate after the
  per-message values became honest.

## ai-v1.39.1 — 2026-08-05

Phase 4c, second slice: the approvals surface an operator can actually use.

- add a **Waiting on you** panel to Governed tools listing every consequential
  call blocked on a human — the tool, the agent profile, who asked, the exact
  arguments, and when the decision lapses. `ai-v1.39.0` shipped the routes but
  an approval nobody can see is a boundary nobody can operate
- the panel states what approving does and does not do: it authorises this call
  only, cannot reach data the requester could not already reach, and does not
  re-grant the tool. That property is the easiest one to assume wrong
- a decision reason of at least three characters is required before either
  button enables, and `tools:manage` gates both

Also corrects a test in this file that was passing vacuously.
`renderToStaticMarkup` does not run effects, so the panel it claimed to assert
against had never rendered — `expect(html).toContain("cannot")` matched an
unrelated word elsewhere in the markup. Replaced with tests over the contract
the panel and the API agree on, which is the part that can break silently.

## ai-v1.39.0 — 2026-08-05

Phase 4c, first slice: consequential tools can be approved instead of refused.

- **stop refusing CONSEQUENTIAL tools outright.** `invoke()` threw "no
  consequential tool handler is installed" before any grant or human was
  consulted. It now records the call as `APPROVAL_PENDING`, opens a
  `ToolApproval`, and waits for a decision
- **no migration was needed.** `APPROVAL_PENDING`, the `ToolApproval` table with
  its call FK and expiry, and `approvalTtlMinutes` in runtime control were all
  already in the schema — only the code had been removed. The estimate of
  "rebuild the executor from scratch" was wrong about how much survived
- add `GET /admin/tooling/approvals` (`tools:read`) and
  `POST /admin/tooling/approvals/:id/decision` (`tools:manage`). Approving is
  the act the boundary exists to gate, so it takes the stronger scope
- the decision is a conditional update on `PENDING` and unexpired, so two
  administrators racing cannot both decide and a lapsed approval cannot be
  revived
- **cap the inline wait at 5 minutes**, independent of `approvalTtlMinutes`.
  That setting may be 1440, which is a reasonable lifetime for a decision and an
  absurd one to hold an HTTP request open for. Hitting the cap expires the
  approval too, so the record never shows a decision pending on a failed call
- the audit trail records the reason and never the arguments, which can carry
  the very data the approval exists to protect

**Approval authorises the call, not the data.** A test pins this: an approved
call proceeds to execution and is then refused by the owner boundary. Grant
checks and requester checks also still run *before* any human is asked, so an
approval can never widen what the grant already allowed.

Still to come in 4c: consequential handlers themselves (only
`builtin.document_metadata_read` exists), per-profile toolset enablement, and
the dashboard surface for pending approvals.

## ai-v1.38.0 — 2026-08-05

Document retrieval becomes administrable, closing an asymmetry: memory recall
had a governed policy while knowledge retrieval was two constants in the worker.

- add `knowledgeRecallLimit` and `knowledgeMinimumScore` to `MemoryPolicy`,
  replacing the hardcoded `limit: 18, minimumScore: 0.35` in
  `agent-processor.ts`. An operator could tune what an agent remembered but not
  what it retrieved
- both default to exactly the previous constants, so behaviour is unchanged
  until someone decides otherwise, and the bounds check rejects a limit below 1
  or a score outside 0–1
- resolve them in `memoryLimits()` beside the memory bounds, so one active
  policy governs all retrieval and the value in force at retrieval time is the
  one that applies
- surface both in the policy editor with guidance rather than bare numbers: the
  floor is what decides whether a question phrased unlike the source text
  retrieves anything at all
- extended these as fields on the existing policy rather than adding a fifth
  policy table. Retrieval limits are tuning, not governance — the owner boundary
  that actually protects data is a SQL conjunct and is not tunable — so the
  DRAFT/ACTIVE/SUSPENDED lifecycle would have been machinery without a decision
  behind it
- cover that an active policy reaches document retrieval and that the shipped
  defaults apply when none is active

## ai-v1.37.0 — 2026-08-05

Chat gets a readable transcript and a window into what the runtime can do.

- **tell the two speakers apart.** User and assistant turns rendered as
  identical 729px rows — same width, same left edge, distinguished only by an
  avatar tint — so a transcript was a wall of text you could not scan. The
  person's turn is now a bounded card and the agent's is open content
- **align the composer with the transcript.** `.chat-messages` reserves a
  scrollbar gutter and `.chat-composer-wrap` did not, so their right edges sat
  ~15px apart at every width. Measured on a live install: transcript 729px,
  composer 744px
- **stop the header competing with the conversation.** Seven action buttons plus
  telemetry left the title 219px of a 912px column. Knowledge and Skills stay
  inline; Rename, memory, Fork, Export, Archive and Delete move behind one
  overflow menu
- **surface what the runtime can actually do.** New `GET
  /admin/agents/runtime/catalogue` reads Hermes's own `/v1/toolsets` and
  `/v1/skills`. A live node reports **28 toolsets and 67 skills**, none of which
  the dashboard has ever shown. The panel states the policy plainly — "all 28
  toolsets are disabled by the managed runtime policy" — so the boundary is
  visible instead of being inferred from an empty screen
- discovery is deliberately lenient where the execution gate is not:
  `assertBaseBoundary` still fails closed on an unrecognised toolset, while
  `catalogue()` skips a malformed skill rather than refusing to render

Recorded from probing the live runtime: Hermes exposes 24 endpoints and
OrcaSynapse calls 6. `memory_write_api: false` on this build, which
independently vindicates owning memory in pgvector rather than delegating it.

## ai-v1.36.2 — 2026-08-05

- record the real byte size of an uploaded document again. ai-v1.36.0 moved
  extraction ahead of the database insert, and pdf.js takes ownership of the
  typed array it is handed — the ArrayBuffer is detached once parsing succeeds,
  so `bytes.byteLength` read `0`. Every PDF uploaded since was stored as
  0 bytes. The size is now captured before the bytes are handed over
- retrieval was never affected: the buffer is detached *by* a successful
  extraction, so the text, chunks and vectors were always correct. Only the
  recorded size was wrong
- cover it with a test that fails against the previous code (`expected +0 to
  be 629`), because the defect is invisible to every assertion about content

## ai-v1.36.1 — 2026-08-05

- fix the install-time model seeding added in ai-v1.36.0, which reported
  `[WARN] The embedding model could not be downloaded now` on every run.
  `node -e` resolves imports from `[eval1]` rather than a file in the
  workspace, so the bare `@orcasynapse/knowledge` specifier was never found;
  importing the built path directly works. Caught by running the upgrade on a
  real installation rather than trusting the step to be correct

## ai-v1.36.0 — 2026-08-05

Closes the three problems the sandbox exposed after ai-v1.35.0 fixed the crash:
uploads timed out, stranded documents never recovered, and an air-gapped
install could never embed anything at all.

- **seed the embedding model during installation.** New step 4 of 7 pulls the
  approved BGE-M3 weights into the shared cache before services start.
  `embedding.ts` has always claimed "an air-gapped node must be seeded at
  install time"; nothing ever did the seeding, so an installation without
  internet could not index a single document — a direct contradiction of an
  on-prem product. Non-fatal when the host cannot reach the model source: the
  installer says so and everything except retrieval still works
- **move embedding off the upload request.** The API now extracts text
  synchronously — fast, no model, and a malformed file is still rejected while
  the caller is listening — then queues the text and returns `QUEUED`.
  Previously it loaded ~2 GB of weights and embedded inline, which exceeded
  nginx's 60-second `proxy_read_timeout`: the caller saw a 504 while the server
  quietly finished and marked the document READY
- **give ingestion a lease, so a crash no longer strands a document.** Agent
  runs have had lease reclamation for releases; documents had nothing, so any
  crash mid-ingest left the row `CONVERTING` forever with no timeout and no
  retry. The worker now claims with a 5-minute lease, reclaims expired ones,
  and fails permanently after three attempts rather than crash-looping on a
  poison document
- **drop the embedder from the API entirely.** It no longer embeds, so it no
  longer loads the model — the two processes were each holding their own ~2 GB
  copy of the same weights. The model cache volume is now worker-only
- add `Document.pendingText` as the queue payload, cleared once chunks exist,
  so the extracted text is held exactly once and no source bytes are ever
  retained — the property the audit trail asserts
- cover the new boundary: API tests own extraction and queueing, worker tests
  own embedding, reclaiming a document stranded by a dead worker, refusing one
  held by a live lease, and the retry cap

## ai-v1.35.0 — 2026-08-05

**Fixes a defect that made a fresh containerised install unusable.** Found by
building the sandbox from the public installer and actually using it: every
chat turn hung, and an uploaded PDF sat in `CONVERTING` forever.

- **give the embedding model a writable cache directory.** `LocalBgeM3Embedder`
  has always accepted a `cacheDirectory` and set `transformers.env.cacheDir`
  from it, but both call sites — `apps/worker/src/index.ts` and
  `apps/api/src/runtime.ts` — constructed it with no argument. The library then
  defaulted its cache to its own folder under `node_modules`, which every
  shipped image makes unwritable by running as `USER node`. The first embedding
  therefore failed with `EACCES` in *any* container:
  - the worker died mid-run, the 90-second lease expired, the run was reclaimed,
    and it crashed again — an endless loop that left every chat turn `RUNNING`
  - the API died mid-upload, stranding the document in `CONVERTING` with zero
    chunks and no failure recorded
  - it never showed up in tests, which run outside a container against a
    writable `node_modules`
- default the cache to `/var/tmp/orcasynapse-models`, overridable with
  `ORCASYNAPSE_MODEL_CACHE_DIR`
- mount a `model_cache` volume for both services in compose and pre-create the
  directory as `node` in both Dockerfiles, so a mounted volume does not
  reintroduce the ownership problem — and the ~2 GB of BGE-M3 weights survive a
  restart instead of being re-downloaded
- check the cache directory is writable *before* handing it to the library, so
  the failure names the directory and the environment variable rather than
  surfacing as a bare `EACCES` stack from deep inside model loading, part of
  which is not awaited and escapes as an unhandled rejection

Known and not fixed here: a document stranded in `CONVERTING` is never
reconciled. Agent runs have a lease that reclaims them; documents have no
equivalent timeout, so a crash during ingestion leaves the row pending forever.

## ai-v1.34.1 — 2026-08-05

- cover PDF ingestion end to end. Every existing document test uploaded UTF-8
  text, so the binary path — extraction through `unpdf`, then chunking,
  embedding and the pgvector write — was wired up and working but never
  exercised. A dependency bump could have broken it silently, and ai-v1.34.0
  moved three transitive dependencies. The new test builds a real two-page PDF
  in-process (reviewable bytes rather than a committed binary), uploads it
  through `DrizzleDocumentManager`, and asserts the chunks land in
  `DocumentChunk` with a 1024-dimension vector, that retrieval finds them inside
  the owner boundary and not outside it, that a text-free PDF fails with
  `OCR_PROVIDER_REQUIRED` and stores no chunks, and that bytes which are not a
  PDF fail as `EXTRACTION_FAILED`

## ai-v1.34.0 — 2026-08-05

A second sanity pass before Phase 4, this one over the backend, dependencies,
and the checks that are supposed to catch these things.

- **close four high-severity advisories in shipped dependencies.** `fast-uri`
  (GHSA-7p8r-x3mc-p8w7, host confusion via a backslash authority introducer)
  reaches the request path through Fastify's serialiser; `adm-zip` (path
  traversal) is unpacked by onnxruntime; `sharp` ships in the image through
  `@huggingface/transformers`. Pinned via pnpm overrides to `fast-uri >=4.1.2`,
  `adm-zip >=0.6.0`, `sharp >=0.35.3`
- **run `pnpm security:audit` in CI.** It has been a package script since the
  first release and was never wired into the workflow, which is why the four
  advisories above went unnoticed. Now blocking: a high in a production
  dependency is a release decision, not a warning to scroll past
- correct SECURITY.md, which still put Supermemory in the out-of-scope list and
  asked reporters not to attach Supermemory API keys — a service removed in
  ai-v1.29.0. The pgvector knowledge and agent-memory planes and their owner
  scoping are now named as in scope
- reattach the doc comment that ai-v1.32.0 stranded on `memoryLimits()` instead
  of `rememberTurn()`, and type `LoadedRun.sources` as `KnowledgeSource[]` so
  the `as never` cast at the completion write is gone — the last type escape in
  the codebase

Audited clean, for the record: all 117 route handlers are gated (scope,
principal, bearer token, node signature, or public by design); all 40 error
classes map to a status and the global handler leaks nothing; no `as any`, no
`@ts-ignore`, no stray `console.log`; local login has failure-count lockout; CI
matches local verify.

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
