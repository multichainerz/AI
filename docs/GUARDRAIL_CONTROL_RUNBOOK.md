# Guardrail Control Runbook

OrcaSynapse owns the guardrail policy applied before Chat creates a Hermes run and again when VM2 inference requests cross `/internal/v1`. No separate LiteLLM policy plane is present.

## Policy fields

- maximum input characters;
- maximum output characters;
- block unsafe C0 control characters while allowing normal whitespace;
- block recognizable private-key and common service-token patterns.

These checks are deterministic safeguards, not a semantic safety classifier or complete DLP system. UI and audit language must not claim otherwise.

## Lifecycle

1. Create or edit a draft policy.
2. Exercise representative safety and false-positive cases against that exact version. OrcaSynapse does not record this verification; retain it wherever your change record lives.
3. Activate with an audited reason.
4. Suspend immediately if behavior is unsafe.

Activation requires exactly one enabled, healthy inference connection to be effective, and only one policy can be active at a time. It carries no separate evidence precondition: OrcaSynapse used to demand a promoted `POLICY` evaluation carrying `SAFETY` for the exact `policy:<slug>` and version, and that requirement — along with the Release gates screen that produced it — was removed.

A change to any runtime control (input or output ceiling, control-character or credential blocking, version) returns a policy to draft, so an active policy is always the exact version that was reviewed. The activation reason is retained in the audit trail.

After the first governed policy is activated, missing or suspended policy state fails closed rather than silently returning to an unmanaged default.

## Enforcement

Before inference, OrcaSynapse applies the active policy to user/developer/tool text that can enter the model request. The internal runtime gateway also ignores caller-selected model IDs, caps output tokens, applies PostgreSQL-backed request limits, and keeps upstream inference credentials server-side.

For non-streamed results, OrcaSynapse enforces the output character ceiling before returning content. For streamed results, the proxy enforces a bounded byte ceiling and terminates overflow. Rejections and upstream failures are sanitized; raw credentials, prompts, or provider bodies are not copied into audit metadata.

## Acceptance

Test at least:

- empty, boundary-sized, and oversized input/output;
- tabs/newlines versus disallowed controls;
- recognizable private-key and service-token examples;
- benign strings resembling credentials to measure false positives;
- streaming overflow and cancellation;
- Chat-to-Hermes admission and Hermes inference-gateway requests;
- suspended/missing policy behavior after governance adoption;
- audit content for absence of submitted text and secrets.

If OrcaSynapse later adds a semantic classifier or specialist DLP service, model it as an optional, separately versioned check with explicit timeout/failure behavior. It may narrow a request but cannot grant identity, knowledge, model, or tool access.
