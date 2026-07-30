# Guardrail Control Runbook

## Purpose

The Guardrails workspace controls which already-configured LiteLLM guardrails AIHub attaches to internal chat requests. PostgreSQL is the policy, lifecycle, evidence, and audit system of record. LiteLLM remains the execution plane for external classifiers and guardrail hooks.

AIHub does not upload classifier credentials, mutate LiteLLM `config.yaml`, or infer the configured hook mode. Configure guardrail providers, endpoints, credentials, and `pre_call` / `post_call` modes in the on-premises LiteLLM deployment. AIHub stores only the approved guardrail names. LiteLLM documents the per-request `guardrails` list at <https://docs.litellm.ai/docs/proxy/guardrails/quick_start>.

## Lifecycle

1. Configure and test the LiteLLM connection in AIHub.
2. Configure the named guardrails in the selected LiteLLM deployment.
3. Create a draft policy in **Guardrails** with an immutable version, ordered guardrail names, and local input-character ceiling.
4. Create an Operations evaluation with:
   - target type `POLICY`;
   - target reference `policy:<policy-slug>`;
   - the exact policy version;
   - `SAFETY` among its required categories.
5. Complete and promote the evaluation with immutable evidence references.
6. Activate the policy with an operator reason.

Activation requires exactly one effective, enabled, healthy LiteLLM chat connection and exact promoted safety evidence. Only one policy can be active.

## Safe adoption and fail-closed behavior

- Draft creation does not change existing chat behavior.
- The first successful activation stores a permanent `firstActivatedAt` marker.
- After that marker exists, chat requires exactly one active policy.
- Suspending the active policy deliberately stops new chat work until an evaluated policy is activated.
- Assignment or input-limit changes require a different version and new promoted evidence.
- Display-name and description corrections do not erase prior evidence.

## Runtime behavior

For each chat message AIHub:

1. resolves the single active policy;
2. rejects input above the policy ceiling before message persistence or inference;
3. passes the policy's ordered names in LiteLLM's request-level `guardrails` field;
4. records the policy ID, version, and assignment count in inference audit metadata;
5. stores local input-limit denials as `guardrail.request_blocked`;
6. stores guarded LiteLLM HTTP 400 responses as `guardrail.inference_rejected` without copying the upstream body.

A guarded HTTP 400 is not presented as proof of a classifier violation because an invalid upstream assignment can produce the same status. Operators must correlate the sanitized AIHub audit with approved LiteLLM guardrail telemetry.

## Administrative API

- `GET /api/v1/admin/guardrails`
- `POST /api/v1/admin/guardrails`
- `PATCH /api/v1/admin/guardrails/:id`
- `POST /api/v1/admin/guardrails/:id/activate`
- `POST /api/v1/admin/guardrails/:id/suspend`

Readers require `guardrails:read`; mutations require `guardrails:manage`. Security administrators manage policies, operations administrators can inspect them, and auditors have read-only access.

## Target-environment acceptance

Before pilot approval, demonstrate:

- every policy name exists on the selected LiteLLM instance;
- intended pre-call and post-call modes are active;
- approved prompt-injection, PII, harmful-content, false-positive, and multilingual cases;
- streaming output behavior for post-call checks;
- safe operator visibility without prompt, response, or credential leakage;
- latency, concurrency, classifier outage, timeout, and recovery behavior;
- exact evaluation evidence and rollback/fail-closed procedures.
