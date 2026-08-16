# OpenRouter as an inference route: mostly configuration, and one sentence that becomes false

Status: **plan, not started.** Written at v8.8.6
(`packages/contracts/src/version.ts:1`). Every claim below was measured against
the tree and against the live OpenRouter API on 2026-08-17, not recalled. The
OpenRouter facts in particular change often enough that prior knowledge was
treated as worthless and re-probed.

Every `file:line` citation was re-checked against the tree after v8.8.6 landed.
None of the files this plan cites are touched by that release except
`scripts/install-agentic-node.sh`, whose cited line was re-verified unchanged.

**The headline is that this already works.** A customer can route inference
through OpenRouter today with no code change, using the existing
`CUSTOM_OPENAI_COMPATIBLE` backend and four configuration fields. The exact
values are in [What a customer types today](#what-a-customer-types-today), and
they were executed against the real adapter, not reasoned about.

What does not work is everything around it: discovery recommends a configuration
that cannot work, the connection test reports `HEALTHY` **and the word
"authenticated"** for a connection with no credential at all, and only the first
50 of OpenRouter's 413 models can be activated. None of those block a pilot with
a hand-written configuration. All of them will be found by the first customer who
uses the wizard instead of the runbook.

And one thing that is not a technical problem at all: the default agent prompt
tells every user *"Nothing you receive or produce leaves this environment."*
Routing through OpenRouter makes that sentence a lie. That is
[increment F](#f--name-the-trade-on-the-screen), it is the largest piece of work
here, and it is the reason this plan exists rather than a one-line runbook entry.

---

## What was measured, and how

Four probes, all read-only, none of which wrote to the repo:

1. **`GET https://openrouter.ai/api/v1/models`** — 200, 677 KB, 413 models.
   Parsed for shape, id syntax, and token limits.
2. **The real `endpointUrl` and the real contract schemas**, imported from
   `apps/api/src/connections/diagnostics/http.ts` and
   `packages/contracts/src/{connections,models}.ts` and executed under `tsx`.
3. **The real `InferenceDiscoveryService`**, constructed with no store and run
   against `https://openrouter.ai` with live `fetch`.
4. **The real `OpenAICompatibleAdapter.test()`**, run against
   `https://openrouter.ai` with four different configurations.

Probes 2–4 were mutation-checked before their results were believed, per the
standing protocol. `endpointUrl` was confirmed to reject
`https://169.254.169.254` and `ftp://openrouter.ai` — so "it does not block
openrouter.ai" is a real finding and not a guard that never fires. The 50-model
cap was confirmed by testing two *adjacent real models* either side of the
boundary rather than one model and a guess.

---

## The OpenRouter facts, with citations

Re-established from the vendor's own documentation and its live API. Where the
documentation and the API disagree, the API wins and the disagreement is noted.

### Authentication

`Authorization: Bearer <OPENROUTER_API_KEY>`. Identical to OpenAI, identical to
what `inference-gateway.ts:390` already emits.

**The attribution headers are not required for the API to function**, and the
documentation is internally inconsistent about their status. The
[quickstart](https://openrouter.ai/docs/quickstart) marks both as optional; the
[app-attribution page](https://openrouter.ai/docs/app-attribution) labels
`HTTP-Referer` **required** but states the only consequence of omitting it as
"no app page will be created and your usage will not appear in rankings". That
is a ranking consequence, not an access one. Nothing in either page ties them to
billing, rate limits, or free-model access.

**The header has been renamed.** It is now `X-OpenRouter-Title`, not `X-Title`;
`X-Title` is retained for backwards compatibility. There is also a third,
`X-OpenRouter-Categories`. Anyone writing this from memory will write `X-Title`
and be a version behind — I did, and had to correct it.

*Confirmed:* omitting all attribution headers costs nothing operationally. For
an on-premise product whose customers do not want their deployment appearing on
a public leaderboard, **not** sending them is arguably the correct default.

### The models endpoint — and why it is not OpenAI's

`GET /api/v1/models`, public, **no authentication required** (measured: 200
without any key). This last fact drives [increment B](#b--make-healthy-mean-the-key-works).

The top level is **not** OpenAI's `{"object": "list", "data": [...]}`. It is:

```json
{ "data": [ ... ], "total_count": 413, "links": { "next": null } }
```

Individual model objects carry **no `object` field** and no `owned_by`. They
carry `id`, `canonical_slug`, `hugging_face_id`, `name`, `created`,
`description`, `context_length`, `architecture`, `pricing`, `top_provider`,
`per_request_limits`, `supported_parameters`, `default_parameters`,
`supported_voices`, `knowledge_cutoff`, `expiration_date`, `links`, `reasoning`.

This matters less than it looks, and the reason is worth recording: **both of
this product's model parsers read `payload.data`, pick the first string among
`id` / `model` / `name`, and ignore everything else.** Neither checks
`object: "list"`, neither requires `owned_by`, and extra fields are tolerated.
See `inference-discovery-service.ts:54-66` and
`openai-compatible-adapter.ts:21-32`. OpenRouter's divergence from OpenAI's
envelope is therefore invisible to both. That is a genuine, if accidental,
robustness win.

**Context window and max output are discoverable per model** — this was an open
question in the brief and the answer is a qualified yes:

| Field | Availability | Source |
| --- | --- | --- |
| `context_length` | **413 of 413** models | top-level |
| `top_provider.max_completion_tokens` | **364 of 413** models | 49 have `null` |

So `contextWindowTokens` is always derivable; `maxOutputTokens` is derivable
88% of the time and needs a fallback for the rest.

### Model identifiers

`vendor/model` slugs. Measured across all 413: the only non-alphanumeric
characters used are `/` (every id), `-`, `.`, `:` (78 ids, the `:free` and
`:batch` variants), and `~` (11 ids).

**The `~` is new and it breaks this product's regex.** Eleven "floating" aliases
— `~openai/gpt-latest`, `~anthropic/claude-opus-latest`,
`~google/gemini-pro-latest` and eight siblings — resolve to whatever the vendor
currently ships. All eleven **fail** `modelAliasSchema`
(`packages/contracts/src/connections.ts:59-63` and
`packages/contracts/src/models.ts:13-14`), which requires
`^[A-Za-z0-9][A-Za-z0-9._:/-]*$` — a leading `~` is not an alphanumeric.
Measured: `createModelDeploymentSchema` rejects `~openai/gpt-latest` on the
`modelAlias` path and accepts `anthropic/claude-opus-5`,
`openai/gpt-5.6-luna`, and `liquid/lfm-2.5-2.6b:free`.

402 of 413 usable, 11 not. See [increment D](#d--admit-the-floating-aliases).

### Chat completions

`POST /api/v1/chat/completions`. Follows OpenAI closely.

- **Streaming** is SSE via `stream: true`, supported for *all* models.
- **`usage`** is always returned for non-streaming, and returned exactly once in
  the final chunk before `[DONE]` when streaming. `stream_options:
  {include_usage: true}` — which `inference-gateway.ts:378-380` already sends —
  is compatible.
- **Unsupported parameters are ignored, not rejected.** Quoting the API
  reference: "If the chosen model doesn't support a request parameter (such as
  `logit_bias` in non-OpenAI models, or `top_k` for OpenAI), then the parameter
  is ignored."

That last point retires a worry before it starts:
`compatibilityHintsFor(backend)` at `inference-gateway.ts:110-113` strips
`reasoning_effort` and `stream_options` **only for `LLAMA_CPP`**, and returns an
empty set for `CUSTOM_OPENAI_COMPATIBLE`. Since OpenRouter ignores rather than
rejects, the empty set is correct and no new branch is needed.

**The `max_completion_tokens` → `max_tokens` rewrite at
`inference-gateway.ts:363-368` is the right direction for OpenRouter**, and this
is measurable rather than assumed. Across the 413 models' `supported_parameters`:

- `max_tokens` — supported by **402**
- `max_completion_tokens` — supported by **53**

Rewriting toward `max_tokens` moves from the rarer form to the near-universal
one. This code was written for vLLM and happens to be exactly right here.

### Errors, rate limits, credit exhaustion, provider failure

Error shape, confirmed live against an unauthenticated POST:

```json
{"error":{"message":"No cookie auth credentials found","code":401}}
```

with HTTP 401. The documented type is
`{ error: { code: number; message: string; metadata?: Record<string, unknown> } }`.

| Status | Meaning |
| --- | --- |
| 400 | invalid or missing params |
| 401 | invalid credentials |
| **402** | **insufficient credits** — add credits and retry |
| 408 | request timed out |
| **429** | **rate limited** — carries `Retry-After` |
| **502** | **chosen model is down, or returned an invalid response** |
| **503** | **no provider meets your routing requirements** — carries `Retry-After` |

**Downstream provider failure versus OpenRouter's own** is the important
distinction and it splits on timing:

- **Pre-stream**, OpenRouter can silently fail over to another provider serving
  the same model, or return a proper HTTP status. The caller may never learn a
  provider failed.
- **Mid-stream**, it cannot — partial content is already delivered. The failure
  arrives as an SSE event with `finish_reason: "error"` inside a response that
  already returned HTTP 200.

That second case is not handled anywhere in this product and cannot be, because
the gateway never parses the body. Recorded as a known limitation in
[what this does not do](#what-this-does-not-do); it is a genuine behaviour
difference from a local vLLM, which has no notion of a fallback provider.

Rate-limit responses carry `X-RateLimit-Limit`, `-Remaining`, `-Reset`. Free
models (ids ending `:free`) are capped at 20 requests/minute and 50/day under
$10 lifetime spend, 1000/day above it.

### Data policy — the part that decides the positioning

Two layers, and they must not be conflated.

**Downstream providers** each have their own retention and training policies.
The controls OpenRouter offers over them are real and per-request, nested under
a `provider` key in the request body:

| Field | Effect |
| --- | --- |
| `data_collection: "deny"` | refuse providers that may store data non-transiently |
| `zdr: true` | restrict routing to Zero Data Retention endpoints only |
| `only: [...]` / `ignore: [...]` / `order: [...]` | pin or exclude providers by slug |
| `allow_fallbacks: false` | do not silently substitute a provider |

There is an account-level equivalent: "If you opt out of training in your
account settings, OpenRouter will not route to providers that train." A
`GET /api/v1/endpoints/zdr` endpoint exists to enumerate ZDR endpoints.

**OpenRouter itself is a separate question, and its own documentation does not
answer it on that page.** The privacy-and-logging page says only, of the
provider-level filter: "This setting has no bearing on OpenRouter's own policies
and what we do with your prompts." It does not state what OpenRouter retains by
default, and I could not find a page that does.

*This is an assumption boundary, stated rather than papered over:* **the plan
assumes nothing about OpenRouter's own retention.** Any customer-facing claim
must come from OpenRouter's commercial terms or a signed DPA, not from this
document and not from their public docs. Enterprise in-region processing exists
(`eu.openrouter.ai`, `us.openrouter.ai`) and is the lever a regulated customer
would actually pull.

The operational consequence is [increment E](#e--let-the-provider-block-through):
the gateway's request body is built from a `.strict()` contract
(`packages/contracts/src/inference-gateway.ts:14-36`), so **there is currently
no way to send `provider: {zdr: true}` at all.** The one control that makes a
remote route defensible to a regulated customer is unreachable today.

---

## What already works, unchanged

This section is the useful half of the answer. Everything here was measured.

**The SSRF guard does not block OpenRouter.** `assertRoutableDestination`
(`apps/api/src/connections/diagnostics/http.ts:73-81`) blocks exactly two
things: link-local IPv4 `169.254.x.x` and link-local IPv6 `fe[89ab]x:`. RFC1918
and loopback are deliberately allowed, with a comment at `http.ts:60-72`
explaining why (the primary use case *is* a private inference server). There is
no allowlist, no denylist, and no DNS resolution. Public hosts pass. Measured:
`endpointUrl("https://openrouter.ai", "/api/v1/chat/completions")` returns
cleanly, while `https://169.254.169.254` and `ftp://openrouter.ai` both throw.

**The bearer key path is already exactly OpenRouter's shape.**
`inference-gateway.ts:390` emits
`authorization: Bearer ${runtime.connection.secrets.apiKey}`. Stored under
`secrets.apiKey`, encrypted with AES-256-GCM envelope encryption
(`packages/security/src/envelope-encryption.ts:7-9, 74-93`): a fresh 32-byte DEK
per value, wrapped under a master key read from `/run/secrets/orcasynapse_master_key`,
with the value's AAD bound to `${connectionId}:${fieldName}` so a sealed key
cannot be moved between connections. Nothing about storing an OpenRouter key
differs from storing a vLLM key.

One trap worth naming: the runtime path reads **only** `secrets.apiKey`, while
diagnostics' `bearerHeaders` (`http.ts:99-102`) falls back to
`secrets.bearerToken`. A connection storing only `bearerToken` passes discovery
and the connection test, then sends **no** `authorization` header at inference
time. Not OpenRouter-specific, but it will bite whoever configures this.

**The guardrails still run, and they run before the outbound call.** Confirmed:
`inference-gateway.ts:351-358` calls `inspectInputText` on every message, and
the outbound `fetch` is at `:396`. Ordering is authenticate → resolve → **inspect**
→ rate-limit → build → send. Nothing reaches OpenRouter if inspection trips.

What that actually covers, from `apps/api/src/guardrails/runtime-policy.ts`
(31 lines, three checks):

| Covered | Not covered |
| --- | --- |
| input length vs `maxInputCharacters` | any PII detection — no email, phone, SSN, card patterns |
| C0 control characters and DEL | prompt injection or jailbreak detection |
| four credential regexes: PEM private key, `AKIA…`, `gh[oprsu]_…`, `xox[baprs]-…` | topic or keyword blocklists |
| | toxicity or safety classification |
| | **any output inspection whatsoever** |

Two precision points that matter more when the model is remote than when it is
on the same rack:

1. **Output is never inspected.** `RuntimeTextPolicy.maxOutputCharacters` exists
   but is structurally excluded from `inspectInputText`'s parameter type. The
   only thing done to responses is byte-counting and truncation. The product
   already says so in its own compliance copy
   (`apps/api/src/ai-ops/drizzle-ai-ops-manager.ts:152`): "semantic output
   classification is not claimed."
2. **Non-string message content bypasses all three checks.** `messageText`
   (`inference-gateway.ts:79-82`) returns `""` for anything that is not a plain
   string, and `:353` skips empty text. A structured or multimodal content array
   is forwarded to the upstream unexamined. On a local vLLM that is a contained
   problem. Sending it to a third party is a different risk, and it is the one
   thing in this section I would fix before a remote route ships to a regulated
   customer.

So: **input inspection still applies, exactly as before, and it is a
length/control-character/credential filter — not a data-loss-prevention
control.** A user can paste a customer list into the chat box and it will reach
OpenRouter. Naming that plainly is part of increment F.

**The `max_completion_tokens` rewrite, the compatibility hints, and
`stream_options`** all behave correctly against OpenRouter for the reasons given
above. No change.

**The model-id regex accepts 402 of 413 ids.** No change needed for the ones
customers will actually pick.

---

## What a customer types today

Measured end to end against the real schemas and the real adapter. This
configuration produces `HEALTHY`.

| Field | Value |
| --- | --- |
| Kind | `INFERENCE` |
| Base URL | `https://openrouter.ai` |
| `inferenceBackend` | `CUSTOM_OPENAI_COMPATIBLE` |
| `chatPath` | `/api/v1/chat/completions` |
| `modelsPath` | `/api/v1/models` |
| `healthPath` | `/api/v1/models` |
| `modelAlias` | e.g. `anthropic/claude-opus-5` |
| `maxOutputTokens` | ≤ `32768` (connection-level cap) |
| `inferenceTimeoutMs` | `300000` |
| `requestsPerMinute` | ≤ `120` (contract cap) |
| Secret `apiKey` | the OpenRouter key |

**The base URL must be the bare origin, and the `/api/v1` prefix must live in
the paths.** This is the single non-obvious step and it has a specific cause:
`endpointUrl` joins with `new URL(path, \`${base.origin}/\`)`
(`http.ts:94`) — `base.origin` **discards any path component of the base URL**.

> *Superseded reasoning, kept because it is the mistake anyone will make.* I
> first assumed the natural configuration was `baseUrl:
> https://openrouter.ai/api/v1` with the default `chatPath:
> /v1/chat/completions`, matching how every OpenAI SDK is configured. Measured,
> that resolves to `https://openrouter.ai/v1/chat/completions` — the `/api/v1`
> is silently dropped and the `/v1` lands at the root. It does not 404 in a
> useful way either, because openrouter.ai is an SPA that returns 200 HTML for
> unknown paths. The naive configuration fails *quietly*, which is why
> increment A is worth doing rather than documenting around.

Then a model deployment, which requires four fields by hand
(`packages/contracts/src/models.ts:65-80`): `version`, `contextWindowTokens`,
`maxOutputTokens`, `maxConcurrentRequests`. None are auto-populated — the
discovery result contract carries no token fields at all
(`connections.ts:269-286`). For `anthropic/claude-opus-5` the correct values are
`contextWindowTokens: 1000000` and `maxOutputTokens: 128000`, both readable from
`/api/v1/models` and both currently typed from a browser tab.

**And here is the caveat that makes this a pilot configuration rather than a
product:** `modelAlias` must be among the **first 50** models OpenRouter returns.
See increment C.

---

## The increments

### A — make discovery tell the truth about a hosted provider

*No schema. Ships alone.*

Run against `https://openrouter.ai`, the real `InferenceDiscoveryService`
returns **all eleven probes `PASSED`**, zero models, status `PARTIAL`, and this
recommendation:

```json
{"baseUrl":"https://openrouter.ai","inferenceBackend":"CUSTOM_OPENAI_COMPATIBLE",
 "healthPath":"/health","modelsPath":"/v1/models",
 "chatPath":"/v1/chat/completions","modelAlias":null}
```

Every path in that recommendation is wrong, and the operator is looking at a
wall of green while being told so. The cause is at
`inference-discovery-service.ts:190-214`: a probe passes on `response.ok` and a
non-rejecting payload, and `jsonPayload` yields `null` for a non-JSON body
rather than failing. openrouter.ai answers 200 with an HTML shell for
`/health`, `/props`, `/version`, `/get_server_info`, `/info` and every other
probed path — measured, all eleven return 200.

The fix is small and it is not OpenRouter-specific: **a probe that returns 200
with a body that is not JSON has not passed.** That single change turns all
eleven green ticks into honest failures for any SPA or reverse proxy sitting
where an inference server was expected, which is a much more common
misconfiguration than OpenRouter.

Second, `normalizeBaseUrl` (`:35-38`) returns `url.origin`, discarding a
path the operator typed. Since `endpointUrl` will discard it later anyway,
discovery should **say so** rather than silently swallow it — a probe-level note
that the `/api/v1` was moved into the paths, or a second probe sweep at the
typed prefix.

Third, `chatPath` is hardcoded to `/v1/chat/completions` at `:296` and never
probed. For a provider whose API is not at the origin root, the recommendation
is a guess presented as a finding.

**Done when:** discovery against `https://openrouter.ai` reports the non-JSON
probes as FAILED rather than PASSED; discovery against a real vLLM is unchanged
(the regression that matters); a path typed on the base URL is either probed or
reported as relocated, never silently dropped; changing the content-type check
to always-true fails a test. **1–2 days.**

**Files:** `apps/api/src/connections/diagnostics/inference-discovery-service.ts`,
its test.

---

### B — make `HEALTHY` mean the key works

*No schema. Ships alone. This is the one I would do first.*

Measured, against the real `OpenAICompatibleAdapter`:

| Configuration | Result |
| --- | --- |
| correct paths, **no `apiKey` at all** | **`HEALTHY` — "reachable and authenticated"** |
| correct paths, **bogus `apiKey`** | **`HEALTHY` — "reachable and authenticated"** |
| discovery's recommended paths | `DEGRADED` — "invalid models response" |

The message is `openai-compatible-adapter.ts:90` and it says
**"authenticated"**. It is not. OpenRouter's `/api/v1/models` is public, so the
adapter's only authenticated-looking evidence — a 200 from the models path —
proves nothing about the credential.

This is not cosmetic. `HEALTHY` is the activation gate:
`drizzle-model-manager.ts:240-242` refuses to activate a route unless the
connection is `enabled` **and** `status === "HEALTHY"`. So the sequence a
customer hits is: paste a typo'd key → connection goes green and says
"authenticated" → model route activates → **the first real chat turn 502s**,
carrying `"The approved inference server returned status 401"` and no
indication that the key is the problem.

Against a local vLLM this was invisible, because vLLM's `/v1/models` is behind
the same key as everything else. A public catalogue endpoint is what exposes it.

Two things to fix, and they are separable:

1. **Prove the credential.** Probe something that actually requires it —
   `GET /api/v1/key` is the natural choice for OpenRouter and returns credit and
   limit information as a bonus. Generically: any endpoint the operator's
   `chatPath` implies. Absent proof, the status word must not be
   "authenticated".
2. **Stop claiming it.** Even with no new probe, `openai-compatible-adapter.ts:90`
   should not assert authentication it did not test.

**Done when:** a connection to OpenRouter with an absent or invalid `apiKey`
reports something other than `HEALTHY`; a connection with a valid key still
reports `HEALTHY`; a local vLLM with a key is unaffected; deleting the new probe
fails a test. **1–2 days.**

**Files:** `apps/api/src/connections/diagnostics/openai-compatible-adapter.ts`,
its test.

---

### C — lift the 50-model cap

*No schema. Ships alone. This is the hard blocker.*

`discoveredModelIds` at `openai-compatible-adapter.ts:31` ends `.slice(0, 50)`.
Then `:75-81` returns `DEGRADED` when the configured `modelAlias` is not in that
list. OpenRouter returns **413** models. So **363 of them cannot be activated**,
because the connection can never reach `HEALTHY` while pointed at one.

Proven with two adjacent, real models either side of the boundary — not with one
model and an inference:

| Alias | Position | Result |
| --- | --- | --- |
| `openai/gpt-5.6-sol` | index 49, inside the slice | **`HEALTHY`** |
| `x-ai/grok-4.5` | index 51, outside the slice | **`DEGRADED`** — "the configured model alias is unavailable" |

Both exist. The only difference is the cap.

Note the sibling parser has a different cap: `inference-discovery-service.ts:66`
slices to **200**, and its 200 is load-bearing — it matches
`connections.ts:276`'s `.max(200)` on the result contract, so raising it breaks
schema validation. The adapter's 50 has no such justification; nothing in the
contract constrains `details.modelIds`.

The cheap fix is to raise the cap. The correct fix is to stop returning the
whole list in `details` and instead answer the only question being asked —
*is this specific alias present?* — which is O(1) in the response and does not
grow with the catalogue. That also removes a 413-entry array from an audit
payload.

**Done when:** `x-ai/grok-4.5` — or any alias past position 50 — reaches
`HEALTHY`; a genuinely absent alias still reports `DEGRADED`; the connection-test
`details` payload does not grow with catalogue size; reverting the cap fails a
test. **Half a day.**

**Files:** `apps/api/src/connections/diagnostics/openai-compatible-adapter.ts`,
its test.

---

### D — admit the floating aliases

*Contract change, no migration. Ships alone.*

Eleven ids begin with `~` and are rejected by `modelAliasSchema` in **two**
places — `packages/contracts/src/connections.ts:59-63` and
`packages/contracts/src/models.ts:13-14` — plus the runtime mirror `MODEL_ID` at
`inference-discovery-service.ts:28`. All three must move together or discovery
will surface an id the deployment form then refuses.

**This is a judgement call, not an obvious yes.** A `~…-latest` alias means the
underlying model changes without warning. For a governed control plane whose
model deployments carry an immutable `version` string and require a new version
on any material change (`drizzle-model-manager.ts:181-183`), a silently-floating
model is arguably the *opposite* of what the product is for.

**Recommendation: do not do this by default.** Record the eleven as
deliberately unsupported, and say why on screen — "OrcaSynapse pins model
versions; `~vendor/model-latest` aliases change underneath a pinned deployment"
— rather than failing with a regex message about unsupported characters. If a
customer asks for it, the change is three regexes and a test.

**Done when:** selecting a `~` alias produces an explanation, not a validation
error; the three regexes stay in sync, enforced by a test that reads all three.
**Half a day.**

**Files:** `packages/contracts/src/connections.ts`,
`packages/contracts/src/models.ts`,
`apps/api/src/connections/diagnostics/inference-discovery-service.ts`,
`apps/web/src/models-view.tsx`.

---

### E — let the `provider` block through

*Contract change. Depends on nothing; blocks the regulated-customer story.*

`inferenceGatewayChatRequestSchema`
(`packages/contracts/src/inference-gateway.ts:14-36`) is `.strict()`, and
`inference-gateway.ts:371-382` builds the outbound body from the validated input
plus `model` and `user`. **There is no path for a `provider` object to reach
OpenRouter.** The controls that make a remote route defensible —
`data_collection: "deny"`, `zdr: true`, `allow_fallbacks: false`, provider
pinning — are all unreachable.

The right shape is **not** to let callers pass it. VM2 must not choose the data
policy; that is an operator decision. It belongs in the connection
configuration, alongside `chatPath` and `maxOutputTokens`, and gets merged into
the body server-side at `:371-382` where `model` and `user` are already stamped.
Something like `providerPolicy: { zdr?: boolean; dataCollection?: "allow" | "deny";
allowFallbacks?: boolean; only?: string[] }`.

Two consequences worth stating. `zdr: true` narrows the provider pool and will
make some models unroutable, surfacing as a 503 with `Retry-After` — that must
read as "no ZDR provider available for this model", not as a generic upstream
failure, which is [increment G](#g--stop-discarding-the-upstream-error). And
because these are configuration, they are subject to the existing revision and
rollback machinery, which is the correct audit story: turning ZDR off becomes a
reviewable configuration change rather than an invisible request-level flag.

**Done when:** an operator can set ZDR on the connection and it appears in the
outbound body; a request with ZDR set to a model with no ZDR provider produces a
distinguishable error; VM2 cannot influence the setting from the request;
removing the merge fails a test. **2–3 days.**

**Files:** `packages/contracts/src/connections.ts`,
`apps/api/src/inference/inference-gateway.ts`, `apps/web/src/connections-view.tsx`,
tests for each.

---

### F — name the trade on the screen

*The positioning increment. Depends on nothing technically; gates the release.*

`packages/contracts/src/agents.ts:406`:

> "You are an enterprise assistant running inside a private, on-premise
> OrcaSynapse deployment. Nothing you receive or produce leaves this
> environment."

With OpenRouter configured, the second sentence is false. Every prompt, every
document pasted into chat, and every completion transits a third party and at
least one of its downstream providers.

**The product cannot fix this by editing the constant, and it is important to
understand why.** `DEFAULT_AGENT_PROFILE` is a *seed*, not a runtime value. It is
inserted as `AgentProfileVersion` v1 by `migrate.ts:30-66` with
`ON CONFLICT DO NOTHING`; `upgradeDefaultAgentProfile()` (`:94-131`) carries a
changed default forward **only** to installs still on version 1. At run time the
worker reads the profile row from PostgreSQL, and an operator can rewrite the
instructions freely through the UI (`apps/web/src/agents-view.tsx:716-717`) or
`PATCH /profiles/:profileId` (`apps/api/src/agents/routes.ts:192-200`).

So the sentence is an **editable string in a database row that no longer matches
reality**, and any install that has ever touched its prompt will keep the false
version forever. Changing the seed fixes nothing for existing customers.

**The product must know which route is active and say so itself.** The signal
already exists and is cheap: `resolveInference()` (`inference-gateway.ts:239-293`)
resolves exactly one enabled, `HEALTHY` `INFERENCE` connection, and its
`baseUrl` is right there. A route is remote when its host is not private —
which is precisely the classification `assertRoutableDestination` declines to
make today, and the same predicate serves both.

Three places it must surface, in descending order of how much I would fight for
them:

1. **The prompt.** Not by editing the seed — by composing the environment
   sentence at run time from the resolved route, the way division memory is
   already composed in. The seeded sentence becomes a placeholder the runtime
   replaces.
2. **The chat screen.** A persistent marker wherever the model name appears.
   Not a dismissible toast; the user sending the message is the person taking
   the risk.
3. **The connections screen**, at the moment of configuration, before save.

**Proposed wording.** For the prompt, replacing line 406 when the route is
remote:

> "You are an enterprise assistant running inside an OrcaSynapse deployment
> configured to use a remote inference provider. What you receive and produce is
> sent to that provider over the public internet, and may be processed by its
> downstream model vendors. Do not tell the user their data stays on-premise."

That last clause is doing real work. Without it the model will cheerfully
reassure a user about on-premise privacy, because that is what the rest of the
prompt and the entire product surface implies.

For the connection form, at configuration time:

> **This route sends prompts and responses to the public internet.**
> `openrouter.ai` receives every message, document excerpt and completion, and
> forwards them to the model vendor it selects. OrcaSynapse's guardrails inspect
> input before it is sent; they do not redact it, and they do not inspect what
> comes back. On-premise data-residency claims do not apply to conversations on
> this route.

For the chat screen, one line beside the model name: **"Remote model — messages
leave this network."**

**On the network posture.** This is a larger change than it looks, and the
runbook does not currently have a place to put it. `docs/AGENTIC_SYSTEM_ENROLLMENT_RUNBOOK.md:86-90`
lists three allowlist rows and **not one of them is a VM1 egress rule** — the
only "OrcaSynapse" row is inbound *to* VM2. VM1's egress has never been written
down, because until now it was assumed to be internal. Line 94 becomes false the
day this ships:

> "This egress is needed only while `install-agentic-node.sh` runs; once the
> node is enrolled, steady-state traffic is the two rows above and nothing else,
> so the allowlist can be narrowed again after installation."

With OpenRouter, steady-state traffic includes **VM1 → `openrouter.ai:443` on
every single turn**. A new allowlist row is required, and line 94's "and nothing
else" needs qualifying.

The VM1/VM2 split itself survives intact, and that is worth saying clearly: VM2
still makes only signed calls to VM1 and still receives a node-scoped gateway
credential, never the upstream key (`docs/ARCHITECTURE.md:89`). The
`install-agentic-node.sh:2376` reconciler even strips an operator-set
`OPENROUTER_API_KEY` out of VM2's managed Hermes config, asserted by
`scripts/test-agentic-installer-recovery.sh:300`. **The architecture already
insists that only VM1 talks to model providers.** What changes is not the shape
of the boundary but where its outer edge terminates — previously a machine on
the customer's network, now a host on the public internet.

There is no firewall config in this repo to edit. Grepped for
`nftables|iptables|ufw|DOCKER-USER|HTTPS_PROXY`: no rule files, no rule-emitting
code. The product explicitly disclaims firewall ownership
(`apps/web/src/runtime-nodes-panel.tsx:473`: "The installer does not manage your
firewall."). So the allowlist change is a documentation change plus a
customer-side action.

**Docs that need qualifying**, each with the specific line:

| File:line | Text | Why |
| --- | --- | --- |
| `packages/contracts/src/agents.ts:406` | "Nothing you receive or produce leaves this environment." | false on a remote route |
| `docs/AGENTIC_SYSTEM_ENROLLMENT_RUNBOOK.md:86-90` | the three-row allowlist | no VM1 egress row exists |
| `docs/AGENTIC_SYSTEM_ENROLLMENT_RUNBOOK.md:94` | "steady-state traffic is the two rows above and nothing else" | false |
| `docs/ARCHITECTURE.md:33` | "an operator-approved OpenAI-compatible endpoint reached through VM1's scoped gateway" | *technically still true* — which is exactly why nothing blocks this. Needs a sentence saying the endpoint may be remote, and what follows if it is. |
| `deploy/BOOTSTRAP.md:84` | "restrict VM2 egress to OrcaSynapse plus approved MCP destinations" | VM2-only; VM1 egress is never constrained in writing |
| `apps/api/src/ai-ops/drizzle-ai-ops-manager.ts:176` | "OrcaSynapse uses configured internal endpoints" | "internal" becomes wrong |
| `apps/web/src/dot-grid-field.tsx:11` | "This product installs on-premise and is often air-gapped" | already contradicts runbook:96, which says air-gapped install is unsupported |

`docs/ARCHITECTURE.md` has **no** firewall, egress, or air-gap section at all,
despite `README.md:90` describing it as covering "network boundaries". That gap
is pre-existing and this work is the reason to close it.

The README's on-premise claims (`README.md:2, 8, 18, 101`), `SECURITY.md:3`, and
the wordmark do **not** need retracting — the *control plane* remains
on-premise, and that is the accurate claim. What needs stating is that inference
is a configurable route which may leave it.

**Done when:** a deployment with a remote route shows the trade on the chat
screen, in the connection form before save, and in the composed system prompt;
a deployment with a private route is byte-identical to today; an operator who
has customised their prompt still gets the correct environment sentence,
because it is composed at run time rather than seeded; the runbook has a VM1
egress row; pointing a connection at a public host without acknowledging the
notice is not possible. **3–5 days**, most of it wording and review rather than
code.

**Files:** `packages/contracts/src/agents.ts`,
`apps/api/src/agents/drizzle-agent-manager.ts`,
`apps/api/src/inference/inference-gateway.ts`, `apps/web/src/chat-view.tsx`,
`apps/web/src/connections-view.tsx`,
`docs/AGENTIC_SYSTEM_ENROLLMENT_RUNBOOK.md`, `docs/ARCHITECTURE.md`,
`deploy/BOOTSTRAP.md`, `apps/api/src/ai-ops/drizzle-ai-ops-manager.ts`.

---

### G — stop discarding the upstream error

*No schema. Ships alone. Cheap, and it pays for itself on day one.*

`inference-gateway.ts:394-404` collapses every upstream outcome into one opaque
message. The bare `catch` swallows DNS failure, TLS failure, timeout, redirect
refusal and client disconnect alike; `!response.ok` yields only
`"The approved inference server returned status ${response.status}."`, and **the
upstream body is discarded unread**. `routes.ts:19-27` then maps
`UPSTREAM_FAILED` to HTTP 502 regardless.

Against a local vLLM the status code was usually enough. Against OpenRouter it
is not, because the interesting failures are all distinguishable only by body or
by code, and all of them look identical to the operator today:

| Upstream | What the operator sees today | What it means |
| --- | --- | --- |
| 401 | 502, "returned status 401" | the API key is wrong |
| **402** | 502, "returned status 402" | **out of credits — nothing is broken** |
| 429 | 502, "returned status 429" | rate limited; `Retry-After` is present and ignored |
| 502 | 502, "returned status 502" | the *model vendor* is down, not OpenRouter |
| 503 | 502, "returned status 503" | no provider meets the routing requirements (e.g. ZDR) |

"Out of credits" presenting as a generic gateway failure is the one that will
generate a support ticket in the first week. The `error.code` and
`error.message` are right there in a small JSON body, and the machinery to read
a bounded body already exists — `readBounded` at `inference-gateway.ts:127-145`
is used for exactly this purpose by `rejectedCompatibilityHints`.

Related, and cheap alongside: **`usage` is requested and never read.**
`stream_options: {include_usage: true}` is sent at `:379`, and nothing in
`apps/api/src` consumes a `usage` object. Rate limiting is request-count-based
only (`:295-333`). On a local GPU that was defensible — the marginal cost of a
token was zero. On OpenRouter every token is billed, and an operator has no way
to see spend rising. That is the same gap
`docs/MEMORY_HARDENING_PLAN.md` flagged for extraction calls, now with a real
invoice attached.

**Done when:** a 402 reads as insufficient credit and not as a gateway failure;
a 429 surfaces `Retry-After`; a transport failure is distinguishable from an
HTTP error; the upstream body is bounded-read and never logged wholesale;
collapsing the classifier back to one message fails a test. **1–2 days**,
plus **1–2 days** if usage capture is taken with it.

**Files:** `apps/api/src/inference/inference-gateway.ts`,
`apps/api/src/inference/routes.ts`, tests for both.

---

## The token-bound inconsistency

Not an increment, because it is pre-existing and OpenRouter only exposes it —
but it needs recording.

There are two `maxOutputTokens` with different ceilings:

| Where | Bounds | `file:line` |
| --- | --- | --- |
| Connection configuration | 64 – **32,768** | `packages/contracts/src/connections.ts:81` |
| Model deployment | 64 – **131,072** | `packages/contracts/src/models.ts:18` |

Measured against the real schemas: `32769` is rejected as connection
configuration and accepted as a model deployment.

> *Superseded reasoning.* I first recorded the 32,768 cap as a blocker, on the
> grounds that 240 of OpenRouter's 364 models with a declared limit exceed it.
> That is wrong, and the correction is at `inference-gateway.ts:290`: the
> effective ceiling is `route?.maxOutputTokens ?? numbers(connection.configuration.maxOutputTokens, …)`
> — **the model deployment wins**, and the connection value is only a fallback.
> A customer who creates a model deployment is bound by 131,072, not 32,768. The
> connection cap binds only a deployment-less configuration.

At 131,072 the real exposure is 32 of 364 models — the very large output models
like `deepseek/deepseek-v4-flash-0731` (393,216) and
`dots-studio/dots-3-note-preview:free` (512,000). Those cannot have their full
output range configured. That is a narrow and probably acceptable limitation;
the two-ceiling design is the thing worth revisiting, since which one applies
depends on whether a deployment row exists.

`contextWindowTokens` has no such problem: bounds are 1,024 – 4,194,304 and
OpenRouter's range is 4,095 – 2,000,000, comfortably inside. **One caveat:** the
minimum is 1,024 and OpenRouter's smallest model declares **4,095** — fine — but
nothing validates a typed `contextWindowTokens` against the real model. It is
purely declarative, used only for the chat UI's context gauge
(`apps/web/src/chat-view.tsx:1105-1140`) and enforced nowhere.

---

## Order, and why

**B and C first**, together — they are the two that make a correctly-configured
connection behave correctly, they are the cheapest, and C is a hard blocker on
87% of the catalogue. Neither depends on anything.

**G next.** It is cheap and it is what makes the next four weeks of pilot
support survivable. Diagnosing a remote route without the upstream error message
is guesswork.

**F before any customer sees this.** It is the release gate, not a follow-up.
Shipping a cloud route into a product that tells users their data stays on
premise is the one failure here that cannot be walked back after the fact.

**A and E after.** A is polish on a wizard that a runbook can substitute for; E
matters only when a customer asks the ZDR question, at which point it becomes
urgent.

**D probably never**, per its own recommendation.

The one real dependency: **E's failure modes are unreadable without G**, since a
ZDR-narrowed 503 is exactly the case the current classifier flattens.

## Total

| | Days |
| --- | --- |
| A — honest discovery | 1–2 |
| B — `HEALTHY` means the key works | 1–2 |
| C — lift the 50-model cap | 0.5 |
| D — floating aliases (recommended: decline) | 0.5 |
| E — `provider` block | 2–3 |
| F — name the trade | 3–5 |
| G — upstream errors (+ usage) | 1–2 (+1–2) |
| **Everything** | **9.5–16** |
| **Minimum shippable (B, C, F, G)** | **5.5–9.5** |

The spread is almost entirely F, and F's spread is almost entirely review rather
than implementation. The wording in this document is a proposal; the sentence a
customer reads about where their data goes should be signed off by someone who
can carry the commercial consequence of it.

## What this does not do

**No new `INFERENCE_BACKEND`.** `CUSTOM_OPENAI_COMPATIBLE` is correct and
sufficient. Adding an `OPENROUTER` literal would mean a migration, a new enum
member across contracts and database, and a branch in
`compatibilityHintsFor` that has nothing to put in it — OpenRouter ignores
unsupported parameters rather than rejecting them, which is precisely the
condition under which the existing empty hint set is right. The only thing a
dedicated backend would buy is a friendlier default `chatPath`, and that is a
form placeholder, not an enum.

**No mid-stream failover handling.** A provider that dies after the first token
arrives as `finish_reason: "error"` inside an HTTP 200 SSE stream. The gateway
never parses the body and should not start; this is a real behavioural
difference from a local vLLM and it is recorded rather than fixed.

**No output inspection, and no claim of any.** Increment F names this rather
than solving it. Adding DLP to a remote route is a much larger piece of work and
pretending otherwise in a sales conversation is how a product ends up with a
guarantee it cannot keep.

**No cost controls.** G captures usage if it is taken with the optional half;
budgets, per-division spend caps and alerts are not in scope and are the obvious
follow-on once real invoices exist.

**No multi-route support.** `resolveInference()` requires **exactly one**
enabled, `HEALTHY` `INFERENCE` connection (`inference-gateway.ts:239-293`). A
deployment that wants a local model for sensitive divisions and OpenRouter for
the rest cannot express that, and the fix is not configuration — it is the
division-scoped routing that `docs/DIVISIONS_PLAN.md` builds the machinery for.
Worth naming because it is the first thing a customer will ask for after saying
yes to this, and because it is the honest answer to "can we send only the
non-sensitive work off-premise?" — today, no.

---

## Corrections to the brief that commissioned this

Recorded because the brief was mostly right and the exceptions are the useful
part.

1. **"The `/api/v1/models` response shape versus plain OpenAI's — this matters,
   see the discovery probe."** It matters less than expected. The shapes *do*
   differ — OpenRouter has `total_count` and `links`, and its model objects have
   no `object` or `owned_by` field — but both parsers in this repo read
   `payload.data` and pick the first string among `id`/`model`/`name`, ignoring
   everything else. The divergence is invisible. What actually breaks discovery
   is unrelated to shape: openrouter.ai returns **200 with HTML** for every
   probed path, so all eleven probes pass while finding nothing.

2. **The attribution header is now `X-OpenRouter-Title`.** `X-Title` is retained
   for backwards compatibility only. Anyone writing this from memory gets it
   wrong.

3. **`assertRoutableDestination` was suggested as a possible blocker.** It is
   not, and it is not close — it blocks link-local addresses only, deliberately
   permits RFC1918 and loopback, and has no allowlist. Confirmed by mutation
   that the guard does fire for `169.254.169.254`, so this is a real negative
   result.

4. **The `max_completion_tokens` → `max_tokens` rewrite was flagged as something
   to check.** It is not merely compatible, it is the correct direction:
   `max_tokens` is supported by 402 of 413 OpenRouter models,
   `max_completion_tokens` by 53.

5. **The 32,768 `maxOutputTokens` cap is not the binding constraint** — see the
   superseded reasoning above. The model deployment's 131,072 wins whenever a
   deployment row exists.

6. **The brief did not anticipate the two findings that actually block this**:
   the 50-model cap in `discoveredModelIds` (363 of 413 models unactivatable)
   and the connection test reporting `HEALTHY — "authenticated"` with no
   credential at all. Both were found by executing the real code against the
   real endpoint rather than reading it. Reading either function would not have
   revealed them; `.slice(0, 50)` looks harmless next to a catalogue you assume
   has three entries.
