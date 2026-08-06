# Agent Memory Runbook

Agent memory lives in OrcaSynapse's own pgvector plane, beside document
knowledge. Nothing about it runs on VM2, and no external service holds it.

**Nothing is stored about anyone by default.** A new installation, and every
existing profile after an upgrade, sits at `DOCUMENTS_ONLY`.

## What each mode stores

Set per agent, in **Agents → profile editor → Memory**.

| Mode | Recalls | Captures | Use it when |
| --- | --- | --- | --- |
| `DOCUMENTS_ONLY` *(default)* | documents only | nothing | The agent should answer from sources and forget the person entirely. |
| `RECALL_ONLY` | documents + memory | nothing | Memory an operator seeded should be usable, but the agent must not add to it. |
| `LEARN_USER` | documents + memory | facts from what the person says | A personal assistant that accumulates someone's stable facts and preferences. |
| `LEARN_EXCHANGE` | documents + memory | facts from either side of the turn | Richest recall, accepting that something the model asserted can become a durable fact. |

**`LEARN_USER` never stores model output.** That is the point of the split: an
answer the model got wrong once would otherwise be retrieved by later runs and
treated as an established fact about the person. `LEARN_EXCHANGE` opts into that
trade deliberately.

## What a capture actually stores

Since `v0.9.0`, capture stores **extracted facts, not the turn itself**, and
the mode above decides only whether capture happens at all.

Storing turns verbatim does not produce memory. On the pilot it produced 21 rows
that were entirely questions (`what is your name?`), commands, greetings, the
model describing itself (`I am LFM…`), and in one case the operator's own system
prompt. Recall then embeds a new question and matches previous *questions*, so
the highest-scoring hits were the least useful rows in the store. That is not a
tuning problem — no `recallMinimumScore` rescues it, because the capture step is
what is wrong.

After the answer is delivered, one model call extracts durable facts about the
person and returns an empty list when the turn taught nothing, which is the
common case. Nothing is stored when it returns nothing, and **nothing is stored
when the model cannot be reached** — falling back to raw turns would quietly
reinstate the behaviour this replaced.

Turn this off with `distillCapture: false` in the policy only if you want the
old verbatim behaviour back and understand what it stores.

## The installation ceiling

**Platform → Memory** holds one policy that bounds every agent at once. A
profile can be narrower than the ceiling but never wider, so
`maximumCaptureMode: RECALL_ONLY` stops all capture fleet-wide without editing a
single profile — the action you need when the answer to "stop storing things
about people" has to take effect now.

The ceiling is read **at capture time**, not at submission, so suspending it
also applies to runs already in flight.

| Field | Meaning | Default with no policy |
| --- | --- | --- |
| `maximumCaptureMode` | The most any agent may store. | the profile's own mode |
| `retentionDays` | How long a captured item survives. Null keeps it until deleted. | 365 |
| `maximumItemsPerOwner` | Cap per person per agent; the oldest beyond it are trimmed. | 500 |
| `recallLimit` | How many memories one run may recall. | 6 |
| `recallMinimumScore` | The similarity floor below which a hit is noise. | 0.4 |
| `knowledgeRecallLimit` | How many document excerpts one run may retrieve. | 18 |
| `knowledgeMinimumScore` | The similarity floor for document retrieval. | 0.35 |

Every field is enforced at the moment of use, not merely recorded. The right
column is what applies on an installation that has never written a policy —
capture is still bounded and still expires, so "nobody configured it" never
means "kept forever".

The last two govern **document** retrieval, not memory. They were constants in
the worker while their memory equivalents were administrable, so an operator
could tune what an agent remembered but not what it retrieved. The floor is the
one worth understanding: a question phrased unlike the source text scores lower,
so a schedule asked about as "what must X do" can land just under a floor that
"list the sessions" clears comfortably. Lower it when your people ask in their
own words; raise it if answers drift onto irrelevant passages.

`retentionDays` is stamped onto each item **as it is captured**, from the policy
in force at that moment. Lengthening retention later cannot retroactively extend
items already stored under a shorter promise; shortening it applies to
everything captured from then on.

Lifecycle matches prompts and guardrails: `DRAFT → ACTIVE → SUSPENDED`, one
active policy enforced by a partial unique index, `expectedRevision` on every
mutation, and a reason of at least three characters recorded in the audit trail.
An active policy cannot be edited in place — suspend it first, because runs are
being measured against it.

Unlike guardrails and prompts, activation requires **no promoted evaluation
evidence**. Those gate on evidence because they change how the model behaves;
this is a data-retention control, so it gets the lifecycle and the trail without
the evaluation machinery.

## Scopes

| Scope | Grants | Held by |
| --- | --- | --- |
| `memory:read` | See the policy and everything stored | PLATFORM_ADMIN, SECURITY_ADMIN, OPERATIONS_ADMIN, AUDITOR |
| `memory:manage` | Edit the policy, delete and purge memory | PLATFORM_ADMIN, SECURITY_ADMIN |

## Answering "what does it know about me"

**The person can answer it themselves.** Anyone signed in to Chat opens
**Memory** in the conversation toolbar and sees every item stored about them —
its text, which agent recorded it, and when it expires — with a *Forget* button
on each. No administrator, and no new enterprise scope: it runs on the same
`chat:use` principal as the conversation itself.

Both the listing and the deletion are scoped server-side to the caller's own
subject, taken from the authenticated session and never from the request. The
scope is the same SQL conjunct retrieval uses, so a stray identifier reaches
nothing: another person's memory returns `404`, indistinguishable from one that
does not exist.

An administrator answers the same question from **Platform → Memory**, filtered
by the person's subject. Deleting one item, or purging everything for a person,
requires a reason and is audited. Self-service deletions are audited too, and
marked as such.

## Retention

Pruning happens on write, not on a timer: each capture drops expired items and
trims the oldest beyond the cap. This matches how the rest of the codebase keeps
append-only tables bounded without adding another moving part — see the same
rationale in `admin-session.ts` for session pruning.

## Audit actions

| Action | Recorded when |
| --- | --- |
| `memory.captured` | A run stored items. Metadata carries the count and effective mode, never the content. |
| `memory.deleted` | One item removed, with the reason and whether it was self-service. |
| `memory.purged` | Everything for one person removed, with the count. |
| `memory.policy_created` / `_updated` / `_activated` / `_suspended` | Policy lifecycle, with the decision reason. |

No audit event contains remembered content. The trail records that memory
changed and why, not what it said about someone.

## Acceptance checks

1. With no policy and a `DOCUMENTS_ONLY` profile, run a chat turn and confirm
   nothing appears under **Platform → Memory**.
2. Set a profile to `LEARN_USER` and run a turn that states something durable
   ("I lead the platform team, and I prefer answers in Indonesian"). Confirm a
   *fact* is stored rather than the message, and that the model's answer is not.
   Then run a turn that asks a question and confirm nothing is stored at all.
3. Activate a policy with `maximumCaptureMode: RECALL_ONLY` and confirm that the
   same profile stops capturing while still recalling.
4. Confirm an expired item stops being recalled, and disappears on the next
   capture for that person.
5. Delete one item and purge one person; confirm both appear in the audit trail
   with their reasons and neither carries the content.
6. Confirm a second policy cannot be activated while one is already active.
7. Activate a policy with `retentionDays: 30`, capture an item, and confirm its
   `retentionUntil` in **Platform → Memory** is 30 days out — not empty.
8. Sign in as an ordinary employee, open **Memory** from the Chat toolbar,
   confirm it shows only their own items, and forget one.
