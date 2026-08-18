# Scheduled conversation turns

The goal: an operator says "run this prompt on this conversation every morning"
and the reply lands in the thread looking exactly like a turn they typed —
streamed, guardrailed, audited, cancellable, and counted in Usage.

## Why the obvious approach does not work

A cron *inside Hermes* cannot reach the dashboard, and no amount of configuring
it will change that. Every chat turn in OrcaSynapse is initiated by VM1 and only
by VM1:

1. `POST /api/v1/chat/conversations/:id/messages` (`chat/routes.ts:235`) calls
   `submitMessage`, which writes an `AgentRun` row.
2. `chatRunWakeStatement()` fires `pg_notify` **inside that same transaction**,
   so a wake can never point at a row the reader cannot yet see.
3. The worker claims the run and calls `hermes.start(...)`
   (`agent-processor.ts:447`), which POSTs to `/api/sessions/:id/chat/stream`.
4. Everything the dashboard renders is a projection of *that* response stream.

A Hermes-side cron produces a turn in Hermes's native session with no `AgentRun`
row, no worker lease, and nobody subscribed to the stream. The message genuinely
exists on VM2 — Hermes remains canonical for session state — but the control
plane never learns it happened, and nothing polls for it.

Nor can VM2 push one. `requireChatPrincipal` (`chat/routes.ts:49`) accepts an
administrator session carrying `chat:use` or an enterprise session, and has no
node-signature branch, so none of the eleven chat routes are reachable with a
node identity. The full set of node-authenticated inbound routes is `bootstrap`,
`enroll`, `heartbeat`, `desired-state`, and the three corpus routes — of which
only `POST /:nodeId/corpus/snapshot` carries bulk content, and
`hermesCorpusSnapshotEntrySchema` is strictly filesystem-shaped (`path`, `kind`,
`mediaType`, `sha256`, bounded `content`) over kinds `MEMORY | SKILL |
SKILL_FILE`. There is no transcript kind and no message kind.

**One consolation worth knowing during triage.** A Hermes-side cron still
reaches a model through `/internal/v1`, because that is the only inference path
enrolment gives it — so its calls *are* guardrailed and audited. They will not
appear in Gateway → Usage, which aggregates `FROM "AgentRun"`
(`usage/drizzle-usage-manager.ts:119`) and therefore cannot see a turn with no
run row. Operations → Audit trail is where such a cron shows up.

## What already exists

| Capability | State |
| --- | --- |
| Run dispatch, streaming, cancellation, audit projection | built |
| Guardrail input inspection on every run-creating path | built (v8.9.0) |
| Per-subject chat rate limiting and conversation ownership | built |
| Worker wake on commit, plus a reconcile timer that guarantees pickup | built |
| A periodic runtime service living in the API process | built (`ConnectionMonitorRuntime`) |
| The schedule record, its API, and its ownership scoping | built (increment 1) |
| The dispatcher that fires them | built (increment 2) |
| The panel that creates and explains them | built (increment 3) |
| A stopped schedule reaching Operations on its own | built (increment 4) |

The only interval in the product today is
`ConnectionMonitoringControl.intervalSeconds`, which paces connection health
probes and has nothing to do with runs.

## The design

**A schedule fires by calling `submitMessage`, the same entry point the route
calls.** Not a second run-creation path. `submitMessage`
(`drizzle-chat-manager.ts:575`) already resolves the active guardrail policy,
inspects and redacts the input, enforces the per-subject rate limit, refuses an
archived conversation, refuses a conversation with no Agent Profile, builds
history, and calls `submitRun`. A scheduler that reproduced any of that would be
a second place for those rules to drift out of agreement.

**It runs in the API process, not the worker.** `submitMessage` lives in
`apps/api`; the worker is a separate application that talks to Drizzle and the
Hermes client, and reaching the chat manager from there would mean either
duplicating it or hoisting it into a package. The precedent is already set:
`ConnectionMonitorRuntime` (`connections/connection-monitor.ts:34`) is a
`setInterval` with `unref()`, started at `app.ts:124` and stopped at `app.ts:100`
as part of shutdown. `ScheduleRuntime` is that shape.

**The worker needs no changes at all.** Once the row exists the wake fires and
the existing dispatcher does the rest — which is the whole reason this design is
small.

### Whose turn is it?

`AgentRun.requestedBy` is a `NOT NULL uuid` and `ownerSubject` scopes the
conversation, so a schedule cannot fire as nobody. It fires as **the
administrator who created it**, whose `ChatPrincipal` (`chat-manager.ts:17`) is
five plain fields — `id`, `subject`, `identityMode`, `scopes`, `divisionId` —
and is therefore reconstructible from stored columns.

That choice settles four things at once for free: the rate limit counts against
the creator's subject, `submitMessage`'s ownership check keeps a schedule from
posting into someone else's conversation, division memory scoping resolves as it
would for a typed message, and the audit trail attributes the turn to a person
rather than to the system.

It also creates the obligation to **stop firing when that person should no
longer be acting** — a disabled or deleted administrator, or one whose `chat:use`
scope was removed. A schedule is a standing grant of the creator's authority, and
nothing else in the product currently holds one.

### The hazard the precedent does not cover

`ConnectionMonitorRuntime` guards only against overlapping cycles *within one
process* (`activeCycle`). A duplicate health probe is harmless; **a duplicate
schedule fire is a duplicate message to a human**. So a due schedule is claimed
by conditional UPDATE — `SET nextRunAt = <next>, lastRunAt = now WHERE id = ?
AND nextRunAt <= now` — and only a row the update actually returned is fired.
That is the same claim-by-update discipline `AgentRun` leasing already uses, and
it holds whether the API runs as one replica or several.

---

## Increment 1 — the schedule record — **built**

Records intent. Nothing fires, so it ships safely on its own.

- **Schema:** `ChatSchedule` — `conversationId` (FK, cascade), `prompt`,
  `intervalSeconds`, `nextRunAt`, `lastRunAt`, `lastOutcome`, `lastDetail`,
  `enabled`, `createdBy`, `createdBySubject`, `revision`, timestamps.
  `createdBySubject` sits beside `createdBy` for the reason
  `PlatformReleaseTarget` states: a federated creator has no
  `LocalAdministrator` row, so the uuid alone cannot be resolved back to a name.
  It is NOT NULL while the uuid is nullable, because it is also the subject the
  schedule fires *as*. Migration `0015_nasty_namor`.
- **Cadence:** `intervalSeconds`, not a cron expression. Cron syntax invites
  `* * * * *`, and the product has no way to explain to an operator what that
  will cost them. Bounded 300s–604800s in both the contract and
  `ChatSchedule_intervalSeconds_check`, so a caller that reaches the manager
  without the contract still cannot write a row the dispatcher would fire every
  second. The floor is five minutes rather than the thirty seconds
  `ConnectionMonitoringControl` allows: these are model calls charged to the
  deployment, not probes, and five minutes is already 288 runs a day.
- **Contract + API:** `GET`/`POST /conversations/:id/schedules` and
  `PATCH`/`DELETE /schedules/:id`, behind the same `requireChatPrincipal` every
  other chat route uses, scoped by the same ownership test `submitMessage` makes.
  Ownership and existence produce one error, because reporting them apart
  discloses that the conversation exists.
- **Prompt length** is validated against `maxInputCharacters` at write time as
  well as at fire time, so an operator learns about a refusal while they are
  looking at the form rather than silently every morning. Only the length: rule
  and detector checks stay inside `submitMessage`, against the policy active at
  the moment of the fire, so a policy activated after a schedule was written
  still governs it.
- **Two behaviours worth stating**, both asserted: a new schedule arms one
  interval out rather than immediately, because a schedule made due on creation
  fires while the operator is still looking at the form; and re-enabling a
  disabled schedule re-arms from now and clears the stored reason, because a
  `nextRunAt` left a week in the past would fire the instant it came back.

**Done, and asserted:** eight cases in `drizzle-chat-manager.test.ts` against
real migrated PostgreSQL, covering arming, explicit start, cross-owner refusal
on both create and list, the policy ceiling, re-arm on enable, edit leaving the
armed time alone, FK cascade on conversation delete, and the database's own
interval bound.

## Increment 2 — `ScheduleRuntime` — **built**

- `apps/api/src/chat/schedule-runtime.ts`, mirroring `ConnectionMonitorRuntime`:
  `start()`/`stop()`, `setInterval` with `unref()`, an `activeCycle` guard, and
  wiring in `app.ts` beside the monitor.
- Each tick claims due rows by conditional UPDATE and calls
  `chatManager.submitMessage(principal, conversationId, prompt)` per claimed row.
- **Every refusal `submitMessage` can raise is expected here**, and none may kill
  the loop: a guardrail block, a rate limit, an archived conversation, a legacy
  conversation with no profile, a deleted conversation. Each disables or skips
  its own schedule with a stored reason and leaves the others running.
- The stored reason is what the panel shows. A schedule that silently stopped is
  the failure mode this feature will actually be judged on.

### What the open question was answered with

**A schedule stops when its creator's authority stops, and says whose.** The
dispatcher rebuilds the creator's `ChatPrincipal` on every fire rather than
storing one — a stored principal is a frozen grant, and the schedule would go on
firing with the scopes and division its creator had the day they made it, for as
long as the row existed. `createdByMode` records which source to re-read:
`LocalAdministrator` (refused when `disabledAt` is set, scopes derived from the
role through the exported `scopesForAdminRole`, and `chat:use` required) or
`EnterpriseUser` (refused when not `enabled`, division read fresh, scopes the
fixed pair every enterprise session carries). A mode this release does not
recognise is refused rather than guessed at. The reason names the subject,
because "disabled" alone leaves an operator guessing which of the three
refusals stopped it.

**Two more decisions the implementation forced.** A claim moves `nextRunAt`
forward from the claim instant, not from the time the fire was due: a deployment
down for a day would otherwise return and fire every missed window in a burst —
a stampede of model calls and a wall of identical messages for whoever opens the
thread. And an *unrecognised* failure is a skip, not a disable, because
disabling on a database blip would turn one transient outage into every schedule
in the deployment needing an operator to switch it back on.

**Done, and asserted:** seventeen cases in `schedule-runtime.test.ts` against real
migrated PostgreSQL — firing and re-arming, a single claim under two concurrent
cycles, no replay of missed windows, not-yet-due and disabled rows left alone,
rate limit skipping while a guardrail block and an archived conversation
disable, an unrecognised failure skipping, the batch continuing past one
refusal, a disabled creator and a role that lost `chat:use` both stopping the
schedule, an enterprise creator's division being re-read between fires, and an
unknown mode refusing. The claim is one `UPDATE ... WHERE id = (SELECT ... FOR
UPDATE SKIP LOCKED)`, so it holds across replicas rather than only within one
process — which is where `ConnectionMonitorRuntime`'s `activeCycle` guard stops.

## Increment 3 — the surface — **built**

- `chat-schedules.tsx`, opened from the conversation's More menu as **Schedule**.
  Its own file rather than more of `chat-view.tsx`, which is already 2,100 lines.
- Runs created this way are already ordinary `AgentRun` rows, so Usage,
  Operations and the audit trail needed nothing.
- **A cadence picker, not a number field.** The interval is bounded in two
  places; a free number would mostly be a way to discover those bounds by being
  refused. Five choices from 15 minutes to weekly, and an interval written
  through the API that is not one of them still renders as minutes rather than
  as "Unknown", because a working schedule must not look broken.
- **A stopped schedule renders as `Stopped`, never as a time.** A disabled row
  still carries a `nextRunAt` — the claim moved it forward before the failure
  was known — so rendering that field would promise a turn that is not coming.
- **`lastDetail` is shown verbatim**, which is what closes the open question:
  until this existed, a schedule that disabled itself a week ago was
  indistinguishable from one that is not due yet. `SKIPPED` and `DISABLED` are
  toned apart, because a rate-limited schedule is still armed and sending an
  operator to fix it would waste their time.
- The panel states the governance fact before an operator commits to one: the
  turn runs with their access and stops if their account is disabled.

**Done, and asserted:** nine cases in `chat-schedules.test.tsx` — both
explanatory sentences, create with prompt and cadence, an empty prompt refused,
stopped-not-due, skipped distinguished from stopped, Resume re-enabling, the
cadence named rather than the raw interval, and no inline style for the CSP.

## Decisions taken

- **Fires as its creator, not as a service identity.** A service principal would
  need its own conversation ownership, its own rate-limit bucket and its own
  division scoping, and would make every scheduled turn unattributable to a
  person. The cost is the revocation obligation above, which is the smaller
  problem and the one with an obvious answer.
- **Reuses `submitMessage` rather than `submitRun`.** Going straight to
  `submitRun` would skip guardrail inspection of the prompt, the rate limit, and
  the stored `USER` message — leaving a conversation whose transcript does not
  explain its own replies.
- **A bounded cadence, not cron.** See increment 1.
- **In the API process, not the worker.** See above; the worker is unchanged.

## Increment 4 — the push, not the pull — **built**

Increment 3 made a stopped schedule legible to somebody who opens the
conversation and looks. That is not the same as telling anybody. A morning
report that stopped a week ago was still a week of silence unless an operator
thought to check, and this is the one failure in the product that is silent by
construction.

- A **`scheduled-turns` component** on the AI-ops overview, which the existing
  machinery turns into a de-duplicated `WARNING` incident the moment it reports
  `DEGRADED` — the same path a degraded connection or a behind reconciler takes,
  so nothing new had to be invented to surface it.
- **`NOT_CONFIGURED` when nothing is scheduled**, rather than `HEALTHY`. A
  deployment that does not use the feature should not be told its schedules are
  fine.
- **A deliberate pause is not a fault.** `enabled = false` alone is not the
  signal: an operator who paused a schedule has done exactly what they meant to,
  and an incident for it would train them to ignore this component — which costs
  more than the case it was meant to catch. The signal is
  `lastOutcome = 'DISABLED'`, which only the dispatcher writes and which
  resuming clears.
- The summary carries the count and points at the conversation; the reason each
  schedule stopped stays on the schedule, because a summary that inlined them
  would grow without bound.

**Done, and asserted:** five cases in `drizzle-ai-ops-manager.test.ts` — nothing
scheduled, armed schedules healthy, a self-stopped schedule degrading *and*
opening an incident, a deliberately paused one staying healthy with no incident,
and the stopped count reported against the total. One existing assertion was
tightened rather than renumbered: it counted every `NOT_CONFIGURED` component to
mean "the two service placeholders", which coupled it to any unrelated component
that is legitimately unconfigured on a fresh deployment.
