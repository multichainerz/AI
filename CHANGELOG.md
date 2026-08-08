# Changelog

Every release is one commit on `main` whose subject is the version (`vX.Y.Z`),
tagged with the same name. Entries below are newest first. The `v0.x` and
`v1.x` entries each cover a phase of the early development line rather than a
single change.

## v1.7.0 — 2026-08-08

The OrcaNeuron design system, end to end: tokens, the front page, the banner
primitive, Chat, and the dead-CSS sweep that closes the arc.

- **The token sheet is the design system's.** Dark stays the default, and a
  complete light theme arrives as `[data-theme="light"]` overrides of the same
  custom properties, so every utility and every legacy rule themes without
  knowing themes exist. New semantic tokens — `onaccent`, `soft`, `node`,
  `brand` — and themed shadows.
- **Typography changed families.** Plus Jakarta Sans sets body and kickers, Space
  Grotesk draws headings and figures, both vendored as latin variable woff2
  because `font-src 'self'` forbids the CDN the design referenced. Theme
  selection is applied from the entry module before React mounts, since
  `script-src 'self'` forbids the usual inline pre-paint snippet.
- **The front page is an entrance, not a workspace.** Signed-out users see the
  violet hero and a sign-in card carrying all four ways in, instead of the
  workspace shell with locked panels. The connection drawer sheds its sign-in,
  recovery and password-change branches; a new `AdminSignInDialog` owns elevation
  from inside the shell, because the person who meets a locked screen is an
  employee whose session opens Chat but not the governed areas. Both session
  probes are awaited, so no surface flashes the wrong page.
- **`HeroBanner`** is the banner every main screen opens with, and Chat takes the
  design's three-column shape — a conversation rail led by the one action it
  exists for, and an xl-only context rail stating what the conversation can see,
  read-only by design.
- Sixty-nine dead CSS rules left `styles.css`, each proven dead by a direct
  search before deletion, because the classifier that produced the candidate list
  cannot see a template-constructed class name.

## v1.6.0 — 2026-08-08

Three rounds of multi-agent audit, then a cohesion pass and two remediation
rounds over what it found. The theme of the second half is that the first half's
fixes were correct in code and wrong at the deployment boundary — the layer no
unit test can see.

- **No dialog in the product could be typed into.** The focus-trap effect
  depended on `onClose`, which every call site passes as an inline arrow, so it
  tore down and re-ran on every keystroke. That includes the VM2 installer
  generator, so enrollment could not be completed through the dashboard at all.
- **Ten concurrent document deletes deadlocked the API permanently** — a
  transaction holding one pooled client while the chunk delete beside it checked
  out a second, with waiters that never time out.
- **`LEARN_USER` was storing the model's own answers on the default path**, and a
  CRLF stream silently truncated an answer to its first delta while reporting
  success, after which the distiller wrote memory derived from a fragment.
- **`docker compose up` would have failed outright on any host with fewer than
  four vCPUs.** Per-service `cpus:` ceilings map to NanoCPUs and the daemon
  refuses container creation rather than clamping, so compose rolled the whole
  stack back. Replaced with `cpu_shares:` weights, which have no host bound.
- **Behind an upstream TLS terminator the session cookies carried no `Secure`
  flag**, because the bundled Nginx forwarded `X-Forwarded-Proto: $scheme` while
  listening on plain 8080. The scheme is declared by the operator now and
  recorded, so key rotation cannot silently undo it.
- Also, each with a regression test: the decommissioner destroyed Hermes
  installations it did not install; the resume path had never once been executed
  and aborted every resumed install on `set -u`; `validate_state_root` accepted
  `/var/`; the gateway key sat in `curl`'s argv every five minutes; deleting a
  document mid-ingestion resurrected it; a heartbeat consumed the operator
  concurrency token; and the desired-state timer lost its state root, reporting
  success while applying nothing.
- Not everything the audit reported was true. Two findings were refuted with
  probes and are recorded as refuted, because the verification is the point.

1,127 tests across 121 files.

## v1.5.0 — 2026-08-07 – 2026-08-08

Installer smoke tests, and VM2 running Hermes under systemd with the container
gone.

- **The VM2 installer runs in a test for the first time.** Every existing
  installer test *sourced* the script and exercised functions in isolation, so
  the sequence that installs dependencies, generates an identity, enrolls, writes
  the managed policy and preseeds the toolset allowlist had never been executed
  by anything. The decommissioner and the VM1 installer get the same treatment:
  every installer path in the repository now has an executing test.
- The recovery test **could not fail**. Sourcing the installer installed its own
  `trap cleanup EXIT` over the test's, so every assertion in the file after line
  10 had been decorative. It takes the trap back, and five mutations confirm each
  class of assertion is fatal.
- **VM2 runs Hermes as a systemd service.** The strong argument for the container
  was artifact identity, and a git commit is a cryptographic digest of the tree
  that — unlike a tag — cannot be moved to different code after review. So
  `hermesImage` becomes `hermesCommit` across the contract, the schema and the
  dashboard, and the Production gate requires 40 hex characters. Migration `0025`
  drops and re-adds rather than renaming, because every existing value names a
  runtime this release no longer installs. **Any currently enrolled VM2 must be
  revoked, decommissioned and re-enrolled.**
- The unit gives more than the container did, under an unprivileged service
  account. `SystemCallFilter=` is deliberately absent: a seccomp allowlist that
  is wrong fails the service at exec rather than degrading, and it is a follow-up
  with a test rather than a line added on faith.
- **The gateway key never enters the unit file**, which is 0644 by convention. It
  comes from a 0600 environment file whose `EnvironmentFile=` carries no leading
  `-`, so a missing file fails the unit rather than opening an unauthenticated
  gateway.
- Accepted costs, stated plainly: VM2's install-time egress widens, upstream's
  hash-verified lockfile tier fails at the pinned commit and falls back to a live
  resolve, and an air-gapped VM2 install is no longer supported on this path.
- **An LTS floor.** `require_ubuntu_host` read `VERSION_ID`, checked it was
  non-empty and never compared it. Separately, CI had been running three shell
  gates on a Node it never asked for.

1,034 tests, plus both installer lifecycles.

## v1.4.0 — 2026-08-07

A CSP gate that runs in CI, the installer terminal experience rebuilt, and the
defects only a first install exposes.

- **`scripts/test-csp-closure.sh`.** The container serves `style-src 'self'` with
  no `'unsafe-inline'` while the dev server sends no CSP header at all, so a
  violation works perfectly in `pnpm dev` and fails only in the built image. The
  gate reads the built bundle and fails on a runtime-built stylesheet, an inline
  `style` attribute, an off-origin asset URL, or a stylesheet naming a font that
  is not in the image. Each class was verified to fail the check by deliberately
  introducing it.
- **The installer TUI is rebuilt** — a braille spinner, status glyphs, step dots,
  slim meters and panels that align on a column — degrading in three independent
  steps, because an installer runs over serial consoles and inside cloud-init as
  often as in a modern terminal.
- **VM2 now arrives governed instead of converging later.** The installer wrote
  the desired-state reconcile timer and never ran it, so a freshly enrolled node
  sat on the tool-free baseline until the first tick, with no way for the
  operator watching to tell "not yet" from "not working".
- **VM2 declares the dependency its reconciler has always had.** The generated
  reconcile script uses a `python3` block that the installer never installed and
  never checked for; the required-command list now covers what the *generated*
  scripts run, not only what the installer itself calls.
- **The change-password screen signed the operator out while they were on it.**
  The 15-second session reconciler is gated on `unlocked`, which a forced
  password change makes false — so the one screen that asks someone to open a
  password vault was the only screen that never touched its session. A keepalive
  runs while the change is pending, and the route now tells an expired session
  apart from a wrong password.
- **The VM2 installer generator rendered as unstyled HTML**, the one file the
  design-system migration missed; both modals are rebuilt on `Drawer` and
  `Dialog`, which supply the focus trap and Escape handling the hand-rolled
  backdrop never had.
- **Two fixed costs removed from every chat message**: the worker is woken by a
  `NOTIFY` emitted inside the inserting transaction rather than by a one-second
  tick, and the embedding model is warmed at startup rather than inside the first
  message after a restart.
- `docs/CURRENT_STATE_HANDOFF.md` was materially wrong about the baseline, the
  test count, and whether `main` was pushed — the last of which matters, because
  an unpushed release is invisible to every install.

## v1.3.0 — 2026-08-07

Benchmarks, R1 through R5: the loop from authoring a suite to filing its result
as the evidence a promotion is gated on.

- **It does not duplicate the evaluation ledger, it feeds it.** `EvaluationRun`
  is a record an operator types in from a run they did somewhere else; a
  benchmark executes and produces those numbers, so the figure a release is
  approved on is not one anybody could have mistyped in its favour.
- **Three kinds, because the planes fail independently**: `CHAT_QUALITY`,
  `RETRIEVAL` and `MEMORY` break for different reasons, and one "is the AI good"
  number would hide which.
- **Nothing is judged by a model.** Every assertion is a plain string or latency
  comparison and each verdict is stored beside its case, which is what makes a
  deterministic score auditable rather than merely reproducible.
  `MUST_NOT_INCLUDE` is the only kind that states something an answer may never
  do, so breaking one is a critical failure whatever the pass rate says.
- **A chat case goes through the real agent path** — the same queue, profile
  version, retrieval and boundary checks a person's message goes through — and a
  benchmark **never writes to agent memory**, or the second run of a suite would
  score differently because of the first.
- Results are written after each case, so a suite that dies at case thirty still
  shows what the first twenty-nine answered; cancellation is checked between
  cases. `0023` and `0024` add the run's owner and the lease the document
  ingestor already had.
- **The screen states what a run means, not what its status enum says**: a
  completed suite that scored 0.5 against a 0.9 threshold reads *below
  threshold*. It polls only while something is running, and an auditor can read
  every result and start none of them.
- A suite can be authored, edited and deleted from the dashboard. Slug and kind
  are fixed once it exists, because past runs are filed under the slug and pinned
  to what the kind measures.

## v1.2.0 — 2026-08-07

The design system reaches every remaining view, preflight comes on, and the
fonts finally ship.

- Models, Prompts, Guardrails, Memory, Knowledge, the audit trail, Agents,
  Operations, Onboarding and Tooling all move onto the primitive set, each
  verified against a rendered preview rather than a diff, and each gaining its
  first tests in the process.
- **Two ways the system was quietly producing nothing.** The base reset wrote
  `border: 0`, which also sets `border-style: none`, and CSS then computes
  `border-width` to 0 whatever a later rule declares — so Tailwind's width-only
  `border` utility painted nothing on *every element*. And every opacity modifier
  on a theme colour emitted no rule at all, because Tailwind cannot decompose a
  hex held in a custom property: twenty-five tinted backgrounds and borders were
  missing that way, the class sitting in the markup with no declaration behind
  it. The palette is channel-first now.
- **Preflight is on**, which supersedes the hand-written universal
  `border-style: solid` that had been standing in for it, and the token test
  fails if it is ever switched back off.
- **Ship the fonts.** `--sans` had named Inter for fourteen releases with no
  `@font-face` behind it, so every screen fell through to whatever the operating
  system supplied. Inter and JetBrains Mono are now self-hosted latin variable
  cuts, because `font-src 'self'` makes a bundled file the only legal option, and
  `ui/fonts.test.ts` fails if a declared face has no file.
- The twelve-branch view ternary becomes a lookup keyed by the token the router
  already produces, with `satisfies Record<ActiveView, …>` closing the set — the
  chain had ended in a bare `else` that rendered Home, so a new view fell
  silently through to the wrong screen.
- The connection drawer stops carrying its own copy of the focus trap that
  `Drawer` was extracted from. The stylesheet ends the arc at **700 lines
  carrying 166 distinct colours**, from 2,020 lines and 754.

## v1.1.0 — 2026-08-07

A design system for the dashboard: tokens, primitives, Home, Chat, and one
locked screen instead of nine.

- `styles.css` carried **754 distinct hand-picked colours across 989 uses**, and
  there were no shared components at all — twelve views inlined every button,
  tile, card and modal, producing nine hand-written locked screens and five modal
  implementations of which one trapped focus.
- Tailwind 3 arrives with the tokens as CSS custom properties, so the stylesheet
  and the utility classes share one palette while views migrate a release at a
  time, alongside the primitive set in `apps/web/src/ui/`.
- **No Radix, and not by preference.** `style-src 'self'` refuses the inline
  positioning styles its Popper primitives write and the `<style>` element
  `react-remove-scroll` injects — and the dev server sends no CSP header, so both
  would have worked perfectly in `pnpm dev` and broken only in a built container.
  A metric's bar is a real `<progress>` for the same reason.
- **The design system had been deleting its own classes since the day it
  shipped.** tailwind-merge's colour matcher accepts any `text-` class, so every
  custom size was read as a colour and dropped by the colour beside it: the whole
  type scale was inert everywhere, with the class simply absent from the DOM and
  nothing logged. The dependency was also on the line built for Tailwind 4
  semantics, which was silently removing `focus-visible:outline` — no button in
  the dashboard had a focus ring.
- **Nine locked screens become one.** A person who lost their session saw nine
  slightly different explanations of the same thing, across three marks, five
  button labels and four layouts. Not every locked area wants an administrator,
  so the primitive states what the area actually needs.
- Chat's four dialogs were never dialogs — `role="dialog"` with no `aria-modal`,
  focus trap, Escape, scroll lock or focus restore — and the conversation menu,
  which holds Archive and Delete, had no way out at all. The transcript follows,
  with a preview harness that writes its rendered markup to a file so 200 lines
  of intricate CSS could be looked at rather than reasoned about.
- Memory's lineage reaches the screen. `records()` had **no lifecycle predicate
  at all**, so a corrected fact, a forgotten one and the current one were all
  returned together and rendered identically — an operator auditing what an agent
  knows was reading a mixture of current belief and everything it had ever been
  told.
- Back also works: navigation had written every route with `replaceState`.

## v1.0.0 — 2026-08-06 – 2026-08-07

Conversation-level distillation, forget-by-topic, a memory metric that names the
failing mechanism, and streaming inference.

- **Distil a conversation once it goes quiet, instead of after every turn.**
  Per-turn capture reads one message at a time and cannot resolve an arc — "I am
  moving to Bandung next month" and a later "the move is done" become two facts
  that contradict each other. Capture now waits ten minutes of quiet and reads
  the whole session in one call, stamping the conversation as read *before*
  distilling so a crash cannot loop on it, and rewinding that stamp when the
  model was unreachable.
- The migration that added the stamp defaulted it to null, which made every
  conversation ever held look like it owed a distillation; a follow-up marks the
  already-idle ones as read, so distillation starts from now rather than
  harvesting the archive.
- **"Forget everything about Project Titan", previewed before it happens.**
  Neither a `LIKE` nor a similarity floor answers a topic, so the owner's live
  facts are shown to the model against it. `dryRun` defaults to true, the blast
  radius is bounded, and a partial scan is reported as partial rather than
  presented as complete.
- **A memory number that says which mechanism is failing.** Six cases across five
  question types, each drawn from a failure that actually happened, scored by a
  judge that reads anything short of an unambiguous PASS as a failure. A case
  that could not be run is kept out of the score entirely, because counting it
  either way reports something untrue.
- The metric did its job on the day it shipped: "always answer me in Indonesian
  from now on" had never been captured at all, because two rules in the
  extraction instruction contradicted each other and a small model applied the
  prohibition.
- **Stream the inference calls, because some transports will not carry them
  otherwise.** A free tunnel kills any request whose origin takes longer than
  about 100 seconds; measured on the pilot, non-streaming returned 524 after 125s
  where streaming returned 200 after 400s.
- **Read the answer the model actually sends.** The same model on a different
  serving stack renames the fields — `type` for `scope`, a quoted sentence where
  an index was asked for — so on that stack every fact fell to the `EPISODIC`
  fallback and no correction was ever applied. Nothing would have looked broken.

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
