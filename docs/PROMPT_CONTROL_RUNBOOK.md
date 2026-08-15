# Prompt Control Runbook

## Purpose and boundary

OrcaSynapse Prompt Control governs the system instruction used by the direct OrcaSynapse chat runtime. It does not replace an agent profile's separately versioned Hermes instruction, configure the inference server, or allow prompt text to grant infrastructure, MCP, tool, memory, or data-access permissions.

PostgreSQL is the source of truth for prompt content, lifecycle, operator decisions, and audit provenance. Prompt content must not contain credentials or secret values. Service keys and endpoints remain in OrcaSynapse's encrypted credential store.

## Lifecycle

Each prompt has a stable slug, purpose, operator description, version, content, SHA-256 checksum, optimistic revision, and status:

- `DRAFT`: editable and never used by runtime chat.
- `ACTIVE`: immutable and used as the first system message for new chat requests.
- `SUSPENDED`: retained but not used.

Only one `CHAT_SYSTEM` prompt can be active. Content or version changes return the prompt to draft, so an active prompt is always the exact version that was reviewed. Suspend an active prompt before changing it.

Activation carries no separate evidence precondition: OrcaSynapse used to demand a promoted `PROMPT` evaluation carrying `CHAT` and `SAFETY` for the exact `prompt:<slug>` and version, and that requirement — along with the Release gates screen that produced it — was removed. Verify representative behavior against the exact version before activating; OrcaSynapse does not record that verification.

## Safe adoption and runtime behavior

Before any prompt has ever been activated, chat uses the built-in system instruction for backward-compatible adoption. The first successful activation permanently enables governed mode. From then on, no active prompt, more than one active prompt, or an inconsistent record makes chat fail closed before model or guardrail resolution.

OrcaSynapse places the active prompt before approved retrieval context and conversation history. Runtime audit events retain the prompt identifier, version, and checksum rather than copying the prompt body. The checksum establishes exact-content provenance; it is not a signature or proof of behavioral quality.

Prompt instructions never expand authorization. Identity scopes, local retrieval reauthorization, agent profiles, MCP grants, approvals, model routes, and guardrail policies remain independent enforcement layers.

## API and access

- `GET|POST /api/v1/admin/prompts`
- `PATCH /api/v1/admin/prompts/:id`
- `POST /api/v1/admin/prompts/:id/activate`
- `POST /api/v1/admin/prompts/:id/suspend`

`prompts:read` permits inspection. `prompts:manage` permits lifecycle changes. Platform and Security administrators can manage prompts; Operations administrators and Auditors have read-only access.

## Acceptance checklist

1. Confirm migrations are current (`PromptTemplate` ships in the Drizzle baseline; the compose `migrate` service applies it on every start).
2. Create the approved draft without secrets and review its displayed checksum.
3. Activate the prompt and confirm Operations shows the version and checksum prefix without prompt content.
4. Exercise representative chat, prompt-injection, private-data, uncertainty, retrieval-context, and streaming cases against the deployed model and guardrails.
5. Confirm request and completion audits reference the exact prompt ID, version, and checksum.
6. Suspend the prompt and confirm chat fails closed; reactivate only after the recorded recovery decision.
