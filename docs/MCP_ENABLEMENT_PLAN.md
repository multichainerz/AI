# Letting the agent reach its memory — enabling MCP on VM2

Status: **plan, not started.** Written at v8.0.0.

## The gap this closes

Division-scoped memory is built and tested end to end on VM1: the store
(`ScopedMemoryEntry`), the scope injection (`runScope`), the isolation, the
Agents → Memory screen, the seeded and granted tools, and the default prompt
that tells an agent when to use them.

**The agent cannot call any of it.** `scripts/install-agentic-node.sh:691` puts
`no_mcp` in Hermes' `platform_toolsets` allowlist, and VM2 has no MCP client
configuration of any kind — no endpoint, no credential. The MCP plane is
reachable from VM1's side and unreachable from the agent's.

Recorded plainly because v7.4.0 overstated it: that entry said the spike showed
the plane "ready", which was true of the run-authorization chain on VM1 — the
thing actually measured — and untrue of VM2, which was not looked at.

## The one design decision, already settled

The credential cannot travel in the desired-state document. That document is
**signed, not encrypted** (`runtimeDesiredStateDocumentSchema`,
`packages/contracts/src/runtime-nodes.ts:195`), and it is `.strict()`.

There is already a pattern for handing VM2 a secret at enrolment:
`hermesNodeEnrollmentResultSchema` (`:160`) carries `modelBootstrap`, a nested
object with `baseUrl` + `apiKey`. `drizzle-runtime-node-manager.ts:649` mints
that key, stores it encrypted, and the installer reads it at
`install-agentic-node.sh:2183` and `:2233`.

**Follow that exactly.** Add a sibling `toolBootstrap { baseUrl, apiKey }`.

One trap worth naming before somebody trips it: `API_SERVER_KEY` in the
installer (`:2094`) is **not** this. It is `openssl rand -hex 32`, generated
locally, and it is the key for Hermes' *own* API server on VM2. Reusing it for
the MCP gateway would hand the agent a credential the control plane never issued
and cannot revoke.

## The five pieces, which must land together

A contract change without the installer half — or an installer reading a field
enrolment does not send — breaks enrolment. And an installer that is wrong does
not fail a test; it fails on a customer's machine.

### 1. Mint an MCP credential at enrolment

`apps/api/src/tooling/drizzle-tooling-manager.ts:311` already has
`issueCredential`, which returns the plaintext once and stores only its digest.
Enrolment calls it, names the credential after the node, and puts the token in
the response.

### 2. Extend the enrolment result

`hermesNodeEnrollmentResultSchema` gains:

```
toolBootstrap: { baseUrl: serviceEndpointSchema, apiKey: z.string().min(1).max(16_384) }
```

`baseUrl` is the control plane's `/api/v1/mcp`, derived the same way
`inferenceGatewayBaseUrl(controlPlaneUrl)` derives the inference one — which
lives in `apps/api/src/runtime-nodes/drizzle-runtime-node-manager.ts:119`, not in
contracts, so `serviceEndpointSchema` (`packages/contracts/src/connections.ts:38`)
is what validates the field.

**Make it optional in the schema.** A node enrolled by an older control plane
must still enrol against a newer one; a required field turns a version skew into
a failed install.

### 3. Installer: write the MCP client configuration

Read `toolBootstrap` from the enrolment response beside `modelBootstrap`, and
write Hermes' MCP server entry pointing at that URL with that bearer token.
Store the token with the same mode and ownership as the other secrets under
`${STATE_ROOT}/data/`.

### 4. Installer: drop `no_mcp`

`:691` and the allowlist rewrite at `:1609`
(`["no_mcp", "memory"] + admitted`). Both need to stop suppressing MCP **when a
`toolBootstrap` was received**, and keep suppressing it when one was not — a
node that never got a credential must not open an unauthenticated MCP path.

The comment at `:685-688` says this stays until OrcaSynapse "explicitly
distributes and verifies another governed toolset". That is precisely what this
is; rewrite the comment rather than deleting it.

### 5. Desired state carries whether MCP is enabled

The reconciler (`:1546` onward) rewrites the allowlist on every pass from the
desired-state document. If that document does not say MCP is on, the next
reconcile puts `no_mcp` back — and the timer is
`OnBootSec=90s`, `OnUnitActiveSec=5min`, its unit description reading *"Reconcile
the OrcaSynapse desired runtime state every five minutes"*. So the agent loses
its tools **about five minutes after install**, silently, while an operator is
still watching the screen and concluding the feature does not work.

So `runtimeDesiredStateDocumentSchema` gains `mcpEnabled: z.boolean()`, emitted
from `drizzle-runtime-node-manager.ts:914` beside `admittedToolsets`.

**This is the piece most likely to be forgotten**, because everything works
immediately after install without it. The rewrite is unconditional — the
allowlist is rebuilt every pass as `["no_mcp", "memory"] + admitted`, with
`no_mcp` hardcoded at the front (`:1609`) and the whole `platform_toolsets`
block replaced by regex — so nothing about a previous pass survives.

## Verification

`scripts/test-agentic-installer-smoke.sh` is the harness: it runs the
installer's `main()` end to end on Ubuntu with systemd and root, installs Hermes
at the pinned commit, and uses a **real Ed25519 key so the desired-state
signature is genuinely verified**. `OrcaSynapse-VM2` (WSL, systemd, currently no
Hermes install) qualifies.

Done when, in order:

1. The smoke test passes with `toolBootstrap` present, and Hermes' config has the
   MCP entry and no `no_mcp`.
2. The smoke test passes with `toolBootstrap` **absent** — the older-control-plane
   case — and `no_mcp` is still there. Run this second and deliberately: it is
   the case nobody would think to try, and the one a version skew produces.
3. A reconcile pass after install leaves the allowlist unchanged. Assert it by
   running the reconciler twice and diffing the config, not by reading the code.
4. `pnpm verify` green, and the release consistency check at the new version.

Then, against the live pair: enrol `OrcaSynapse-VM2` against the running VM1,
start a session, and confirm the agent calls `recall` — the first end-to-end
proof that any of the memory work is reachable by an agent rather than only by a
test.

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

**1–2 days**, most of it the installer and its two smoke-test cases. The VM1
half is small because `issueCredential` and the enrolment response pattern both
already exist.
