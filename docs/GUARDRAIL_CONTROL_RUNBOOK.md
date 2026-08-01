# Guardrail Control Runbook

AIHub owns the guardrail policy applied to direct Chat and to runtime requests crossing `/internal/v1`. No separate LiteLLM policy plane is present.

## Policy fields

- maximum input characters;
- maximum output characters;
- block unsafe C0 control characters while allowing normal whitespace;
- block recognizable private-key and common service-token patterns.

These checks are deterministic safeguards, not a semantic safety classifier or complete DLP system. UI and audit language must not claim otherwise.

## Lifecycle

1. Create or edit a draft policy.
2. Run representative safety and false-positive evaluations.
3. Promote exact `POLICY` evidence for that candidate/version.
4. Activate with an audited reason.
5. Suspend immediately if behavior is unsafe.

After the first governed policy is activated, missing or suspended policy state fails closed rather than silently returning to an unmanaged default.

## Enforcement

Before inference, AIHub applies the active policy to user/developer/tool text that can enter the model request. The internal runtime gateway also ignores caller-selected model IDs, caps output tokens, applies PostgreSQL-backed request limits, and keeps vLLM credentials server-side.

For non-streamed results, AIHub enforces the output character ceiling before returning content. For streamed results, the proxy enforces a bounded byte ceiling and terminates overflow. Rejections and upstream failures are sanitized; raw credentials, prompts, or provider bodies are not copied into audit metadata.

## Acceptance

Test at least:

- empty, boundary-sized, and oversized input/output;
- tabs/newlines versus disallowed controls;
- recognizable private-key and service-token examples;
- benign strings resembling credentials to measure false positives;
- streaming overflow and cancellation;
- direct Chat and Hermes/Supermemory gateway requests;
- suspended/missing policy behavior after governance adoption;
- audit content for absence of submitted text and secrets.

If MPM later adds a semantic classifier or specialist DLP service, model it as an optional, separately versioned check with explicit timeout/failure behavior. It may narrow a request but cannot grant identity, knowledge, model, or tool access.
