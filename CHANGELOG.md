# Changelog

Every release is one commit on `main` whose subject is the version (`ai-vX.Y.Z`),
tagged with the same name. Entries below are newest first. Releases before
ai-v1.25.0 predate this file and are backfilled from the commit bodies; releases
before ai-v1.19.0 are summarized per series.

## ai-v1.79.0 — 2026-08-07

Two fixed costs removed from every chat message.

Chatting through the dashboard felt slow while the same model answered quickly
in LM Studio. The model was never the problem — a 2.6B answering in 1–5s was
sitting behind a queue tick, two CPU embeddings, two network hops and a polling
reader. This release takes out the two that are pure waste.

**The worker no longer waits for its own timer.** A run was found by a
one-second reconcile tick, so every message on a completely idle installation
paid up to a full second before any work began. The API now emits `NOTIFY` in
the same transaction that inserts the run, and the worker holds a dedicated
connection listening for it.

Emitted *inside* the transaction deliberately: PostgreSQL defers NOTIFY until
commit, so the worker can never be woken for a run it cannot yet see — which a
nudge sent after committing would not guarantee. There is a test for exactly
that, using a rollback.

The timer is untouched and remains the guarantee. `pg` pools multiplex, so the
listener takes a connection of its own; if PostgreSQL will not give it one, or
it drops and cannot reconnect, the worker keeps running precisely as before — a
second slower, never broken. A lost notification costs a second, never a run.

**The embedding model is loaded at startup rather than inside the first
message.** `LocalBgeM3Embedder` resolves its pipeline lazily and nothing touched
it until a question needed one, so the first person to type anything after a
worker restart waited for ~2 GB of weights to load before their message reached
Hermes at all. The worker now warms it as soon as it starts, off the critical
path.

**What this does not fix, and where the remaining time goes.** A dashboard
message still crosses seven processes against LM Studio's one. The two largest
remaining costs are structural: the browser does not receive a stream — the API
polls `AgentRunEvent` every 350 ms and forwards what it finds, so tokens arrive
in clumps regardless of generation speed — and every delta is four SQL
statements in a transaction. Both are worth changing; neither is a change to
make without measuring first, since the delta write is what makes an
interrupted run resumable.

1,034 tests green, 6 new. The wake channel's four run against a real PostgreSQL,
because every property that matters is the server's: that NOTIFY is held until
commit, that a pooled connection would lose the subscription, and that a stopped
listener stays stopped.

## ai-v1.78.0 — 2026-08-07

Two bugs in the first ten minutes of a new installation.

**The change-password screen signed the operator out while they were on it.**
`passwordChangeRequired` makes `unlocked` false, and the 15-second reconciler
that keeps every other screen's session alive is gated on `unlocked`. So the one
screen that asks an operator to open a password vault, generate a passphrase and
type it three times was the only screen that never touched its session — while
the server's 15-minute idle window ran. Submitting then failed, and the message
was *"the password could not be changed with the supplied credentials"*, which
reads as a wrong password. Signing in again with the same correct temporary
password restarted the same fifteen minutes, which is why it kept happening.

A keepalive now re-reads `GET /admin/session` every four minutes while the
password change is pending. That endpoint needs no scope, so it works in exactly
this state, and re-reading the principal means an expiry that does happen
surfaces on the screen rather than at submit.

The route also tells the two refusals apart now. An expired session answers
`SESSION_EXPIRED` — *"sign in again to set a new password"* — and a live session
that fails answers *"the current password is incorrect"*, which is the only case
where that sentence is true. Checking the session first also slides its idle
window, so a submit arriving inside the window can no longer be refused for
staleness.

**The VM2 installer generator rendered as unstyled HTML.**
`runtime-nodes-panel.tsx` was the one file the design-system migration missed —
verified: every other view imports the primitives, this one imported none. Its
layout lived in `.setup-evidence-editor` and `.setup-empty`, both deleted when
`styles.css` was cut from 2,020 lines to 700, and nothing caught it because the
file had no test of any kind. That single missing class explains every symptom:
no max-width, so the panel spanned the viewport; no header flex, so the close
control dropped onto its own line; no label grid, so *"VM2 private address"*
collided with its own input; no padding, so the hint ran off the edge.

Both modals are rebuilt on `Drawer` and `Dialog`, which supply the width,
padding and header layout the deleted rule used to — plus the focus trap,
Escape handling and scroll lock the hand-rolled backdrop never had. The two
empty states become `EmptyState`; one of them is the first thing a fresh
installation shows. Labels now carry the `<span>` that `.ops-form` styles, and
field hints get a size of their own instead of inheriting the panel's.

The panel gains its first tests — seven — including one asserting the dialog
closes on Escape, which it could not do before.

1,028 tests green. Every gate passes: release consistency, docker build closure,
CSP closure, installer UI sync, and `bash -n` across the installer family.

## ai-v1.77.0 — 2026-08-07

VM2 declares the dependency its reconciler has always had.

`hermes-desired-state.sh` — the script the installer writes to
`/usr/local/lib/orcasynapse` and runs on a five-minute timer — reconciles the
toolset allowlist with a `python3` block. The installer never installed python3
and never checked for it. It installed `ca-certificates curl jq openssl
docker.io` and verified fifteen commands, none of them the one its own generated
script depends on.

Ubuntu Server ships python3, which is exactly why this went unnoticed: it is not
in Ubuntu's essential set, so a minimal image can lack it, and the failure mode
is the quiet kind. The node enrolls, Hermes starts, the dashboard reports
Healthy — and the runtime silently never applies a toolset an operator admitted,
visible only in `journalctl`. ai-v1.76.0 made it louder by reconciling during
installation, where the failure at least prints a warning. This makes it
impossible instead.

python3 is now installed and verified, and the required-command list covers
everything the *generated* scripts run too — `base64`, `cmp`, `tr`, `paste` —
not only what the installer itself calls. That second group is the one worth
checking: it fails on a timer, hours after anyone is watching.

The VM1 installer was audited for the same class and is clean; it uses nothing
beyond coreutils and the three packages it installs.

1,024 tests green; installer syntax, UI-region sync, release consistency, docker
build closure and CSP closure all pass.

## ai-v1.76.0 — 2026-08-07

The installer terminal experience, and a VM2 that arrives governed.

**The TUI is rebuilt.** Bracketed ASCII (`[ OK ]`, `[####....]`, `+====+`) is
replaced by a considered terminal design: a braille spinner, `✓ ▲ ✗ ›` status
glyphs, step dots that show position at a glance, slim meters whose lit portion
is the accent and whose remainder is a faint rule of the same length, thin
full-width rules, and panels that align on a column instead of drawing a box.
The wordmark is unchanged but now renders in four shades of the role accent —
the same figlet, no longer reading as a 1990s shell script.

**It degrades in three independent steps, because an installer runs over serial
consoles and inside cloud-init as often as in a modern terminal.** Colour drops
without a TTY or under `NO_COLOR`; box drawing falls back to ASCII when the
locale is not UTF-8, since a latin-1 console renders mojibake for every rule and
that looks far worse than the dashes it replaced; animation collapses to one
static line when there is nothing to animate on. Each mode aligns within itself
— one column per glyph in UTF-8, two in ASCII — because nobody ever sees both.
Panels track the terminal width, clamped to 64–96: narrower and the two-column
rows collide, wider and a full rule reads as a horizon rather than a container.

**VM2 now arrives governed instead of converging later.** The installer wrote
the desired-state reconcile timer but never ran it, so a freshly enrolled node
sat on the tool-free baseline until the first tick — up to five minutes in which
the runtime did not match what the dashboard said it admitted, and the operator
watching had no way to distinguish "not yet" from "not working". It reconciles
once before finishing, waits for the runtime to settle, and names the admitted
toolsets in its completion panel. A failure there is not fatal: the timer
retries, and the control plane refuses runs against a runtime whose toolsets it
has not confirmed, so the node is never wrongly permissive in the meantime.

The reconciler now records what it applied to `admitted-toolsets` on the host,
so "OrcaSynapse never answered" and "OrcaSynapse answered none" are legible as
the different facts they are — an empty allowlist is a real instruction.

Both completion panels are rebuilt on the new primitives, and VM2's now states
the runtime image, the model route and the admitted toolsets rather than only an
API address and a fingerprint. The Installation Key still prints through
`ui_panel_line`, which writes to no log — the only reason a secret may pass
through a UI helper at all.

Also fixed: `step()` ended each row with `(( index < total )) && printf ' '`,
and a false arithmetic test is a failing command — as the last statement in the
loop body it would have tripped the caller's `set -e` on the final dot of every
step. It is an `if` now.

Corrects the handoff document, which still said VM2 does not consume the signed
desired-state document. It has since ai-v1.42.0.

1,024 tests green, and every installer gate passes: UI-region sync, release
consistency, docker build closure, CSP closure, and `bash -n` across the family.

## ai-v1.75.0 — 2026-08-07

Deployment readiness: a CSP gate that runs in CI, and documentation that is true again.

**`scripts/test-csp-closure.sh` closes the gap the plan flagged as unfixable in
development.** The container serves `style-src 'self'` with no `'unsafe-inline'`;
the dev server sends no CSP header at all. So a violation works perfectly in
`pnpm dev` and fails only in the built image, on the pilot, in front of whoever
is looking at it. That is how Radix was ruled out, and until now nothing kept
the decision enforced after everyone who made it had moved on.

The gate reads `apps/web/dist` and fails on four things: a bundle that builds a
`<style>` element or edits a sheet at runtime; an inline `style` attribute in the
served HTML; an off-origin asset URL, which `font-src` / `img-src 'self'` refuse;
and a stylesheet naming a font file that is not in the image. **Each class was
verified to fail the check by deliberately introducing it**, because a guard
nobody has watched fail is not a guard. Wired into CI after the build.

The fourth check earns its place on its own: a missing font breaks no build and
throws no error — the page silently renders in something else, which is how
`@font-face` went fourteen releases naming Inter and shipping nothing.

**`docs/CURRENT_STATE_HANDOFF.md` was materially wrong.** It claimed baseline
ai-v1.44.0, 720 tests, and `main` synchronized with `origin/main` — the last of
which mattered, because nineteen releases had accumulated locally while
`install.sh` builds from a GitHub tarball of `main`. An unpushed release is
invisible to every install, so the doc now says to check
`git log --oneline origin/main..main` before trusting a deployment to be
testing your work, and spells out how a deployment obtains its code at all.

**New: `docs/BENCHMARK_RUNBOOK.md`**, covering what each kind measures and what
makes it refuse to start, how to write checks that fail for the right reason,
what a run pins and what survives a restart, and how a completed run becomes the
evidence a promotion is gated on. Indexed from the README beside the other
runbooks, with a benchmarks section added to `docs/ARCHITECTURE.md`.

1,024 tests green. Every gate CI runs that can run on Windows passes: `verify`,
`verify:postgres`, `security:audit`, installer syntax, and the four static
guards. The three installer shell tests remain Linux-only and are unverified
locally — noted in the handoff rather than left to be discovered.

## ai-v1.74.0 — 2026-08-07

Benchmarks, R5: authoring a suite from the dashboard. The loop is closed.

A suite can now be written, edited and deleted from the Benchmarks screen —
which was the last thing the API could do and the screen could not. Author,
run, read, file as evidence: the whole path is in the product.

**A new suite starts with a case that already has a check.** A case with no
assertions passes by doing nothing, so the empty state is never that shape.

**Two cases cannot be saved sharing an id**, and the screen says why rather than
waiting for the server to: the id names a row in the results, so a reused one
hides a regression in the second case entirely. A latency check switches its
field to a number input, because the contract refuses anything else and a text
box invites the mistake.

**Slug and kind are fixed once a suite exists.** Past runs are filed under the
slug and pinned to what the kind measures; changing either would silently
redefine what an old result meant. The editor states that on the field rather
than just disabling it.

Editing sends the revision the drawer was opened at, so two operators cannot
overwrite each other. Deleting asks first and says what it takes with it — the
server has the final word, and keeps any suite whose result an evaluation cites.

1,024 tests green, 9 new. Contrast on the editor sweeps at 0 nodes below WCAG
AA, worst 5.30, median 7.36.

*Noted while testing:* the `Field` primitive renders its hint inside the
`<label>`, so a hinted field's accessible name is "Slug Fixed: past runs are
filed under it." rather than "Slug" — verbose for a screen reader and unmatchable
by voice control. It belongs in `aria-describedby`. Left alone here because
`Field` backs every form in the dashboard and that is not a benchmarks change;
the tests match hinted fields by leading text until it is fixed.

## ai-v1.73.0 — 2026-08-07

Benchmarks, R4: a completed run files itself into the evaluation ledger.

This is what the two systems were kept separate for. `EvaluationRun` gates
promotion on how many cases passed — a number an operator has, until now, typed
in from a run they did somewhere else. A benchmark measures that number. Now it
carries it across, and the figure a release is approved on is not one anybody
could have mistyped in its favour.

**Only what is being decided is typed.** The form asks which release this gates,
which required category the run answers for, and what bar it must clear. The
case counts are read off the run and `attachBenchmarkEvidenceSchema` is
`.strict()` with no field for them, so there is no path by which they could be
supplied by hand.

**The gate claims exactly what the run measured, and nothing else.** The
evaluation requires one category — the one this benchmark exercised. Filing a
chat benchmark as evidence about tool use or permissions would make a gate look
stronger while being weaker, and a narrow claim is the one that can be honoured.

**A broken prohibition is a critical failure.** The ledger separates critical
failures from ordinary ones, and a benchmark has exactly one signal for that
distinction: `MUST_NOT_INCLUDE` is the only assertion kind that states something
an answer may never do. "Did not mention the rollback step" is a shortfall;
"named the other tenant" is not — and one of those fails the gate whatever the
pass rate says.

Only a **completed** run can be filed, and only once. A run that was stopped,
refused or is still going has measured part of a suite, and part of a suite is
not evidence about the suite.

Also fixed while testing the permission split: the **Results** button was inside
the manage guard, so an auditor could not open a result at all. Reading the
evidence is what `evaluations:read` is for — an auditor who cannot see a result
cannot audit the decision made on it. Only starting, stopping and filing are
gated now.

1,015 tests green, 16 new. Contrast on the evidence form sweeps at 0 nodes below
WCAG AA, worst 4.95, median 7.25, form fields included.

**Still to come:** authoring a suite from the dashboard. The API and the client
call both exist; the screen currently points an operator at the API for it.

## ai-v1.72.0 — 2026-08-07

Benchmarks, R3: the dashboard screen. The feature is complete.

A **Benchmarks** section under Operations, filed there deliberately — a
benchmark run is the evidence an evaluation is promoted on, so it belongs beside
the ledger it feeds rather than in its own corner of the product.

**The screen states what a run means, not what its status enum says.** A
completed suite that scored 0.5 against a 0.9 threshold reads *below threshold*,
not *completed*: the second is true and tells an operator nothing, and a neutral
word beside a red dot is exactly the misreading this screen exists to prevent.
The summary counts regressions for the same reason. Every card names what its
suite exercises, because the three planes fail for different reasons and "chat
quality" and "retrieval" are not interchangeable news.

**A run in flight shows how far it got and no score.** Cases scored out of
total, live — the runner publishes after each case, so there is something honest
to show — and the pass rate stays blank until it finishes.

The screen polls only while something is running, and stops the moment nothing
is. A benchmark page left open on a quiet installation should not keep a query
running against the same database the agents use.

The results overlay names **what the run was pointed at**: model, agent and
version, and whose corpus. Each case carries the intent it was written for, so a
failure explains itself instead of leaving someone to reconstruct why the case
exists — and each assertion shows its own verdict, which is what makes a
deterministic score auditable rather than merely reproducible.

An auditor sees all of it and can start none of it: reading the evidence and
commissioning it are different permissions, which is why the API reused
`evaluations:read` and `evaluations:manage` rather than inventing a scope.

1,002 tests green, 11 new. Contrast on the new screen sweeps at **0 nodes below
WCAG AA, worst 4.95, median 6.52** — better than the 4.78/6.13 baseline. No
inline styles, so the container's `style-src 'self'` will not refuse it.

## ai-v1.71.0 — 2026-08-07

Benchmarks, R2b: the worker executes them.

A queued run is now claimed, executed against the live stack, scored and
recorded. The pipeline is end to end for the first time — everything except the
dashboard section that starts one.

**A chat case goes through the real agent path.** It queues an ordinary
`AgentRun` and the processor in the same worker picks it up: the same queue, the
same profile version, the same retrieval, boundary and capability checks a
person's message goes through, and its turn behind whatever else is running.
Nothing about it is a simulation, which is the only way the score says anything
about what the installation will actually do. A retrieval case is scored on the
passages themselves rather than on an answer written from them, because the
question is whether the right document came back — something a generated answer
can obscure in both directions.

**A benchmark never writes to agent memory.** Recall is measured; capture is
not. The runs it queues carry `memory:agent:read` when the profile allows it and
never `memory:agent:write`, because a benchmark that captured facts would change
the thing it measures — the second run of a suite would score differently
because of the first. Each case also gets its own session and no history, or a
suite silently measures whether case 7 primed case 8.

**Every scoring rule is a string or a number comparison**, matched on substrings
so a reworded answer still passes: an exact-match benchmark fails on every
rewording and teaches an operator to ignore it. A case that could not be
executed fails every assertion rather than none — otherwise `MUST_NOT_INCLUDE`
passes on an empty answer and an unreachable model scores as a clean run. An
unmeasured latency is not a fast one.

**Results are written after each case, not at the end**, so a suite that dies at
case thirty still shows what the first twenty-nine answered, and a crash costs
the remaining cases rather than all of them. Cancellation is checked between
cases too — a suite is minutes of inference and an operator who pressed stop
should not have to wait it out.

`0024_benchmark_lease` adds the lease the document ingestor already had, for the
same reason: "still going" and "the process running it is gone" are otherwise
indistinguishable, and the second has no way out but hand-written SQL. Claiming
uses `FOR UPDATE SKIP LOCKED`, because two workers reading the same queued row
would both execute the suite and the second result would overwrite the first.

A run whose suite was edited while it waited is refused rather than executed:
filing the new questions under the old revision number is the one thing the
revision exists to prevent. A refused run resets its counts, so it never reads
as a suite that scored zero.

One more contract tightening: a `MAX_LATENCY_MS` bound must be a whole number of
milliseconds. A non-numeric one can never hold, so the case it guards would fail
every run for a reason no result explains — refused at authoring time, where the
person who typed it is still looking.

991 tests green, 30 new.

## ai-v1.70.0 — 2026-08-07

Benchmarks, R2a: suites and runs actually persist.

R1 shipped the contract, the tables and the HTTP surface, but no implementation
behind them — the routes answered `423` for want of a manager. This is that
manager, so a suite can be authored and a run can be queued for the worker to
find.

**A revision moves only when what the suite executes moves.** The revision
exists so a run can name the document it scored, so it bumps when the cases or
the pass threshold change and deliberately does not bump when a suite is
renamed or its description corrected. Those change nothing about a result, and
bumping would invalidate a run already queued against the very same questions.

**A suite whose result was relied on is not deleted.** Run rows cascade from
the suite, which is right for one authored by mistake and badly wrong for one
whose score a promotion cited. So deletion is refused while any run is attached
to an evaluation, and refused while a run is still going — the row the worker
is mid-way through writing. Everything else deletes, because that is what the
operator asked for.

**Every refusal to queue answers the same question: is there something to
score?** No active agent, an agent that is not active, nothing indexed to
retrieve from — each is a setup problem an operator fixes, and each is a `409`
in front of them now rather than a completed run at 0% that enters the history
as a regression the model never caused. Several agents active is also a refusal:
naming which one a run measures is the operator's call, and a result whose
subject was chosen by a coin toss cannot be compared with the next one.

**A run records whose corpus it measured** (`0023_benchmark_owner`). Retrieval
and recall are owner-scoped, so the same suite run by two operators searches two
different sets of documents and is entitled to two different scores. Without the
owner on the run, that difference reads as a regression. The same migration
widens `modelAlias` to 200 to match `AgentProfileVersion.modelAlias`, the column
it copies — at 120 a long alias would have failed the insert, and an alias that
is always present is the whole point of denormalising it.

A retrieval run records the **embedding** model rather than a chat model, since
retrieval scores move when the vectors change.

Two contract tightenings found while implementing: two cases may no longer share
an id, because the id names a row in the results table and a reused one makes a
regression in the second case invisible; and one run of a suite at a time,
because a second against the same target is the same questions to the same model
and only makes both slower.

961 tests green, 20 new. The 19 manager cases run against a real PostgreSQL —
the cascade, the unique index and the three check constraints live in the
database, and a fake would prove none of them.

## ai-v1.69.0 — 2026-08-07

Benchmarks, R1: contract, schema and API.

The thing that has been missing is a way to ask *"does this installation still
answer well"* from the dashboard rather than by hand. This is the foundation
for it — a suite of deterministic checks that can be executed against the live
stack, on a schedule an operator controls.

**It does not duplicate the evaluation ledger, it feeds it.** The existing
`EvaluationRun` in `ai-ops.ts` is a *record*: an operator types in how many
cases passed somewhere else, and promotion gates a release on that evidence.
This one *executes* and produces those numbers. A completed run is therefore
the natural evidence for an evaluation, which is why `evaluationRunId` sits on
the run rather than the two systems being merged. For the same reason a
benchmark reuses `evaluations:read` / `evaluations:manage`: running one **is**
evaluation work, so no role needs a new grant.

**Three kinds, because the planes fail independently.** `CHAT_QUALITY`,
`RETRIEVAL` and `MEMORY` break for different reasons — retrieval degrades when
an embedding model or relevance floor changes, chat when a prompt, profile or
model route changes, memory when distillation or supersession misbehaves. One
"is the AI good" number would hide which.

**Nothing is judged by a model.** Every assertion is a plain string or latency
comparison, and each one's verdict is stored beside the case. A benchmark whose
scoring cannot be audited cannot be used to argue a release is safe.
`MUST_NOT_INCLUDE` earns its place here: *"must not leak the other tenant's
project name"* is exactly the regression a pass rate alone never surfaces.

Decisions worth naming, each enforced in the database rather than in code:

- **a run in flight has no pass rate.** A partial score rendered beside
  finished runs reads as a final one, and an operator would compare it to the
  threshold. Constraint, contract refinement and test.
- **the target is denormalised onto the run.** The same suite scoring 0.94 then
  0.71 says nothing until you know the model alias changed underneath, and a
  foreign key would let a profile edit silently rewrite what a past result meant.
- **a run with nothing to measure is refused, not queued.** With no active
  Profile, queuing anyway produces a 0% result that enters the history as a
  regression the model never caused — so the API answers 409, not 202.
- **starting a run answers 202.** Forty cases against a governed agent is
  minutes of inference; holding the connection open would tie the outcome to a
  browser tab staying open.
- results carry prompts and answer excerpts, so both run endpoints send
  `cache-control: no-store`

Migration `0022_benchmarks` adds `BenchmarkSuite` and `BenchmarkRun`, verified
against a real PostgreSQL rather than only `drizzle-kit check`.

941 tests green: 12 contract cases and 11 route cases new.

**Still to come:** the worker that claims a queued run and executes it, and the
dashboard section that starts one and reads the results. This release is the
contract and the surface they will both build on.

## ai-v1.68.0 — 2026-08-07

Ship the fonts. The product has never rendered in the typeface it names.

`--sans` has said `Inter` since ai-v1.54.0 with no `@font-face` behind it, so
every screen fell through to whatever the operating system supplied — Segoe UI
on Windows. Both families are now self-hosted, because `font-src 'self'` makes
a bundled file the only legal option.

- **Inter** for text and **JetBrains Mono** for everything mono, both SIL
  OFL-1.1, both the **latin variable** cut only: one file each covering weight
  100–900, 48 KB and 40 KB. Sourced from
  `@fontsource-variable/{inter,jetbrains-mono}@5.3.0`, which stay in
  devDependencies as provenance — they are how the two files are regenerated,
  not how they are served.
- Fontsource's own stylesheet is deliberately not imported: it carries cyrillic,
  greek and vietnamese behind `unicode-range`, and while a browser would never
  fetch them, Vite emits every one into the image.
- Mono is load-bearing rather than decorative here. Every micro-label, figure
  and identifier is set in it, and its tabular numerals are what stop a column
  of values shifting as it updates.
- `font-display: swap`: on a control plane, readable-now beats
  invisible-then-perfect, especially for someone mid-diagnosis.

Verified in the browser rather than trusting `document.fonts.check`, which
answers for the *named* face and not for what actually draws: both files were
served from this origin, and canvas metrics for the same string differ from
their fallbacks — Inter 189.59px vs Segoe UI 173.38px, JetBrains Mono 167.40px
vs Consolas 153.40px. Contrast unchanged at 0 nodes below WCAG AA.

`ui/fonts.test.ts` closes the gap that let this sit unnoticed for fourteen
releases: a font is the one asset referenced by URL rather than by import, so
nothing in the build fails when the file is missing — the page just quietly
renders in something else. It now fails if a declared `@font-face` has no file,
if a bundled family is not first in the stack that uses it, or if `swap` is
dropped.

923 tests green, web at 164.

## ai-v1.67.0 — 2026-08-07

The view ternary becomes a lookup, which was deferred on a condition that is now
met.

ai-v1.55.1 left this alone and said why: *"It is a readability change to 120
lines of prop-passing across views that mostly have no render test, where a
silently dropped prop would not be caught. It belongs with the release that
gives those views their tests, not before."* Every one of those views has tests
now — Home, Chat, Agents, Operations, Models, Prompts, Guardrails, Knowledge,
Memory and the audit trail — so the condition holds and the change is safe to
make.

The twelve-branch nested ternary in `app.tsx` is one entry per view, keyed by
the token the router already produces, with `satisfies Record<ActiveView, () =>
ReactNode>`. That is the point rather than the tidiness: **the set is now
closed.** The chain ended in a bare `else` that rendered Home, so a view added
to `ActiveView` without a branch fell silently through to the wrong screen.

Proven rather than asserted: removing one entry produces two compile errors —
the index expression and the `satisfies` constraint both reject it.

Verified in the browser, since this is the router: all twelve routes resolve to
their own view, the active nav item follows, and Back still walks the history
(`#home` → `#operations` → `#platform/setup`).

920 tests green.

## ai-v1.66.0 — 2026-08-07

The connection drawer and the runtime-nodes panel — the revamp is complete.

The drawer had its own focus trap, and it was the *original*: `Drawer` was
extracted from this exact implementation in ai-v1.54.0 and the copy here was
never removed, which meant two places to fix when one of them was wrong. The
shell is now the primitive, so the trap, Escape, scroll lock and focus restore
have one implementation in the product rather than two.

The four legacy button classes are restated as the Button variants they should
always have matched. The drawer and the nodes panel still apply them by name,
and a saturated purple `.primary-button` with white text sitting beside the
design system's accent-with-dark-text was the last thing making a screen look
like a different product.

Verified in the running dashboard: the drawer opens with `aria-modal="true"`
and body scroll locked, Escape closes it, and scroll lock releases.

**Where the revamp ends.** The plan opened by measuring the problem: *2,020
lines carrying 754 distinct hand-picked colours, no shared components at all,
nine hand-written locked screens, five modal implementations of which one
trapped focus.*

- `apps/web/src/styles.css` is **700 lines carrying 166 distinct colours**
- every screen builds from one primitive set; there is one locked screen, and
  every overlay in the product goes through `Dialog` or `Drawer`
- **161 web tests**, up from 86 — Home, Chat's transcript, Agents, Operations,
  Models, Prompts, Guardrails, Knowledge and the audit trail each had none
- preflight is on, the migration alias tokens are gone, and `ui/tokens.test.ts`
  guards the three ways a token can silently produce nothing

920 tests green.

Not done, and needing your decision rather than more work: **Inter is still not
shipped.** `--sans` names it, no `@font-face` exists, and the product renders in
whatever the OS supplies — Segoe UI on Windows. `font-src 'self'` forbids a CDN,
so the fix is a `.woff2` committed to the repository, and that is a call about
what goes in the tree rather than a styling decision.

## ai-v1.65.0 — 2026-08-07

The last three views, and preflight on.

Tooling, Onboarding and Operations move onto the design system, which leaves
every screen in the product built from the same primitives.

**Tooling** is the governed MCP plane, so the states that matter are the ones
that refuse things. The gateway says ON or OFF in words — OFF means every call
is denied fail-closed, not that a feature is idle. Drift is the alarm: a toolset
the runtime enabled but nobody admitted turns its row red, because every run is
being refused until the two agree. A one-time credential is warn-toned rather
than celebratory, since navigating away loses it. Approval requests keep their
arguments verbatim, because a summary of them would be the operator approving
something else. And the honest boundary — Hermes is zero-tool by default —
stays where someone configuring grants will read it.

**Onboarding**'s two remaining hand-rolled modals become real dialogs. One of
them takes a recovery passphrase that is never retained anywhere, so losing
focus out of it mid-entry is not a recoverable mistake. Its activation panel
lists blockers by name: "3 blockers remain" is a dead end, the names are a list
of next actions.

**Operations** had no test either, and now has six across its four tabs. The
degraded component sorts first because it is the one to act on; a last-verified
reading is distinguished from a live one, since a cached connection test
presented as live state is how someone trusts a service that stopped answering
an hour ago; and the open-incident and blocked-control counts ride on the tabs
so they are visible from whichever tab you are on.

**Preflight is on.** It was off for the whole migration so Tailwind's reset
could not restyle views still on the old stylesheet. With every view migrated,
the reset is what the system wants — and it supersedes the hand-written
universal `border-style: solid` from ai-v1.62.0, which was standing in for it.
`ui/tokens.test.ts` now fails if preflight is ever switched back off, because
doing so would silently un-border every Panel, card, input and dialog again.
Markdown list markers are restored explicitly, since preflight strips them and
a checklist without them is prose.

**The alias tokens are gone.** `--surface-raised`, `--border-soft`,
`--text-muted` and the rest existed so 2,000 lines of old CSS and the new
primitives could share one palette during the migration. Nothing references them
now, so they collapse onto the real names.

914 tests green, web at 161. Contrast on the populated control room: 0 of 87
nodes below WCAG AA, worst 5.30.

**The stylesheet is 743 lines carrying 203 distinct colours** — from **2,020
lines and 754 colours** when the revamp began. Two components remain outside the
set: the connection drawer and the runtime-nodes panel.

## ai-v1.64.0 — 2026-08-07

Agents — the screen that decides what an agent may do, and had no test of any
kind.

That is the headline. `agents-view.tsx` carries the immutable Profile editor,
the distribution digest VM2 admits against, the execution ledger, and the
operator kill switch, and nothing in the suite rendered it. It has seven cases
now, and the migration was done against a preview rather than a diff.

**The kill switch says ON or OFF in words.** An operator reaching for the
execution boundary is already dealing with a problem and should not have to
infer the state from a hue; the colour is confirmation, not the message.

**The profile editor was a hand-rolled modal** — a backdrop div with no focus
trap, no Escape and no scroll lock, the same gap Chat's overlays had before
ai-v1.57.0. It is a long form deciding what an agent may do, which is the worst
place to tab out of by accident. It goes through `Dialog` now, and a case holds
that shut.

Elsewhere: the distribution digest sits on the profile row rather than behind a
click, because it identifies what the runtime will admit; the activity timeline
keeps its footer saying what it deliberately omits, since a bounded list read as
a complete one makes absent tool arguments look like calls that never happened;
and a run's output is marked with an accent rule so it is distinguishable from
its input at a glance.

- 123 rules dropped and 6 selector lists trimmed. `.agent-editor` stays: Onboarding
  and the runtime-nodes panel still borrow it.

908 tests green, web at 155. Contrast on the populated screen: 0 of 73 nodes
below WCAG AA, worst 5.27. The stylesheet is **1,448 lines carrying 399 distinct
colours, down from 2,020 lines and 754 colours** when the revamp began — under
four hundred for the first time.

Three view bodies remain: Operations, Onboarding, Tooling.

## ai-v1.63.0 — 2026-08-07

Knowledge and the audit trail.

Both screens make a claim about what is *not* kept, and both have a failure
state that must not read like a healthy one — which is most of what the rebuild
is about.

**Knowledge** states its zero rather than leaving a blank. "Source bytes
retained: 0 B" is the product's promise about the original file, and an empty
cell would read as missing data instead of as the claim it is. The
no-OCR warning moved to where someone is about to hand over a scanned PDF —
inside the upload panel — rather than arriving as a failure message afterwards,
since a scanned PDF is the most common thing to try and the least obvious thing
to fail. A source that failed extraction shows its failure code and reason
against a red rule; one that indexed shows green.

**Audit** puts the forwarding state on the panel's left rule: red failing, amber
behind, grey never configured, green delivering. A trail silently lagging the
SIEM is the single thing that panel exists to surface, and it had been rendering
the same as a healthy one. The event table now scrolls inside its own container
rather than widening the page — five columns, two of them identifiers — and an
expanded row lays its metadata out as a monospace block that can be read.

- seven cases across both, including that the trail keeps saying it is
  append-only and that a failed action tones differently from a successful one
- 103 rules dropped and 9 selector lists trimmed. Six classes stay: `document-status`,
  `document-empty`, `document-section-heading`, `documents-alert`, `documents-header`
  and `form-error` are still borrowed by Agents, Tooling, Onboarding, the
  connection drawer and the runtime-nodes panel.

901 tests green, web at 148. Contrast on both populated screens: 0 nodes below
WCAG AA, worst 5.30. The stylesheet is **1,571 lines carrying 437 distinct
colours, down from 754** — the first time it has been under sixteen hundred.

Four view bodies remain: Operations, Agents, Onboarding, Tooling.

## ai-v1.62.0 — 2026-08-07

Memory completes the Platform quartet — and nothing in the design system had a
border.

**The universal border reset.** `border-style` defaults to `none`, and CSS
computes `border-width` to 0 whenever the style is none. Tailwind's `border`
utility sets width only, so it painted nothing — on *every element*, not just
the buttons ai-v1.60.0 patched. Preflight normally supplies the global rule that
fixes this; preflight is off here so it cannot restyle the views still on the
old stylesheet, and the consequence went unnoticed: every Panel, card, input,
dialog and empty state in the set has been drawing no border since the
primitives shipped. Screens read as flat washes of background rather than as
structure.

The fix is the one rule preflight provides and this project cannot do without —
`border-style: solid; border-width: 0` on `*` — which adds no border by itself
and, at specificity (0,0,0), loses to every existing rule. ai-v1.60.0 fixed this
narrowly on `button` after finding it there; the general case was the same bug
and should have been fixed then. `ui/tokens.test.ts` now holds both.

Every migrated screen gained its structure at once. Verified against an
unmigrated view too, since the reset is global: Platform and its context bar are
unchanged.

**Memory**, meanwhile, was the last of the four Platform governance screens and
the only one still half-migrated — it had the primitives for its lineage badges
since ai-v1.55.0 but a bespoke workspace around them. Policy list, the capture
form, the reason field, the by-topic forget preview and the stored-record list
now all build from the set. The two paragraphs that explain what *always shown*
and *current context* mean are tinted to match the badges they describe, so the
legend and the thing it explains are the same colour.

- the lineage interaction test doubles as this screen's preview, the way
  `chat-transcript.test.tsx` does for Chat
- 17 more rules dropped; `.memory-*` is gone from the stylesheet entirely

894 tests green, web at 141. Contrast on the populated screen: 0 nodes below
WCAG AA, worst 5.27. The stylesheet is **1,674 lines carrying 461 distinct
colours, down from 754**.

Six view bodies remain: Operations, Agents, Onboarding, Tooling, Documents, Audit.

## ai-v1.61.0 — 2026-08-07

Prompts and Guardrails, and the end of the shared governance stylesheet.

The two remaining screens that were structurally Models — a summary row, a
runtime-assignment panel, an editor, and a catalogue of versioned cards each
carrying an activate/suspend decision — now build from the same primitives.
Both were verified populated before shipping, through the preview harness rather
than by reasoning about a diff.

Both screens govern something that sits directly in the chat path, and both have
a third state that is easy to miss: not *active* or *draft* but **previously
active and now suspended**, in which chat deliberately fails closed. That state
now reads off the panel's left rule — green enforcing, red failing closed, grey
never adopted — instead of only from a sentence. The suspend action inherits the
tone of what it will do.

- Prompts shows the system instruction verbatim in a scrollable block. It is the
  artefact under governance, and a truncated one cannot be reviewed. The
  checksum stays beside it, since that is what audit retains in place of the body.
- Guardrails lists only the detectors actually switched on, and its ceilings are
  tabular so two policies can be compared down the column.
- seven cases across both, including that the active policy offers Suspend and
  no Edit — an active record is immutable, and offering the edit would be a lie

**The merged selector lists are gone.** Four governance screens shared one set
of comma-joined rule bodies, and the convention was to add a new screen by
appending its prefix to each list. With Models, Prompts and Guardrails migrated
there was nothing left to share: 92 rules dropped and 11 lists trimmed. Only
`.guardrail-grid` survives, and it belongs to Operations rather than Guardrails.

894 tests green, web at 140. Contrast on both populated screens: 0 nodes below
WCAG AA, worst 5.30 and 5.59. The stylesheet is **1,670 lines** carrying **472
distinct colours, down from 754** when the revamp began.

Five view bodies remain: Operations, Agents, Onboarding, Tooling, Documents,
plus Memory's workspace and Audit.

## ai-v1.60.0 — 2026-08-07

Models on the design system — and two ways the system was quietly producing
nothing.

Models is the first of the eight secondary views to move, and the first one
built with a preview to look at rather than a diff to reason about:
`models-view.test.tsx` renders a populated catalogue and, with
`VIEW_PREVIEW_OUT` set, writes it to a file the way `chat-transcript.test.tsx`
does. That is how both of the following were found — by reading computed styles
on a real screen, not by reading code.

**No button in the dashboard had a border.** The `@layer base` reset added in
ai-v1.55.1 wrote `border: 0`, and the shorthand also sets `border-style: none`.
CSS then computes `border-width` to 0 no matter what a later rule declares — so
Tailwind's `border` utility, which sets width only, did nothing. In the DOM the
class was present and the computed width was `0px`. Now `border: 0 solid
transparent`, which keeps the reset and lets a width utility apply.

**Every opacity modifier on a theme colour emitted no rule at all.** Tailwind
can only apply `/10` or `/40` to a colour it can decompose, and
`accent: "var(--accent)"` holding a hex gives it nothing to split. Twenty-five
tinted backgrounds and borders were missing that way — the danger Button, every
`Alert` tone, the Chat approval block, message avatars, agent-activity icons —
each with the class sitting in the markup and no declaration behind it. The
palette is now channel-first (`--bad-rgb: 224 118 127`) with the hex derived
from it, so `styles.css` and Tailwind share one source of truth and the
`rgb(... / <alpha-value>)` template works.

- `ui/tokens.test.ts` fails if a colour is added in the short form, or if the
  button reset loses its border style
- `toneFor` moves into the primitive set; two views had begun keeping private
  copies of the same six-tone-to-four-colour mapping

Models itself: `PageHeader`, a real `MetricRow`, the boundary note as a Panel
with an accent rule, the editor on `Field`/`Input`/`Select`, and route cards
whose fact grid draws hairlines from a `gap-px` rather than per-cell borders.
The activate/suspend decision inherits the tone of what it will do.

- 29 stylesheet rules dropped and 39 shared selector lists trimmed, leaving the
  three governance screens that still need them untouched

885 tests green, web at 133. Contrast on the populated catalogue: 0 of 61 nodes
below WCAG AA, worst 5.30. Distinct hand-picked colours in the stylesheet:
**533, down from 754** when the revamp began.

## ai-v1.59.0 — 2026-08-07

Nine locked screens become one.

The plan called this the biggest consolidation in the primitive set, and it was
still outstanding: `LockedScreen` existed but only Chat used it. Every other
governed area wrote its own, so a person who lost their session saw nine
slightly different explanations of the same thing — three different marks,
five different button labels ("Open platform settings", "Administrator setup",
"Unlock operations", "Manage Agentic System", "Sign in locally"), one screen
saying "Administrator **access** required" where eight said "session", and four
different layouts. Agents, Knowledge, Guardrails, Memory, Models, Operations,
Prompts, Tooling and Setup now all go through the primitive.

Two things the consolidation had to learn rather than flatten:

- **Not every locked area wants an administrator.** Chat, Knowledge and Agents
  also serve enterprise identities. Telling an employee an administrator session
  is required sends them to a person instead of to the sign-in they are entitled
  to use, so `headline` states what the area actually needs.
- **Some have two ways in.** `secondaryLabel`/`onSecondary` carries the
  enterprise-vs-administrator choice properly, and Chat drops the hand-rolled
  button it was using underneath the panel to fake one. A label with no handler
  draws nothing, because a button that does nothing is worse than no button.

Every screen now names its area in an `h1`, which is what makes the four
Platform governance screens distinguishable — `admin-access.test.tsx` has
asserted exactly that for four of them all along, and the other five inherit it
for free.

- delete 36 stylesheet rules across 20 dead class names, plus an orphaned
  comment left behind by ai-v1.57.0 describing a rule that no longer exists

878 tests green, web at 126. Contrast unchanged: 0 nodes below WCAG AA, worst
5.30. The stylesheet is **1,753 lines, down from 1,974** before the revamp.

## ai-v1.58.0 — 2026-08-07

The message transcript, and a way to actually look at one.

ai-v1.57.0 left the transcript on its own classes and said why: 200 lines of
intricate CSS whose result cannot be seen without a signed-in session and real
messages. That reason is now gone. `chat-transcript.test.tsx` mounts a
conversation carrying every block the transcript can produce — markdown with a
heading, list, blockquote, code fence and table; three agent-activity events; a
pending approval; two knowledge sources; full response telemetry; and a failed
turn — and with `TRANSCRIPT_PREVIEW_OUT` set it writes the rendered markup to a
file. Paired with the built stylesheet that opens in a browser, which is how
every decision below was checked rather than guessed.

It earns its place in the suite either way: the transcript is what the product
exists to render and it had no test at all. Seven cases now cover markdown
becoming real elements rather than showing its own backticks, effective speed
being *derived* (382 output tokens over 4.12 s → 92.7 tok/s — nothing reports
that, OrcaSynapse computes it), an approval offering a decision only while it is
open, each governed step naming what it cost, sources carrying their match
score, and a failed turn drawing no telemetry panel for the numbers it never
produced.

Rebuilt on the design tokens: message rows and avatars, the heading and its
tags, streaming status, agent activity, approvals, sources, the telemetry grid,
and the response actions. The person's turn stays a bounded card and the agent's
does not — that asymmetry is the only thing letting the eye find where an
exchange begins without reading any of the text.

- the telemetry grid draws its hairlines from a `gap-px` over a bordered
  background, so no cell carries a border of its own and none double at the
  panel edge — which is what four `nth-child` rules in the old stylesheet
  existed to work around
- `.message-markdown` stays a stylesheet rule, and that one is structural:
  ReactMarkdown emits the headings, lists, tables and code blocks itself, so
  there is no element for a class name to go on. Retoned onto the tokens so it
  moves with the rest of the system.
- the duplicate `.agent-activity` block is gone. Chat and Agents both defined
  that class; every chat rule was being overridden by the later Agents block,
  which is the sort of collision that resolves by file order until it doesn't.

878 tests green, web at 124. Contrast measured on a fully populated transcript
for the first time: **0 of 119 nodes below WCAG AA, worst 5.30, median 7.36.**

The stylesheet is now **1,791 lines, down from 1,974** before the revamp began —
and that is after four screens moved onto a system that did not exist then.

## ai-v1.57.0 — 2026-08-07

Chat's shell on the primitives, and four dialogs that were never dialogs.

Knowledge, Skills, "What agents remember about you" and the delete confirmation
each carried `role="dialog"` and nothing that makes one: no `aria-modal`, no
focus trap, no Escape, no scroll lock, no focus restore. A keyboard user could
tab straight out of the memory panel into the transcript behind it while a
screen reader went on describing the page as though nothing had opened, and the
only way to close any of them was to find and click the `×`. They now go
through the `Dialog` primitive, which supplies all of it once. Two of them also
stop pushing the transcript down the page to make room for themselves.

The conversation menu had no way out at all — no Escape, no click-away. Archive
and Delete live in it, so a menu left open over the transcript is one stray
click from an action nobody meant to take. Both now dismiss it.

Rebuilt on the primitive set: the locked screen, the history rail, the topbar
and its runtime summary, the empty state, and the composer. `LockedScreen`
gained a `kicker` because Chat is the one governed area an employee reaches
without an administrator session, and labelling it "Administration" was wrong;
it also gained a stacked layout below `sm`, where three auto columns had been
squeezing the explanation into a four-word ribbon on every one of the nine
screens that will use it.

Two layout facts now live in the component rather than in a rule keyed to a
class name: Chat opts out of the shell's 1380px centred column, and its locked
screen supplies the page padding the shell zeroes for the workspace.

- six interaction cases covering the modal contract — `aria-modal`, scroll lock,
  Escape, Tab staying inside the panel — plus the menu's two dismissals and the
  locked screen's two paths
- delete 131 lines of stylesheet the rebuilt shell no longer needs

871 tests green, web at 117. Contrast on Chat: 0 nodes below WCAG AA, worst 5.30.

Still on their own classes, deliberately: the message transcript and its
telemetry, agent-activity and approval blocks. That is 200 lines of intricate
CSS whose result cannot be seen without a signed-in session and real messages,
and porting it blind is exactly the kind of change that looks fine in a diff.
It follows in its own release.

## ai-v1.56.0 — 2026-08-07

Rebuild Home on the primitives — and find that the design system had been
deleting its own classes since the day it shipped.

Home is the screen every operator lands on and the first view rebuilt end to end
on the ai-v1.54.0 set: `PageHeader`, `Panel`, `PanelHeading`, `Metric`,
`StatusText`, `Button`. Two new primitives came out of it — `PageHeader`, which
twelve views were writing by hand with a slightly different heading level and
description width each time, and a `dot` on `StatusText`, which four stylesheet
rules drew as a circle at four different sizes. The four-step runtime path is now
horizontal rather than a vertical list down one column, and reads as the flow it
describes. Readiness gained a fill rule, because it is the one figure here with a
denominator.

Home also gets its **first render test** — seven cases covering what a locked
session may see, where the single primary action points, and whether a layer row
still opens the platform tab that actually configures it.

**The defect underneath.** The primary button was rendering light text on the
accent fill at **2.34:1**. The cause was not the colour: `cn()` was deleting the
class. tailwind-merge's colour matcher accepts *any* `text-` class, so every
custom size in `tailwind.config.ts` was being read as a colour and dropped by the
colour beside it — `text-micro text-faint` came out as `text-faint`,
`text-[#0a0a0b] text-body` as `text-body`. The whole type scale was inert
everywhere, and nothing showed it: the class is simply absent from the DOM, no
warning is logged, and the element inherits a size that looks plausible. The
dependency was also on the v3 line, which is built for Tailwind 4 semantics while
this project is on Tailwind 3 — that pairing was silently removing
`focus-visible:outline`, so **no button in the dashboard had a focus ring**.

- pin `tailwind-merge` to the line matching Tailwind 3 and register the theme
  tokens it cannot infer, so a size and a colour survive together
- `cn.test.ts` reads `tailwind.config.ts` directly: adding a size there without
  adding it to `cn.ts` now fails a test instead of vanishing at runtime

**A regression from ai-v1.55.1, found by looking.** Rebuilding the sidebar on
utility classes dropped `.nav-item svg`, and with preflight off every navigation
icon fell back to the SVG default — 300x150, filled black. The contrast sweep
could not see it, because a black shape on a dark panel has no text to measure,
and the accessibility tree does not report size. `Glyph` now carries its own
size and stroke as presentation attributes and depends on no ancestor rule.

Verified in the browser: focus ring paints 2px solid accent at 2px offset, and
the contrast sweep reports **0 nodes below WCAG AA, worst 5.30** (up from 4.78),
median 7.36. 865 tests green, web at 111.

- delete 74 lines of stylesheet that only the old Home markup used —
  `.setup-banner`, `.content-grid`, `.connection*` rows, `.readiness-*`,
  `.runtime-flow`, `.boundary-note`, `.phase-tag` and their responsive blocks

## ai-v1.55.1 — 2026-08-07

Make the back button work, and rebuild the sidebar.

Navigation wrote every route with `replaceState`, which creates no history entry
— so pressing Back anywhere in the dashboard left the application rather than
returning to the previous screen. It is now `pushState`, guarded so selecting
the view already showing does not stack duplicate entries and make Back appear
stuck. The existing `hashchange` listener already re-derives the view, so
nothing else was needed.

Verified in the browser: history grows 2 → 3 → 4 across two moves, and going
back twice returns through Knowledge to Home with the active nav item following.

- rebuild the sidebar on the ai-v1.54.0 primitives: monospace group labels, an
  accent rule on the leading edge of the active row instead of a filled block,
  and a truncating description line

**And the trap that came with it.** Preflight is off so Tailwind cannot restyle
the views not yet migrated — but that also means a bare `<button>` renders with
the OS default light-grey fill. The rebuilt sidebar dropped the class that had
been resetting it, putting muted text on `#f0f0f0` at **2.25:1**, which looks
merely "a bit off" rather than obviously broken. Fixed for every future raw
button with a scoped `@layer base` reset; an element selector loses to any
class, so existing styled buttons are untouched. Back to 0 nodes below WCAG AA,
worst 4.78, median 7.36.

Not done, deliberately: replacing the twelve-branch view ternary with a lookup
map. It is a readability change to 120 lines of prop-passing across views that
mostly have no render test, where a silently dropped prop would not be caught.
It belongs with the release that gives those views their tests, not before.

## ai-v1.55.0 — 2026-08-07

Show what the agent actually believes, and say when it changed its mind.

Version chains (ai-v1.49.3), supersession (ai-v1.49.0) and forget batches
(ai-v1.51.0) all wrote to columns nothing ever read. `agentMemoryRecordSchema`
carried nine fields and none of the lineage, so the API could not return it even
if the interface asked.

Worse than a missing feature: `records()` had **no lifecycle predicate at all**.
A fact the person had corrected weeks ago, a fact they had asked to have
forgotten, and the current one were all returned together and rendered
identically. An operator auditing what an agent knows was reading a mixture of
current belief and everything it had ever been told.

- extend `agentMemoryRecordSchema` with `version`, `parentMemoryId`,
  `rootMemoryId`, `isLatest`, `supersededAt`, `supersededReason`, `forgottenAt`,
  `forgetReason` and `forgetBatchId`
- filter the record list to the live set by default, so it answers "what would
  this agent recall right now". `includeSuperseded` and `includeForgotten` make
  history a deliberate request
- apply the same predicate to `recordsForOwner`, which backs the end-user "what
  do you know about me" surface. Showing a forgotten fact there would have
  answered a deletion request with the thing that was deleted
- surface it: a corrected fact shows its version, a retired one shows what
  replaced it and why, a forgotten one shows its reason and batch, and Forget is
  offered only on a fact that is still live
- add a "show corrected and forgotten" toggle, off by default

The memory view is the first screen on the ai-v1.54.0 primitives, using `Button`
and `StatusText` in place of hand-written classes.

One plan item dropped after checking it: `GET /api/v1/admin/runtime/` looked like
a backend capability with no caller, but `aiOpsOverviewSchema` already embeds
`runtime: runtimeOperationsSnapshotSchema` and the operations view reads it from
there. The standalone route is a redundant sibling, not a gap — adding a second
client for it would have been duplication dressed as cohesion.

## ai-v1.54.0 — 2026-08-07

Give the dashboard a design system, and pin a vulnerable PDF parser on the way.

`styles.css` carried **754 distinct hand-picked colours across 989 uses** — the
top hundred covered 31%, so there was no palette to speak of. There were also no
shared components at all: twelve views inlined every button, tile, card and
modal, producing nine hand-written locked screens, nine copies of the stat-tile
row and five separate modal implementations, only one of which trapped focus.
That is why it did not read as enterprise, and no amount of per-screen work
fixes it.

- add Tailwind 3 with tokens as CSS custom properties, so the stylesheet and the
  utility classes share one palette while views migrate a release at a time
- neutral near-black surfaces with violet as the only saturated colour. An
  earlier pass tinted the neutrals too, which left the accent nothing to stand
  against
- add the primitive set in `apps/web/src/ui/`: Button, Panel, PanelHeading,
  Metric, MicroLabel, StatusText, Alert, EmptyState, LockedScreen, Dialog,
  Drawer, Field, Input, Textarea, Select
- extract the focus trap from `connection-drawer.tsx` so all five overlays share
  one correct implementation instead of four having none

**No Radix, and not by preference.** `deploy/nginx/default.conf` sets
`style-src 'self'` with no `'unsafe-inline'`. Radix's Popper primitives write
positioning transforms into inline `style` attributes, and Dialog pulls
`react-remove-scroll`, which injects a `<style>` element. Both are refused by the
browser — and the dev server sends no CSP header, so they would have worked
perfectly in `pnpm dev` and broken only in a built container. shadcn's Tailwind
and `cva` layer is used; its overlays are not.

The same constraint decides how a metric's bar is drawn: its width is data, an
inline width is illegal, so it is a real `<progress>` carrying its value as an
attribute. `ui.test.tsx` asserts the whole primitive set emits no `style`
attribute, because nothing else catches that before a container build.

Also in this release, found while checking the audit surface: **`pdfjs-dist` was
inside the range of GHSA-hq66-cqwq-w95j** (arbitrary JavaScript execution on
opening a malicious PDF), reachable through `officeparser`. Pinned above it via
`pnpm.overrides`. Uploaded PDFs are parsed by `unpdf`, not the affected path, but
it was a live high-severity advisory in a production dependency of a product
whose job is ingesting customer documents — and it was failing `security:audit`,
which CI blocks on.

Preflight stays off until the last view migrates: Tailwind's reset would restyle
the 2,000 lines still written against browser defaults.

## ai-v1.53.2 — 2026-08-07

Read the answer the model actually sends, not the one it was asked for.

The same model on a different serving stack renames the fields. LFM2.5-2.6B
through LM Studio returns `"type": "STATIC"` where llama.cpp returns `"scope"`,
and `"replaces": "The user works in Jakarta."` where llama.cpp returns `[1]`.
The parser read only `scope` and only numbers, so on that stack every fact fell
to the `EPISODIC` fallback and no correction was ever applied.

Nothing would have looked broken. Facts still store, search still finds them —
the always-injected profile just stays empty and superseded facts stay current.
Two mechanisms that took four releases to build, silently off.

- accept `type` as an alias for `scope`, preferring `scope` when both are sent
- resolve a `replaces` entry the model quoted rather than numbered, matching it
  against the facts it was actually shown. The match is exact, so a paraphrase
  cannot retire an unrelated memory
- accept a bare `replaces` value where a list was asked for

Verified end to end against the live model that exposed it: role, location and a
standing language preference all classify `STATIC`, and a move retires the fact
it replaces.

**Verification is partial.** This machine lost WSL and its route to the LXD
network, so there is no PostgreSQL for the data-layer suites. 235 tests ran —
contracts, security, runtime-clients, web, database, and the database-free
worker files including every case here — plus a clean typecheck and build. The
486 API, 66 remaining worker and 43 knowledge tests could not run and are
unverified in this release.

## ai-v1.53.1 — 2026-08-06

Wait long enough for a large model to answer.

Streaming got past Cloudflare's ~100s origin cap and straight into our own 120s
client timeout. Timed from inside the worker against Qwen3.6-27B over the
tunnel: first byte at 57 seconds while the model thought, complete at 193. Every
distillation aborted 73 seconds early and logged "could not distil session",
which reads exactly like an unreachable route.

- raise the distiller's timeout to 600s. Distillation is off the critical path
  entirely — once per conversation, after the person already has their answer —
  so the cost of waiting is one sweep tick running longer, while the cost of not
  waiting is that nothing is ever stored
- raise forget-matching's to 300s, and no further: that one answers an HTTP
  request, so the ceiling is what an operator will sit through rather than what
  the model might want

Three transports' worth of failure looked identical from the outside — 502 with
the tunnel down, 524 with it up but non-streaming, and an aborted stream — and
all three would have read as "the big model is worse" if the suite had been run
without checking first.

## ai-v1.53.0 — 2026-08-06

Stream the inference calls, because some transports will not carry them
otherwise.

Pointing the pilot at vLLM serving Qwen3.6-27B through a Cloudflare quick tunnel
made every distillation fail. Not the model — the transport. A free
`trycloudflare` tunnel kills any request whose origin takes longer than about
100 seconds, and a 27B reasoning model asked for a couple of thousand tokens
routinely takes longer. Measured on the pilot with the same prompt:

    non-streaming   524  after 125s
    streaming       200  after 400s

Each chunk resets the idle timer, so streaming gets under a cap that a
non-streaming call cannot.

- add `streamChatCompletion` to `@orcasynapse/runtime-clients`, and move memory
  distillation and forget-matching onto it. Both make the same call from
  different apps, so writing it twice would mean two sets of SSE parsing bugs
- reassemble frames across arbitrary chunk boundaries, keep a trailing frame
  that arrives without its separator, and survive a keep-alive or a truncated
  frame without discarding what came before it
- accumulate `content` only. A reasoning model streams `reasoning_content` too,
  which is its working rather than its answer

An empty answer is still a failure rather than "nothing was learned", and
`finish_reason: "length"` is still logged by name — those distinctions are what
made this diagnosable at all.

## ai-v1.52.2 — 2026-08-06

Make the quality harness measure memory rather than its own timing.

Two runs on the pilot were spoiled by the harness, not by the code under test.
It drained the session sweep to store a case's setup, but the sweep takes the
*longest-waiting* conversation — right for the worker, wrong for a caller that
needs one particular session stored. With a backlog it distilled unrelated
sessions, gave up at a silent cap, and one case asked its question 53 seconds
before its own fact was written. A second run lost four of six cases to the chat
rate limiter, which the harness treated as a hard failure.

- add `distilOne(conversationId)` to the session distiller: one named
  conversation, whatever else is waiting and whether or not it has gone idle
- have the harness distil the conversation it just wrote, rather than draining a
  queue and hoping
- retry a 429 by waiting past the limiter's one-minute window, and read the
  status off the error rather than pattern-matching its message — the message
  carries a conversation UUID, and hex digits spell 409 and 429 often enough for
  that to be quietly wrong
- say so when the initial drain hits its bound, instead of stopping quietly

The run this replaces still scored `4/5` with `language` passing, which is what
confirmed ai-v1.52.1 end to end. The point of these fixes is that the next number
means something without needing that reconstruction.

## ai-v1.52.1 — 2026-08-06

A standing preference is not a task instruction.

The metric shipped in ai-v1.52.0 scored 5/6 on its first run against the pilot,
with `profile 0/1` and a pointer at the always-injected block. The store showed
the cause was upstream of injection: "Please always answer me in Indonesian from
now on" had never been captured at all. Two rules in the extraction instruction
contradicted each other — a language preference is listed as durable, and
"instructions addressed to the assistant" are listed as never recorded. A 2.6B
model applied the prohibition and dropped the single most useful thing the person
had said.

- separate a one-off instruction for the task at hand from a standing one, and
  say plainly that "always answer me in Indonesian" is a preference about how
  they want to be helped
- show both readings as examples, since the same words are a task once and a
  preference forever

Also: the quality harness defaulted to `http://api:8080`. The API listens on
4000 inside the compose network; 8080 is the web container's published port, so
the default could never connect.

This is the metric doing its job on the day it shipped — it named the mechanism,
and the mechanism turned out not to be the one the failure looked like.

## ai-v1.52.0 — 2026-08-06

A memory number that says which mechanism is failing.

Every memory change in this series shipped on anecdote. Distillation was
verified with one hand-driven conversation, and the four defects the pilot
exposed were found by looking rather than by measuring. A single score would not
have helped either — what makes a memory metric useful is that it names the
mechanism, so "temporal 0/2" points at version chains and "profile 0/1" points
at the always-injected block.

- add a suite of six cases across five question types — stated fact, profile,
  temporal, session arc, and absence — each drawn from a failure that actually
  happened, so a regression is a regression in something that was fixed
- score with an LLM judge, reading anything short of an unambiguous PASS as a
  failure. A verdict the judge could not decide would otherwise inflate every
  number it touched
- keep a case that could not be run out of the score entirely. Counted as a
  failure it blames the code for an environment problem; counted as a pass it
  reports a clean run over nothing. The report names them instead
- run it end to end against a live installation:
  `docker compose exec worker node apps/worker/scripts/measure-memory-quality.mjs`

The harness invents no endpoints. Chat goes through the API exactly as a
person's would, distillation is the shipped sweep with its idle wait set to
zero, and the judge is the configured inference route. Every mechanism it scores
passed locally and then failed on the pilot for reasons no stub reproduced, so a
metric measured against stubs would measure the stubs.

Each question is asked in a fresh conversation. Asked in the one that stated the
fact, it would be answered from the transcript and would score a broken store as
working.

## ai-v1.51.0 — 2026-08-06

"Forget everything about Project Titan", previewed before it happens.

Between deleting one memory at a time and purging a person entirely there was
nothing, and a topic is what people actually ask about. Neither a `LIKE` nor a
similarity floor answers it: the facts to remove may say "the Titan migration",
"the Q3 rebuild", or name a colleague who only worked on it.

- add `forgottenAt`, `forgetReason` and `forgetBatchId` to `AgentMemory`
  (migration 0021), and fold "not forgotten" into the same predicate that
  already governs expiry, so no query path can honour one and miss the other
- decide with the model, not with a pattern: the owner's live facts are shown to
  it against the topic, and it names which are genuinely about it
- default `dryRun` to true. The preview is the whole safety argument, and the
  safe call is the one made by accident
- bound the blast radius with `maximumForget`, so a model that decided
  everything matches cannot empty a store in one request
- soft delete under one `forgetBatchId`, with the reason recorded, so what was
  forgotten, by whom, and why outlives the rows
- surface it on the memory view: name a person, name a topic, preview, confirm

Two things are reported rather than hidden. `capped` says the limit stopped the
operation short of every match, and `truncated` says the person had more stored
memory than one decision could read — a partial scan must never be presentable
as a complete one.

The matcher speaks only HTTP to the inference route, so it carries no model
weights into the API process — the same rule that keeps an embedder out of the
document manager. That is affordable here because agent memory is small: each
fact is at most 200 characters and policy bounds an owner to a few hundred.

An unreachable model is a 503, not a 200 reporting no matches. An operator told
nothing matched will conclude the topic is not stored, and act on that.

## ai-v1.50.1 — 2026-08-06

Do not mine the whole archive, and do not store what the assistant just said.

Both faults are ai-v1.50.0's, and the pilot found them within one sweep of
shipping it. Migration 0019 added `memoryDistilledAt` with a null default, which
made every conversation ever held look like it owed a distillation — 17 queued on
the pilot, going back before the feature existed. The first one the sweep read
was a request for a conference rundown, and it stored five panel titles as
DYNAMIC facts about the person, which meant they were then injected into every
prompt.

- mark conversations already idle at upgrade as read (migration 0020), so
  session distillation starts from now instead of harvesting the archive. Any
  conversation still live is left to distil normally
- drop an extracted fact that appears verbatim in the assistant's own turn.
  Verbatim only: paraphrase is what distillation is for, so anything short of a
  literal copy is kept
- add the failing shape to the instruction as an example — the person asks for a
  listing, the assistant gives one, and the answer is `[]`

The instruction already forbade recording facts about the world rather than the
person. A 2.6B model ignored it, which is the reason the guard is in code and
not only in the prompt.

## ai-v1.50.0 — 2026-08-06

Distil a conversation once it goes quiet, instead of after every turn.

Per-turn capture makes extraction read one message at a time, which cannot
resolve an arc: "I am moving to Bandung next month" and a later "the move is
done" become two facts that contradict each other, because nothing ever sees
both. It is also the wrong shape for the cost. On the pilot each capture takes
30–70s of inference *after* the answer is already delivered, and at
`maxConcurrentRuns = 1` that is a window in which the next message is refused.

Capture now waits for the conversation to be quiet for ten minutes, then reads
the whole session in one call.

- add `ChatConversation.memoryDistilledAt` (migration 0019) with a partial index
  over the conversations that could still owe a distillation
- take a transcript rather than a user/assistant pair in the distiller, bounded
  per turn and overall, trimmed from the front so a correction at the end of a
  long session survives the trim
- tell the model to record where the person ended up when they changed something
  mid-conversation, rather than both states
- sweep one idle conversation per tick in the worker, serialised for the same
  reason ingestion is: it holds an inference connection on the host that is
  already the tightest part of the deployment
- stamp the conversation as read *before* distilling, so a crash cannot loop on
  it forever, and rewind that stamp when the model was unreachable, so a
  transient failure does not silently discard a session
- keep per-turn capture for runs that belong to no conversation: an agent
  invoked through the API has no session to wait for

A resumed conversation distils again and reads only what was said since, so
facts already stored are not extracted a second time.

## ai-v1.49.5 — 2026-08-06

Build before typechecking, and CI goes green after 76 consecutive red runs.

`verify` ran `typecheck` first, then `build`. Cross-package types resolve through
each package's emitted `dist/index.d.ts`, so on a fresh checkout — which is every
CI run — typechecking `apps/worker` failed with `Cannot find module
'@orcasynapse/knowledge'`, and every inferred type in the files importing it
collapsed to `any`. It never reproduced on a development machine, because a
`dist/` left over from any earlier build satisfies the import.

Nothing was wrong with the code: the last 76 failures were the same ordering bug
reported against whatever had most recently changed, which is why they read as
new each time and why one of them was misdiagnosed as a stale lockfile.

- run `build` before `typecheck` in `verify`, so the declarations dependents need
  exist before anything reads them
- verified by deleting every `dist/` and running `pnpm verify`, which is the
  condition CI actually runs under and the one no local run had reproduced

Last green run before this: 2026-08-03.

## ai-v1.49.4 — 2026-08-06

A busy agent is a conflict, not a server error.

Sending a chat message submits an agent run, so `submitRun`'s errors surface on
the chat route — and `sendChatError` mapped only the chat-specific ones. On the
pilot, sending a second message while the first run was still finishing produced
`500 Internal Server Error` with a stack trace in the API log, for a limit an
administrator had deliberately configured. Longer distillation makes the window
wider, which is how this surfaced now rather than earlier.

- map `AgentConflictError` to 409, `AgentRuntimeDisabledError` to 423, and
  `AgentNotFoundError` to 404 on the chat path, matching what the agent routes
  have always returned

The dashboard already surfaces the API's message on a failed send, so the reason
now reaches the person instead of a generic failure.

## ai-v1.49.3 — 2026-08-06

Actually write the version chain ai-v1.49.0 said it wrote.

Migration 0018 added `version`, `parentMemoryId`, and `rootMemoryId`, and
`remember()` never populated any of them. The pilot showed the shape of the bug
plainly: a corrected fact was retired with a reason and the correction that
replaced it still read `version = 1`, `parentMemoryId = null`,
`rootMemoryId = null`. Retirement worked; the chain the release described did
not exist, so "what did it used to believe" could be answered one step back and
no further.

- derive each new fact's place in the chain from the rows it actually retires,
  read inside the same transaction before the update makes them non-latest
- number the correction one above the highest version it replaces, point its
  parent at that row, and carry the origin's root forward so a chain of any
  length still resolves to where it started
- leave a fact that starts its own chain on the column defaults, so an origin is
  never updated to point at itself
- skip the retirement entirely when a named id is already superseded, rather
  than recording a second reason over the first

## ai-v1.49.2 — 2026-08-06

Make the always-on facts correctable, and stop storing the same fact twice.

With the token budget fixed, supersession fired on the pilot for the first time —
and retired the wrong row. A turn about moving from Jakarta to Bandung retired a
near-identical episodic memory and left the STATIC "The user works in Jakarta."
live, so the profile asserted both cities at once. The same turn also re-stored
three facts it had just been shown as known, which is why "The user prefers
answers in Indonesian." appeared twice.

- offer the whole profile to the distiller as supersession candidates, unioned
  with the similarity hits and de-duplicated by id. A fact injected into every
  prompt is the most damaging one to leave stale, and similarity alone does not
  reliably surface it
- carry `id` on profile facts, so a stale one can be named as replaced rather
  than only displayed
- drop any extracted fact that matches one already shown as known, or an earlier
  fact in the same answer, comparing on letters and digits only. The instruction
  now says not to restate known facts as well, but the guard does not depend on
  the model obeying it

## ai-v1.49.1 — 2026-08-06

Give the distiller room to think, and stop reading a truncated answer as "nothing
learned".

Supersession worked in unit tests and did nothing on the pilot. The cause was not
the logic: LFM2.5 is a reasoning model that fills `reasoning_content` before
`content`, and at `max_tokens: 600` any realistic exchange came back
`finish_reason: "length"` with `content: ""`. The distiller read that empty string
as a successful extraction of zero facts, so the turn was marked captured and the
Jakarta fact was never retired. Probed directly with a wider budget, the same
model returns exactly the right answer, `replaces` and all.

- raise `MAXIMUM_RESPONSE_TOKENS` to 2,400 so the answer survives the reasoning
  preamble, and `REQUEST_TIMEOUT_MS` to 120s to match what 2,400 tokens costs at
  the pilot's throughput
- treat an empty or whitespace-only answer as a failure rather than as nothing
  learned, so the turn is retried instead of silently marked done
- log the token ceiling by name when `finish_reason` is `length`, because a
  budget exhaustion and a refusal are indistinguishable in the response body and
  have different fixes

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
