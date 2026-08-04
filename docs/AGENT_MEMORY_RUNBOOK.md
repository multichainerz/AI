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
| `LEARN_USER` | documents + memory | what the person says | A personal assistant that accumulates someone's stable facts and preferences. |
| `LEARN_EXCHANGE` | documents + memory | both sides of the turn | Richest recall, accepting that the model's own output becomes durable memory. |

**`LEARN_USER` never stores model output.** That is the point of the split: an
answer the model got wrong once would otherwise be retrieved by later runs and
treated as an established fact about the person. `LEARN_EXCHANGE` opts into that
trade deliberately.

Model-distilled capture (a second inference call summarizing each exchange) is
deliberately not implemented. It needs its own prompt, its own governance, and
its own failure mode.

## The installation ceiling

**Platform → Memory** holds one policy that bounds every agent at once. A
profile can be narrower than the ceiling but never wider, so
`maximumCaptureMode: RECALL_ONLY` stops all capture fleet-wide without editing a
single profile — the action you need when the answer to "stop storing things
about people" has to take effect now.

The ceiling is read **at capture time**, not at submission, so suspending it
also applies to runs already in flight.

| Field | Meaning |
| --- | --- |
| `maximumCaptureMode` | The most any agent may store. |
| `retentionDays` | How long a captured item survives. Null keeps it until deleted. |
| `maximumItemsPerOwner` | Cap per person per agent; the oldest beyond it are trimmed. |
| `recallLimit` / `recallMinimumScore` | How many memories a run may recall, and the similarity floor below which a hit is noise. |

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

Filter **Platform → Memory** by the person's subject to see every item, which
agent recorded it, when, and when it expires. Deleting one, or purging everything
for a person, requires a reason and is audited.

An owner deleting their own memory is scoped by the same SQL predicate as
retrieval, so a stray identifier can never reach another person's records.

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
2. Set a profile to `LEARN_USER`, run a turn, and confirm the person's message
   is stored and the model's answer is not.
3. Activate a policy with `maximumCaptureMode: RECALL_ONLY` and confirm that the
   same profile stops capturing while still recalling.
4. Confirm an expired item stops being recalled, and disappears on the next
   capture for that person.
5. Delete one item and purge one person; confirm both appear in the audit trail
   with their reasons and neither carries the content.
6. Confirm a second policy cannot be activated while one is already active.
