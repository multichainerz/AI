# Prompt Control Runbook

## What this subsystem does today

**Read this section before anything else: the active prompt is not sent to a
model.** Prompt Control is a versioned, audited register of reviewed system
instructions. It is not, at this release, in the chat path.

The complete set of code that reads the `PromptTemplate` table:

| Reader | What it does |
| --- | --- |
| `apps/api/src/prompts/routes.ts` + `drizzle-prompt-manager.ts` | the four admin REST routes and their lifecycle rules |
| `apps/api/src/ai-ops/drizzle-ai-ops-manager.ts` | renders the active row as one read-only status tile in the Operations overview |
| `apps/web/src/api.ts` | the dashboard's client for those routes |

Nothing under `apps/api/src/chat/` or `apps/worker/src/` references it. The
system text for a run is assembled by `hardenedInstructions()` in
`apps/worker/src/agent-processor.ts` from the agent profile's `soulMd` and
`instructions` plus a hardcoded execution-boundary block, and that is the only
system instruction any model receives. There is no built-in chat system prompt
constant anywhere in the repository either.

This document previously said the active prompt was "used as the first system
message for new chat requests", that activation "permanently enables governed
mode", and that suspending it "makes chat fail closed". None of that was ever
implemented, and an operator following the old acceptance checklist would have
concluded from step 6 — suspend, observe chat still working — that something was
broken. The fail-closed behaviour it described belongs to **guardrails**
(`apps/api/src/chat/drizzle-chat-manager.ts`, which refuses chat with "Activate
one guardrail policy before using Chat." once a policy has ever been active);
prompts have no equivalent.

Governing a prompt here therefore records a decision. It does not enforce one.

## Purpose and boundary

Prompt Control is intended to govern the system instruction used by the direct
OrcaSynapse chat runtime. It does not replace an agent profile's separately
versioned Hermes instruction, configure the inference server, or allow prompt
text to grant infrastructure, MCP, tool, memory, or data-access permissions.

PostgreSQL is the source of truth for prompt content, lifecycle, operator decisions, and audit provenance. Prompt content must not contain credentials or secret values. Service keys and endpoints remain in OrcaSynapse's encrypted credential store.

## Lifecycle

Each prompt has a stable slug, purpose, operator description, version, content, SHA-256 checksum, optimistic revision, and status:

- `DRAFT`: editable.
- `ACTIVE`: not editable in place — suspend it first.
- `SUSPENDED`: retained.

Only one `CHAT_SYSTEM` prompt can be active; activating a second is refused by
name until the first is suspended. A content change requires a new version and
returns the record to `DRAFT`, so an active prompt is always the exact version
that was reviewed.

Activation carries no evidence precondition. OrcaSynapse used to demand a
promoted `PROMPT` evaluation carrying `CHAT` and `SAFETY` for the exact
`prompt:<slug>` and version; that requirement, the Release gates screen that
produced it, and the whole evaluation subsystem behind it were removed. The only
checks activation performs are that the record is not already active and that no
other prompt of the same purpose is.

## Provenance

The checksum establishes exact-content provenance; it is not a signature or a
proof of behavioural quality. Lifecycle audit events (`prompt.template_created`,
`_updated`, `_activated`, `_suspended`) retain the identifier, version and
operator reason rather than copying the prompt body. **Per-request** audit does
not reference a prompt, because no request resolves one.

Prompt text never expands authorization. Identity scopes, local retrieval reauthorization, agent profiles, MCP grants, approvals, model routes, and guardrail policies remain independent enforcement layers.

## API and access

- `GET|POST /api/v1/admin/prompts`
- `PATCH /api/v1/admin/prompts/:id`
- `POST /api/v1/admin/prompts/:id/activate`
- `POST /api/v1/admin/prompts/:id/suspend`

`prompts:read` permits inspection. `prompts:manage` permits lifecycle changes. Platform and Security administrators can manage prompts; Operations administrators and Auditors have read-only access.

## Acceptance checklist

Scoped to what the subsystem actually does. Steps that asserted runtime effects
have been removed rather than reworded: there is no chat behaviour to observe.

1. Confirm migrations are current (`PromptTemplate` ships in the Drizzle baseline; the compose `migrate` service applies it on every start).
2. Create the approved draft without secrets and review its displayed checksum.
3. Activate the prompt and confirm Operations shows the version and checksum prefix without prompt content.
4. Confirm a second prompt of the same purpose cannot be activated while the first is active.
5. Confirm editing the active prompt is refused until it is suspended, and that saving changed content requires a new version and returns the record to `DRAFT`.
6. Confirm the audit trail carries `prompt.template_activated` with the version and the operator reason.

## Making it real

If the intent is for the active prompt to govern chat, the missing work is
concrete and worth stating so nobody re-derives it from this document: resolve
the active `CHAT_SYSTEM` row where the run's system text is assembled
(`apps/worker/src/agent-processor.ts`), decide its precedence against the
profile's `soulMd`/`instructions`, and add a fail-closed check in
`apps/api/src/chat/drizzle-chat-manager.ts` alongside the guardrail one so a
missing or ambiguous active prompt refuses chat rather than silently doing
nothing. Until all three exist, treat this screen as a register.
