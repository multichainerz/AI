# Phase 6 Governed MCP and Approvals Runbook

## Status

The repository contains a locally testable Phase 6 AIHub-side integration candidate. It is not target-environment acceptance or production approval.

AIHub now supports a guarded per-run capability handoff, but it deliberately remains zero-tool against standard Hermes builds. Governed mode activates only when the exact deployed hardened Hermes build advertises AIHub's private-context extension, proves that the context is redacted and never prompt-visible, exposes exactly the configured AIHub toolset, and accepts the configured gateway credential. Any missing or malformed signal fails closed.

## Implemented boundary

AIHub now owns a Streamable HTTP endpoint at `POST /api/v1/mcp/` and the corresponding administration surface under `/api/v1/admin/tooling`. The endpoint supports:

- the current stateless MCP `2026-07-28` request model, including `server/discover`, required per-request metadata, mirrored HTTP-header validation, `resultType`, cache metadata, and private authenticated results;
- a compatibility path for the legacy `2025-11-25` initialization handshake;
- a one-time-visible, revocable gateway credential whose digest—not plaintext—is retained in PostgreSQL;
- a separate short-lived run capability, retained only as a digest on the agent run;
- retry-safe capability derivation from a key separated from AIHub's bootstrap master key, so a worker crash does not require plaintext capability persistence;
- private transport-header authorization for both tool discovery and calls; the capability is absent from prompts, MCP tool schemas, tool arguments, results, and audit metadata;
- exact agent-profile-version grants with exact enterprise groups or administrator roles;
- owner-only resource enforcement and a fresh identity/session check on every call;
- a fail-closed global runtime boundary, per-tool suspension, an idempotent request ledger, and audit events;
- a human approval inbox with expiry, rejection, cancellation, and decision reasons;
- a transactional PostgreSQL action outbox: approval and dispatch creation commit together, workers reclaim expired leases, and transient submission failures retry with bounded exponential backoff;
- full runtime, profile-version, grant, current-session/group, handler, and owner-scope authorization revalidation in the worker immediately before an approved action is queued.

Browser-origin MCP traffic is rejected. Hermes never receives PostgreSQL, enterprise-storage, Supermemory, or broad application credentials through this gateway.

## Initial governed tools

The migration seeds two narrow internal tools:

| Tool | Risk | Behavior |
|---|---|---|
| `document_metadata_read` | Read only | Returns bounded metadata for one non-deleted document owned by the run's requesting subject. It does not return document content, storage keys, or service credentials. |
| `document_memory_resync` | Consequential | Creates an approval request. After an authorized reviewer approves it, AIHub rechecks the runtime, profile version, grant, requester session/group, handler identity, and owner-only ready document before asking the existing Supermemory workflow to reindex it. |

Neither tool provides arbitrary SQL, arbitrary URLs, filesystem access, terminal execution, or general connector access.

## Authorization sequence

Every call must satisfy all of these checks:

1. the caller presents an active static gateway credential;
2. the MCP transport headers match the JSON-RPC body for modern requests;
3. the global tool runtime is enabled and the requested tool is active;
4. the supplied run ID identifies a currently running AIHub agent run;
5. the supplied unguessable run capability matches the run's stored digest and has not expired;
6. the agent profile is active and the run still uses its exact active version;
7. that exact version has an enabled grant for the exact tool;
8. the original requesting administrator session or enterprise-user session remains active and still matches an explicitly named role or group;
9. the target document is inside the run owner's local PostgreSQL scope;
10. consequential calls remain pending until a scoped reviewer decides them; approval creates a durable dispatch in the same transaction, and all mutable checks are repeated by the worker before submission.

The client-supplied `requestId` is unique per run. A retry can observe the same call, but AIHub verifies the run capability first and rejects reuse of the same request ID with different arguments or a different tool.

## Dashboard workflow

The **Integrations** workspace provides the Phase 6 control surface:

1. Review the global gateway state and approval lifetime.
2. Review or suspend registered tools.
3. Select an active immutable agent-profile version and assign an exact tool grant.
4. Enter one or more exact enterprise group names or administrator roles. Wildcards and inferred department scopes are not supported.
5. Issue a named Hermes gateway credential. Copy it immediately; AIHub never shows the plaintext again.
6. Store the server-reachable AIHub MCP URL, exact Hermes toolset name, and the one-time gateway credential in the Hermes connection form. These values remain write-only after storage.
7. Review pending consequential requests in the approval inbox. The operator must provide a reason for approval or rejection.
8. Use the call ledger and metrics to correlate the run, profile version, tool, decision, result, and audit evidence.

Do not enable live Hermes tooling until the hardened Hermes extension below has been implemented and tested in the isolated deployment. The worker now mints and hands off capabilities, but a standard build does not advertise the required private-context contract and therefore remains zero-tool.

## Hardened Hermes extension contract

The AIHub worker permits governed mode only when `/v1/capabilities` includes all existing authenticated Runs API guarantees plus:

```json
{
  "features": { "private_run_context": "aihub_mcp_headers_v1" },
  "runtime": {
    "private_context_redacted": true,
    "private_context_prompt_visible": false
  }
}
```

`/v1/toolsets` must contain exactly one enabled toolset, and its name must match the dashboard-managed `governedToolsetName`. Before activation, AIHub also performs an authenticated `initialize` request against `governedMcpUrl` and requires the server name `mpm-aihub-governed-tools`.

For an eligible run, `POST /v1/runs` receives a `private_context` object with protocol `aihub_mcp_headers_v1`, expiry, MCP URL, the static gateway bearer, and `AIHub-Run-Authorization`. Hardened Hermes must keep this object outside the model prompt, transcript, status response, memory, telemetry, and ordinary logs; redact it at every serialization boundary; attach its headers only to that run's MCP transport; and destroy it when the run ends. AIHub never places either credential in instructions or tool arguments.

## MCP interoperability checks

Before changing the Phase 5 worker boundary, test the exact deployed Hermes version against both AIHub protocol paths:

- modern clients must call `server/discover` or another RPC with `MCP-Protocol-Version: 2026-07-28`, `Mcp-Method`, `Mcp-Name` where required, and matching `params._meta` fields;
- legacy clients may initialize with `2025-11-25`; no MCP session ID is required or issued;
- requests with a mismatched method, tool name, or protocol version must fail before tool dispatch;
- browser `Origin` headers, missing gateway credentials, expired run capabilities, suspended tools, stale profile versions, revoked sessions, group changes, cross-owner documents, and expired approvals must all fail closed;
- Hermes must not place either credential or the private run context in prompts, final answers, status payloads, logs, telemetry, memory, or user-visible transcripts;
- gateway-key revocation and global disable must take effect without restarting Hermes or AIHub; issuance and Hermes-side rotation/reload procedures must be documented and tested.

## Operational response

For unexpected tool behavior:

1. disable the global tool boundary in **Integrations**;
2. suspend the affected tool;
3. revoke the Hermes gateway credential;
4. keep the Phase 5 Hermes runtime zero-tool switch disabled, or isolate the Hermes network if it is already running;
5. preserve governed calls, approvals, action dispatches, agent runs, audit events, worker records, Hermes logs, and reverse-proxy logs;
6. correct the grant, handler, identity mapping, or connector policy and repeat the full interoperability and revocation set before re-enabling.

## Acceptance still required

Phase 6 is not accepted until all of the following are demonstrated in MPM's target environment:

- the selected Hermes build interoperates with the AIHub MCP endpoint;
- the deployed worker mints a short-lived capability for an eligible run and conveys it through the private Hermes context for that run only;
- Hermes includes that capability and a stable idempotency key on every governed call without leaking them;
- a complete read-only workflow and a complete approved consequential workflow pass end to end;
- process interruption between approval and durable job submission proves the implemented outbox lease recovery and idempotent queue submission in the deployed PostgreSQL/worker environment;
- revocation, expiry, identity-group change, network isolation, backup/restore, adversarial prompt, concurrency, and load tests pass;
- MPM approves the first real application connector, resource scopes, action risk rating, reviewer matrix, and retention rules.

## Primary protocol references

- [MCP 2026-07-28 specification](https://modelcontextprotocol.io/specification/2026-07-28)
- [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [MCP server discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)
- [MCP tools and human-in-the-loop guidance](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [Hermes MCP configuration](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/mcp.md)
- [Hermes API-server implementation](https://github.com/NousResearch/hermes-agent/blob/main/gateway/platforms/api_server.py)
