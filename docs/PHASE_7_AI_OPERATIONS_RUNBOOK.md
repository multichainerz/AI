# Phase 7 AI Operations Runbook

## Purpose

This runbook describes the local AI operations and evaluation foundation. It separates controls that are executable in the repository from acceptance work that needs MPM's on-premises endpoints, GPU host, network controls, notification service, and SIEM.

## Operational truth model

AIHub reports three kinds of observations:

- **Live**: read during the request from PostgreSQL or `pg-boss`, including database availability, queues, and worker heartbeats, or produced by enabled scheduled connection monitoring within its explicit freshness window.
- **Last verified**: a retained credential-aware connection result produced manually, while monitoring was disabled, or now overdue. Manually produced passing results become `NOT_VERIFIED` after 15 minutes; an overdue scheduled passing result becomes `NOT_VERIFIED` after two configured intervals, with a minimum window of two minutes.
- **Configuration**: whether a dashboard-managed connection exists and is enabled. Configuration alone is not evidence of availability.

The control room maps component impact to chat, documents, memory, agents, and tools. Domain metrics retain their original time semantics. For example, chat error rate is a 24-hour window, while retained failed agent and tool counts are not presented as live error rates.

## Scheduled connection monitoring

Scheduled checks are disabled by default. An administrator with `connections:write` enables them in Platform connections, selects a cadence, and records an operator reason. The browser receives only the control state; connector credentials remain encrypted and are resolved inside the API for each check.

The API process scans every five seconds and claims at most one enabled connection that is due. PostgreSQL row locks with `SKIP LOCKED`, a unique claim token, and instance ownership prevent two AIHub instances from intentionally checking the same row. A claim becomes recoverable after two minutes if an instance terminates. Configuration edits and rollbacks invalidate health evidence and clear any active claim. Monitoring uses the same bounded, redirect-blocking, credential-aware adapters as a manual connection test.

The control room treats a scheduled result as live only while monitoring remains enabled and the result is no older than twice the configured cadence, with a two-minute minimum. An overdue healthy result becomes `NOT_VERIFIED`; degraded and unreachable results remain visible as the last known state but are no longer labelled live. Disabling monitoring prevents new claims and clears retained leases without deleting diagnostic history.

## Incident lifecycle

Degraded and unavailable component observations create or update one active automated incident per component. A return to a non-degraded state resolves that occurrence. A later recurrence creates a new occurrence rather than rewriting the previous history.

Operators with `operations:execute` can:

1. Raise a manual incident with severity, component, summary, and optional owner.
2. Acknowledge an open incident and assign an owner.
3. Resolve an open or acknowledged incident with an operator note.

Incident changes and actor decisions are written to PostgreSQL and the audit ledger. Use the note for the confirmed cause, mitigation, and follow-up reference. Do not resolve an incident merely to clear the dashboard.

## Evaluation and release gates

An evaluation candidate identifies an immutable target type, reference, version, threshold, and required evidence categories. The supported categories are chat, retrieval, OCR, tool use, safety, and permissions.

The lifecycle is:

1. `DRAFT`: the target and gate definition are fixed.
2. `PASSED` or `FAILED`: category results and evidence references are recorded once. Every required category must be present, each must meet the threshold, and no category may contain a critical failure.
3. `PROMOTED`: a principal with `evaluations:promote` separately accepts a passed candidate and records a mandatory operator rationale.

Completed evidence cannot be edited. Create a new candidate for a rerun. The promotion rationale is retained on both the evaluation record and audit event. PostgreSQL checks reject promoted records with critical failures, an aggregate pass rate below the declared threshold, or a blank rationale.

Hermes agent activation is bound to promoted evidence. For an agent profile with slug `hermes-analyst` and current version `3`, create the candidate with:

- target type: `AGENT`
- target reference: `agent:hermes-analyst`
- target version: `3`

Activation fails closed until a matching promoted candidate exists. Model routes, chat guardrail policies, and chat-system prompts use the same exact-reference gate. Prompt activation additionally requires both `CHAT` and `SAFETY` categories. After the first prompt activation, chat fails closed whenever no governed prompt is active.

## Guardrail posture

The dashboard distinguishes locally enforced application controls from controls requiring target-environment proof:

| Layer | Local posture | Remaining acceptance |
|---|---|---|
| Input | Partial | Activate an evaluated policy, then prove each assigned LiteLLM pre-call hook with representative MPM data |
| Output | Partial when a policy is active | Prove each assigned LiteLLM post-call hook, streaming behavior, and false-positive handling |
| Retrieval | Enforced for private scope | Approve and test shared-scope inheritance rules |
| Model access | Enforced | Validate the real LiteLLM/vLLM routes and capacity controls |
| Tool use | Enforced in the gateway | Complete live Hermes per-run capability interoperability |
| Data egress | Partial | Prove network egress policy, SIEM delivery, and alert delivery |

## API surface

- `GET|PATCH /api/v1/admin/connections/monitoring`
- `GET /api/v1/admin/operations/overview`
- `GET|POST /api/v1/admin/operations/incidents`
- `POST /api/v1/admin/operations/incidents/:id/acknowledge`
- `POST /api/v1/admin/operations/incidents/:id/resolve`
- `GET|POST /api/v1/admin/operations/evaluations`
- `POST /api/v1/admin/operations/evaluations/:id/complete`
- `POST /api/v1/admin/operations/evaluations/:id/promote`
- `GET|POST /api/v1/admin/prompts`
- `PATCH /api/v1/admin/prompts/:id`
- `POST /api/v1/admin/prompts/:id/activate|suspend`
- Existing queue probe and dead-letter recovery routes remain under `/api/v1/admin/operations/jobs`.

## Target-environment acceptance checklist

- Apply migrations through `20260730001500_prompt_templates`, then exercise backup and restore of incidents, evaluation evidence, monitoring controls, leases, model routes, policies, and prompts.
- Export RTX PRO 6000, vLLM, and LiteLLM utilization, saturation, latency, and error metrics through approved on-premises collectors.
- Enable scheduled checks against the approved deployed endpoints and verify cadence, credential rotation, multi-instance exclusion, stale-lease recovery, and freshness transitions.
- Configure notification delivery and verify alert acknowledgement, failure, retry, and escalation.
- Forward incident, guardrail, tool, approval, and evaluation audit events to the MPM SIEM and verify retention.
- Run approved regression datasets for all enabled target categories.
- Demonstrate agent activation rejection without matching promoted evidence and success with exact target/version evidence.
- Demonstrate prompt activation rejection without exact promoted `PROMPT`, `CHAT`, and `SAFETY` evidence; then verify active-version checksum provenance and fail-closed suspension.
- Exercise worker loss, queue backlog, OCR failure, SeaweedFS failure, Supermemory failure, inference saturation, and recovery.
- Record capacity limits and degraded-mode procedures for the RTX PRO 6000 96 GB deployment.
