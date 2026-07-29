# Phase 7 AI Operations Runbook

## Purpose

This runbook describes the local AI operations and evaluation foundation. It separates controls that are executable in the repository from acceptance work that needs MPM's on-premises endpoints, GPU host, network controls, notification service, and SIEM.

## Operational truth model

AIHub reports three kinds of observations:

- **Live**: read during the request from PostgreSQL or `pg-boss`, including database availability, queues, and worker heartbeats.
- **Last verified**: the retained result of an administrator-triggered credential-aware connection check. Passing results become `NOT_VERIFIED` after 15 minutes; an old result is never presented as live monitoring.
- **Configuration**: whether a dashboard-managed connection exists and is enabled. Configuration alone is not evidence of availability.

The control room maps component impact to chat, documents, memory, agents, and tools. Domain metrics retain their original time semantics. For example, chat error rate is a 24-hour window, while retained failed agent and tool counts are not presented as live error rates.

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

Activation fails closed until a matching promoted candidate exists. Model, prompt, and policy deployment gates will be bound when those versioned deployment paths are introduced.

## Guardrail posture

The dashboard distinguishes locally enforced application controls from controls requiring target-environment proof:

| Layer | Local posture | Remaining acceptance |
|---|---|---|
| Input | Partial | Connect and evaluate the approved safety classifier |
| Output | Not verified | Validate output classification with representative MPM data |
| Retrieval | Enforced for private scope | Approve and test shared-scope inheritance rules |
| Model access | Enforced | Validate the real LiteLLM/vLLM routes and capacity controls |
| Tool use | Enforced in the gateway | Complete live Hermes per-run capability interoperability |
| Data egress | Partial | Prove network egress policy, SIEM delivery, and alert delivery |

## API surface

- `GET /api/v1/admin/operations/overview`
- `GET|POST /api/v1/admin/operations/incidents`
- `POST /api/v1/admin/operations/incidents/:id/acknowledge`
- `POST /api/v1/admin/operations/incidents/:id/resolve`
- `GET|POST /api/v1/admin/operations/evaluations`
- `POST /api/v1/admin/operations/evaluations/:id/complete`
- `POST /api/v1/admin/operations/evaluations/:id/promote`
- Existing queue probe and dead-letter recovery routes remain under `/api/v1/admin/operations/jobs`.

## Target-environment acceptance checklist

- Apply migration `20260730000900_ai_operations` and exercise backup and restore of incidents and evaluation evidence.
- Export RTX PRO 6000, vLLM, and LiteLLM utilization, saturation, latency, and error metrics through approved on-premises collectors.
- Add scheduled credential-aware probes with bounded frequency and an explicit freshness policy.
- Configure notification delivery and verify alert acknowledgement, failure, retry, and escalation.
- Forward incident, guardrail, tool, approval, and evaluation audit events to the MPM SIEM and verify retention.
- Run approved regression datasets for all enabled target categories.
- Demonstrate agent activation rejection without matching promoted evidence and success with exact target/version evidence.
- Exercise worker loss, queue backlog, OCR failure, SeaweedFS failure, Supermemory failure, inference saturation, and recovery.
- Record capacity limits and degraded-mode procedures for the RTX PRO 6000 96 GB deployment.
