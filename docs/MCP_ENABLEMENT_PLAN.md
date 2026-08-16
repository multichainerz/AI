# Letting the agent reach its memory — enabling MCP on VM2

Status: **blocked on a decision, not on effort.** Written at v8.0.0, verified
against the tree and against Hermes at the pinned commit at v8.1.0.

The five pieces this document used to describe were necessary and **not
sufficient**. Verification found one missing prerequisite, now shipped, and one
transport gap that no amount of installer work closes. Both are recorded below
with the measurement, because the estimate and the Done-when in the original
draft were both unreachable.

## The gap this closes

Division-scoped memory is built and tested end to end on VM1: the store
(`ScopedMemoryEntry`), the scope injection (`runScope`), the isolation, the
Agents → Memory screen, the seeded and granted tools, and the default prompt
that tells an agent when to use them.

**The agent cannot call any of it.**

## What verification found

### Finding 1 — no run was ever given a capability. Fixed at v8.1.0.

Every MCP call carries **two** credentials, and the original plan supplied one:

| Header | Purpose | Original plan |
| --- | --- | --- |
| `Authorization: Bearer orcasynapse_mcp_…` | authenticates the node | the `toolBootstrap` below |
| `orcasynapse-run-authorization: <runId>.<capability>` | authorizes the run | absent entirely |

`apps/api/src/tooling/routes.ts:181` reads the second, and without it
`tools/list` returns `-32001 "Private run authorization is required for tool
discovery."` (`mcp-gateway.ts:169`). An agent would authenticate cleanly and see
**zero tools**.

Worse, nothing minted one. `RunCapabilityIssuer` was written, had its own unit
test, and was constructed **nowhere** in production; all three writes of
`toolCapabilityTokenHash` set it to `null`, and `assertRunIsExecutable`
(`drizzle-tooling-manager.ts:911`) refuses a null. The governed-tool plane was
unreachable by construction rather than by configuration — for every run, not
only for VM2.

v8.1.0 mints it at claim time, expiring on the run's own deadline. **This is
necessary under every option below and sufficient under none.**

### Finding 2 — the api_server platform cannot carry a per-run header

This is the decisive one. Measured against `c015663b`, the pinned commit, read
from the checkout on `OrcaSynapse-VM2`.

A run authorization is **per run and expiring**. An MCP client configuration is
**static**. At the pinned commit, the platform OrcaSynapse uses offers no way to
bridge that:

- MCP servers come from the `mcp_servers` section of `config.yaml` — global to
  the process, file-watched for reload (`cli.py:11524`).
- The one dynamic header mechanism is `identity_header`, and its own docstring
  closes the door: `value_from` accepts `static` or `profile`, and *"`profile`
  mode resolves the value to the active Hermes profile name once at connect
  time; there is no per-call mutation"* (`tools/mcp_tool.py:1189`).
- `gateway/platforms/api_server.py` mentions MCP exactly once in the whole file
  — `include_default_mcp_servers=False` at `:3215`, inside the capabilities
  handler. There is no per-session registration.
- `POST /v1/runs` accepts `input`, `instructions`, `previous_response_id`,
  `conversation_history`, `session_id`, `model`. No MCP config, no arbitrary
  headers.
- `POST /api/sessions` — what `ensureNativeSession` calls — is sent `{ id,
  model, source }`.

**Only the ACP adapter supports what this needs.**
`acp_adapter/server.py:970` `_register_session_mcp_servers` takes per-session
servers with arbitrary `headers`, built from
`{"url": server.url, "headers": {...}}`. That is a different platform from the
`api_server` one OrcaSynapse drives.

### What must not be done about it

Relaxing the run-authorization requirement so a node bearer token alone suffices
would make the tools callable and **destroy the feature**. The division a call
reads and writes is derived from the run (`runScope`). With no run, there is no
division — every call would be unscoped, and Finance's agent would read Legal's
notes. That is the one outcome worse than the tools not working.

Recorded explicitly because it is the shortest path from here to a green demo.

## The three options

| | What it costs | What it risks |
| --- | --- | --- |
| **A. Drive Hermes over ACP** instead of the api_server platform | a real change to how the worker talks to Hermes — session lifecycle, streaming, and the capabilities probe all move | largest change here, but **needs nothing upstream**; per-session MCP servers with arbitrary headers already work at the pinned commit |
| **B. Upstream change to Hermes** — per-session MCP headers on `api_server` | small once accepted | software we pin and do not own; unbounded on calendar time, and pinning a fork is its own decision |
| **C. Wait** | nothing | the memory work stays reachable only by tests, and the v8.0.0 default prompt keeps telling agents to use a tool they cannot see |

**A is the only option with a date on it.** It is also the honest reading of
what Hermes supports: the per-session surface exists, and we are on the platform
that does not have it.

If C is chosen, the v8.0.0 MEMORY section should come out of the default profile
instructions — an install that tells its agent to `recall` when nothing can is
a promise the product does not keep.

## Still true, and still needed under A or B

Verified at v8.0.2 and re-checked at v8.1.0; the installer half of the original
plan is sound, and its version-skew handling is genuinely safe:

- The desired-state client parses field by field — `jq -r '.hermesCommit //
  empty'` (`:1436`), `jq -r '.admittedToolsets[]?'` (`:1450`) — so a new
  `mcpEnabled` field is invisible to already-enrolled older nodes rather than
  fatal to them. The signature is verified over the decoded document bytes
  (`openssl pkeyutl -verify -rawin`, `:1414`), so adding a field is
  signature-safe.
- The enrolment bundle is parsed the same way, so an added `toolBootstrap` is
  safe for older installers. **Keep it optional in the schema**: a node enrolled
  by an older control plane must still enrol against a newer one.
- `hermesNodeEnrollmentResultSchema` (`packages/contracts/src/runtime-nodes.ts:160`)
  already carries `modelBootstrap { baseUrl, apiKey }`;
  `drizzle-runtime-node-manager.ts:649` mints that key and the installer reads it
  at `:2183` and `:2233`. Follow it exactly for `toolBootstrap`.
  `baseUrl` derives like `inferenceGatewayBaseUrl(controlPlaneUrl)`
  (`drizzle-runtime-node-manager.ts:119`), validated by `serviceEndpointSchema`
  (`packages/contracts/src/connections.ts:38`).
- `API_SERVER_KEY` (`install-agentic-node.sh:2094`) is **not** this. It is
  `openssl rand -hex 32`, generated locally, for Hermes' own API server. Reusing
  it would hand the agent a credential the control plane never issued and cannot
  revoke.
- `no_mcp` must stop being suppressed **only when a `toolBootstrap` was
  received** (`:691`, and the allowlist rebuild at `:1609`). A node that never
  got a credential must not open an unauthenticated MCP path.
- `mcpEnabled` must travel in the desired-state document. The rebuild is
  unconditional every pass — `["no_mcp", "memory"] + admitted`, `no_mcp`
  hardcoded, the whole `platform_toolsets` block replaced by regex — and the
  timer is `OnBootSec=90s`, `OnUnitActiveSec=5min`. Omit it and the agent loses
  its tools about **five minutes** after install, silently, while an operator is
  still watching.

## Verification, when there is something to verify

`scripts/test-agentic-installer-smoke.sh` is the harness: it runs the
installer's `main()` end to end on Ubuntu with systemd and root, installs Hermes
at the pinned commit, and uses a **real Ed25519 key so the desired-state
signature is genuinely verified**. `OrcaSynapse-VM2` (WSL, systemd) qualifies
and already holds the checkout at `c015663b`.

1. The smoke test passes with `toolBootstrap` present; Hermes' config has the
   MCP entry and no `no_mcp`.
2. The smoke test passes with `toolBootstrap` **absent** — the older-control-plane
   case — and `no_mcp` is still there. Run this second and deliberately: it is
   the case nobody would think to try, and the one a version skew produces.
3. A reconcile pass after install leaves the allowlist unchanged. Assert it by
   running the reconciler twice and diffing the config, not by reading the code.
4. `pnpm verify` green, and the release consistency check at the new version.

Then, against the live pair: enrol `OrcaSynapse-VM2` against the running VM1,
start a session, and confirm the agent calls `recall` — **and that a run in one
division cannot recall the other's rows**. The second half is the feature; the
first half alone would pass with the boundary removed.

## What this does not change

- **VM2 gains no SQL credential.** The MCP token authenticates an HTTP call to
  VM1's API; the tool executes there, against VM1's database, exactly as every
  governed tool does. The `data` network stays `internal: true`.
- **The division boundary is untouched.** The scope comes from the run
  authorization, not from the MCP credential — a node credential says *which
  node*, never *which division*.
- **Consequential tools stay gated.** Enabling the MCP path does not enable
  anything beyond the two READ_ONLY memory tools; a `CONSEQUENTIAL` tool still
  enters the human approval inbox at call time.

## Estimate

The original **1–2 days** was for five pieces that could not have worked. The
honest replacement:

| | Days |
| --- | --- |
| ~~Piece 0 — issue the run capability~~ | **shipped at v8.1.0** |
| Option A — move to ACP, then the installer half | 5–9 |
| Option B — the installer half only, once upstream lands | 1–2, plus the wait |

## The lesson, recorded because it recurred three times

v7.4.0 read `runForTooling`'s join and `run-capability.ts`'s existence and
concluded the plane was "ready". v8.0.1 planned five pieces on that basis. Both
were checking that a symbol existed.

An issuer nothing calls issues nothing; a header no transport can carry is not a
header. `DIVISIONS_PLAN.md:29` already says this, from the last time. The check
that would have caught all three is the same one: **find the write, not the
definition.**
