# Guardrail Control Runbook

OrcaSynapse owns the guardrail policy applied on every path that reaches a model: before Chat creates a Hermes run, before a run submitted directly to `POST /api/v1/agents/runs` is queued, and when VM2 inference requests cross `/internal/v1`. No separate LiteLLM policy plane is present.

**Guardrails inspect input only.** Response length is capped by `maxOutputCharacters`; response *content* is never examined. The Guardrails screen states this, and UI, audit and documentation language must not imply otherwise.

## Policy fields

Four settings, applied first and in this order:

- maximum input characters;
- maximum output characters;
- block unsafe C0 control characters while allowing normal whitespace;
- block recognizable private-key and common service-token patterns.

## Rules

A policy then carries up to 100 operator-authored rules. Each has a label, a pattern, an action, a case-sensitivity flag and an enable flag.

| Match | Behaviour |
| --- | --- |
| `WORD` | whole word only — `cat` does not match `concatenate` |
| `PHRASE` | exact text, tolerating a line break where a space was typed |
| `PREFIX` | the start of a word — `sk-` matches `sk-abc`, not `risk-averse` |
| `REGEX` | a regular expression, admitted only after the safety gate below |

| Action | Behaviour |
| --- | --- |
| `BLOCK` | refuse the request; a block anywhere wins over every redaction |
| `REDACT` | replace the match with `[redacted]` and send the rest |
| `FLAG` | allow it through unchanged and record it |

Use `FLAG` to measure a new rule against live traffic before trusting it to refuse anything. A rule switched straight to `BLOCK` on a guess is how a guardrail becomes an outage.

Redaction rewrites the text everywhere it is read, not only where it is stored — in Chat that includes the conversation title, the stored message and the input handed to the run.

### The regex safety gate

`WORD`, `PHRASE` and `PREFIX` escape the operator's text, so a catastrophic pattern is impossible by construction. `REGEX` is checked at save time and refused if it contains a backreference, a lookahead or lookbehind, or a quantifier applied to a group that already repeats (`(a+)+`), or if it exceeds 200 characters or is measurably slow against a short probe. The refusal names which of those it was.

This is static analysis plus a probe, not a sandbox: a pattern that passes both and is still slow on production input remains possible. `assertPatternIsSafe` in `apps/api/src/guardrails/rule-compiler.ts` records the residual risk and the worker-thread pool that was considered and declined.

These checks are deterministic safeguards, not a semantic safety classifier or complete DLP system. UI and audit language must not claim otherwise.

## Lifecycle

1. Create or edit a draft policy.
2. Exercise representative safety and false-positive cases against that exact version. OrcaSynapse does not record this verification; retain it wherever your change record lives.
3. Activate with an audited reason.
4. Suspend immediately if behavior is unsafe.

Activation requires exactly one enabled, healthy inference connection to be effective, and only one policy can be active at a time. It carries no separate evidence precondition: OrcaSynapse used to demand a promoted `POLICY` evaluation carrying `SAFETY` for the exact `policy:<slug>` and version, and that requirement — along with the Release gates screen that produced it — was removed.

A change to any runtime control — input or output ceiling, control-character or credential blocking, **any rule**, version — returns a policy to draft, so an active policy is always the exact version that was reviewed. Rules are held to this deliberately: they are enforceable settings, and a rule that could be edited in place would make "the rules a run enforced are attributable to a named version" false for the part an operator edits most. The activation reason is retained in the audit trail.

After the first governed policy is activated, missing or suspended policy state fails closed rather than silently returning to an unmanaged default.

## Enforcement

Before inference, OrcaSynapse applies the active policy to user/developer/tool text that can enter the model request, on all three submission paths. The internal runtime gateway also ignores caller-selected model IDs, caps output tokens, applies PostgreSQL-backed request limits, and keeps upstream inference credentials server-side.

Blocks, redactions and flags are audited by rule label and count. The matched text is never recorded: a credential rule fires precisely because the input looked like a key, and quoting it to explain the refusal would place that key in a retained, SIEM-forwarded trail.

`tools`, `tool_calls`, `response_format` and `chat_template_kwargs` on a runtime gateway request are free-form objects bounded only by the 1 MiB body limit and are **not** inspected. They remain the one uninspected channel into the model.

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
