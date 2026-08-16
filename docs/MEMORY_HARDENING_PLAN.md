# Division memory: the three flags, and what closes them

Status: **plan, not started.** Written at v8.5.0, against the memory work that
shipped across v8.2.0–v8.5.0.

Division-scoped memory works end to end. These are the three things I flagged
when it did, none of which block a pilot and all of which get worse with use
rather than better.

They are one plan rather than three because two of them are the same fact seen
from different sides: memory that only grows is also memory that costs more
every turn.

## The three, restated with what was measured

**1. No operator control or visibility.** Every completed run makes one model
call. There is no switch, no audit event, and nothing on screen saying it ran.
The sharp version is not the price of a call — it is that the call happens on
*every* turn and the correct answer is usually `[]`. An operator watching model
spend sees it rise with no explanation available anywhere in the product.

**2. Extraction holds a worker slot.** It runs inside `process()`, after the run
is finalised but before the slot is released — up to `EXTRACTION_TIMEOUT_MS`
(30s) if the endpoint hangs. The worker runs **5 concurrent runs**
(`worker-runtime.ts:29`), so this is throughput, never latency: the answer is
already delivered. Invisible at pilot volume, real when five slots are the
constraint.

**3. Memory only grows, and is selected by recency.** Injection takes the 40
most recent entries up to 6000 characters — roughly 1500 tokens on *every* turn
in that division, chosen without reference to the question being asked. Past 40
notes, older ones silently stop being seen. There is no dedup, so a fact
extracted twice sits there twice.

**And one thing not on the list, found while planning: nothing can delete a
memory entry.** `routes.ts` has `GET` and `POST` on `/scoped-memory` and no
`DELETE`. An operator can add a note and can never remove one — including a note
extraction got wrong. That is a worse gap than any of the three above, because
it has no workaround short of SQL.

## A — rank by relevance, not recency

*No schema. Ships alone.*

`ScopedMemoryEntry` already carries a **GIN index** on
`to_tsvector('simple', content)` (`schema.ts:1435`), and the governed `recall`
handler already queries it with `plainto_tsquery`. `divisionMemory` ignores both
and orders by `createdAt`.

Match against the run's input, rank, cap. Then a **small recency floor** — about
five entries — when the match returns nothing, so a division's standing facts
are not invisible to a question that happens to share no vocabulary with them.

**State the limitation rather than hiding it.** `tsvector` matching is lexical:
a note saying *"the month-end financial cycle closes on the fifth"* will not
match a question asking *"when do we close the books"*. Embeddings are the
answer to that and are a larger piece of work; this is a real improvement that
does not pretend to be the final one.

**Done when:** a relevant old note is injected ahead of an irrelevant new one —
the test that fails today; a question matching nothing still gets the recency
floor; the typical injected size falls well below the cap. **Half a day.**

## B — delete, and dedup on write

*Schema-free for the delete; the dedup is a query.*

- `DELETE /api/v1/admin/tooling/scoped-memory/:id` behind `corpus:delete`, which
  already exists in `ADMIN_SCOPES` — the same gate the corpus uses for the same
  reason. An audit event names who removed it.
- A delete control on the Memory panel beside each entry, with a confirm, since
  a note is not recoverable.
- **Dedup on write, exact content within a division.** Cheap, and it catches the
  common case: the same durable fact restated verbatim by extraction on two
  different turns. Near-duplicate matching needs similarity scoring and is
  deliberately out of scope — an exact-match filter that works beats a fuzzy one
  that argues.

**Done when:** an administrator can remove an entry and the audit trail says who
did; extraction writing a note that already exists in that division adds no row;
deleting an entry in one division cannot touch another's. **Half a day.**

## C — take extraction off the worker slot

*One nullable column and a sweeper.*

Extraction stops running inside `process()`. Instead the run is **marked** and a
periodic task drains the mark.

`AgentRun` gains `memoryExtractedAt timestamp null`. A marker column rather than
deriving the work from "completed runs with no `ScopedMemoryEntry`", because a
run that legitimately produced no notes would then be retried forever.

`DrizzleOperationsManager` already owns a reconcile timer running `reconcile()`
and `reconcileAbandonedRuns()` (`drizzle-operations-manager.ts:103`). This is a
third task on the same timer, following the same shape rather than introducing a
second scheduling mechanism.

Two things to get right, both of which the abandoned-run sweeper beside it
already demonstrates:

- **Claim before working.** Set `memoryExtractedAt` in the same statement that
  selects the batch, so two API processes cannot extract the same run twice.
- **Bound the lookback.** Only runs completed within a window — a queue that
  reaches back forever would, on first deploy, extract the entire history of the
  installation in one pass.

**Done when:** `process()` returns without waiting on extraction; a run
completed while extraction is failing is still marked rather than retried
forever; two concurrent sweepers extract each run once — asserted by running the
sweep twice and counting rows, not by reading the code. **1 day.**

## D — the switch and the audit trail

- **A deployment-wide switch**, following `ToolRuntimeControl` rather than
  inventing a control surface. Deployment-wide rather than per profile
  deliberately: it answers the urgent question ("stop spending this") in a
  fraction of the work, and per-profile control is a real feature that belongs
  with the profile editor and its versioning, not smuggled in here.
- **An audit event when extraction writes**, `memory.entry_extracted`, matching
  the `memory.entry_curated` that curated writes already record. This is the
  piece that answers "did it run, and what did it decide" during a from-scratch
  test, and it is the smallest thing here.
- **Label the origin on screen.** The Memory panel already distinguishes curated
  from remembered by a null `runId` and does not say so; show it.

**Done when:** turning the switch off stops every extraction call — asserted on
the fetcher, not the return value, exactly as `memory-extractor.test.ts` already
does for the unapproved-catalogue case; the audit trail shows what was written
and from which run; the screen says which entries an agent wrote. **Half a day.**

## Order, and why

**A, then B, then C, then D.**

A first because it is the cheapest and the only one that improves every turn
immediately, with no schema and no new machinery. B second because "cannot
delete" is the worst of the gaps and its fix is small. C third because it is the
largest and nothing else depends on it. D last because a switch for a thing
nobody is straining against is the least urgent — with the exception of the
audit event, which is small enough to ride along with C and is worth having
before a from-scratch test rather than after.

The one dependency: **B's dedup should land before C**, or a sweeper that
retries a batch after a partial failure writes the same notes twice.

## What this does not do

- **No embeddings.** A is lexical matching, which will miss paraphrases. The
  vector work is a larger piece with its own design, and this plan should not
  pretend to close it.
- **No per-profile control.** See D.
- **No retention policy.** Dedup slows growth; it does not bound it. A division
  that runs for a year still accumulates. Bounding it means deciding what a note
  is worth after six months, which is a product question rather than an
  engineering one, and nobody has enough data to answer it yet.
- **The division boundary is untouched throughout.** Every piece here changes
  what is selected, when it runs, or who can remove it. None of them changes
  where the division comes from, which is the run — and the tests that pin that
  should keep passing unmodified. If one of them needs editing, something has
  gone wrong.

## Total

| | Days |
| --- | --- |
| A — relevance-ranked injection | 0.5 |
| B — delete and dedup | 0.5 |
| C — extraction off the worker slot | 1 |
| D — switch, audit event, origin on screen | 0.5 |
| **Everything** | **2.5** |

A and B alone are a day and close the two that would be noticed first: the cost
of every turn, and an operator unable to remove a note extraction got wrong.
