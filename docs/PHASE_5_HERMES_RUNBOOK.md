# Phase 5 Hardened Hermes Runbook

## Status

The repository contains the locally testable Phase 5 acceptance candidate. It does not constitute target-environment acceptance or production approval.

Phase 5 is intentionally narrower than the later governed-tool design:

- every agent profile is immutable and versioned;
- safe mode is mandatory and the turn limit is exactly one;
- Hermes-native toolsets must all be disabled;
- MCP, tool calls, approvals, and shared agent memory are not enabled;
- the only optional capability is read access to the requesting identity's private Supermemory scope;
- PostgreSQL is the lifecycle, authorization, audit, and job system of record;
- Supermemory remains the sole semantic index;
- `pg-boss` runs the asynchronous work; Redis, Valkey, and a second vector database are not required.

## Runtime trust boundary

Hermes is a server-side agent runtime. Its API can execute tools on the Hermes host when toolsets are enabled. An AIHub system instruction is therefore not treated as a security control.

Before a run starts or resumes, the worker authenticates to Hermes and requires:

1. `/v1/capabilities` identifies `hermes-agent`, requires bearer authentication, advertises run submission, status, and stop, and reports the server-agent execution mode;
2. `/v1/toolsets` identifies the `api_server` surface and reports no enabled toolset;
3. the global AIHub runtime control is enabled;
4. the profile and exact profile version are still active;
5. the stored profile satisfies the Phase 5 safe-mode and single-turn constraint.

The worker repeats the local runtime and profile checks while polling. A cancellation, global disable, profile suspension, version replacement, approval request, or timeout stops the remote run and produces a terminal AIHub state.

## Required target topology

Run Hermes in a dedicated container and network segment. The container must:

- expose its API only to the AIHub worker network;
- use a strong `API_SERVER_KEY` stored only in Hermes and the encrypted AIHub connection vault;
- have no host filesystem, Docker socket, Coolify control socket, PostgreSQL credential, enterprise-storage administration credential, or Supermemory credential;
- have no route to AIHub's database, transient document scratch volume, or unrestricted internet;
- have outbound access only to the approved inference route required by its configured provider;
- have all `platform_toolsets.api_server` entries disabled;
- use an isolated, non-privileged runtime user and read-only container filesystem wherever supported.

The current upstream capabilities response advertises `admin_config_rw: false`. AIHub can manage the Hermes endpoint, API key, health/capability/toolset/run paths, profile model aliases, timeouts, concurrency, lifecycle, and execution switch from the dashboard. Hermes's own provider bootstrap still has to be supplied to the isolated deployment so its `hermes-agent` or approved model alias resolves to the MPM LiteLLM/vLLM route.

## Dashboard configuration

1. Open **Settings**, select **Hermes**, and enter the internal endpoint and API-server key.
2. Retain the default health, capability, toolset, and run paths unless the isolated profile uses an explicit path prefix.
3. Save and test the connection.
4. Open **Models**, create the matching agent model route, promote exact `model:<route-slug>` version evidence, and activate the route. Draft routes do not begin catalogue enforcement.
5. Open **Agents** and create a draft profile using the active route alias, timeout, concurrency limit, and whether private knowledge retrieval is allowed.
6. Promote the exact `agent:<profile-slug>` version evidence and activate the intended profile version. Creating a later version does not change the active version until an administrator explicitly activates it.
7. Complete the acceptance checks below, enter an operator reason, and enable the global execution boundary. AIHub performs a fresh authenticated capabilities and zero-enabled-toolset check before it persists the enabled state; a failed or unavailable check leaves execution disabled and records a denied audit event.

Disabling the boundary is immediate from AIHub's perspective. Active workers observe the change at their next polling cycle and request remote stop.

## Acceptance checks

Do not enable the runtime for pilot users until all checks pass in the actual on-premises deployment:

- Hermes is unreachable from user and public networks;
- an unauthenticated Hermes request is rejected;
- capability discovery matches the contract used by the worker;
- `/v1/toolsets` returns an `api_server` envelope with no enabled entries;
- a prompt requesting terminal, file, network, MCP, skill, or subagent access cannot produce a tool execution;
- a prompt-injected private document cannot change system instructions or cause data egress;
- cross-user retrieval and direct remote-document identifiers do not bypass PostgreSQL authorization rechecks;
- global disable, profile suspension, version replacement, user cancellation, approval requests, and timeouts produce the expected terminal states;
- a worker restart can resume a recorded external run without creating ordinary duplicates;
- PostgreSQL backup and restore preserves profiles, versions, controls, run history, sources, and audit evidence;
- load tests establish safe concurrency for the RTX 6000 PRO, Hermes, LiteLLM, vLLM, PostgreSQL, and Supermemory.

## Operational response

For unexpected behavior:

1. disable the global execution boundary in **Agents**;
2. isolate the Hermes service network if runs do not stop promptly;
3. preserve AIHub agent runs, audit events, worker records, Hermes logs, and LiteLLM request records;
4. suspend affected profiles;
5. rotate the Hermes API-server key in Hermes and the AIHub vault;
6. remediate and repeat the full acceptance set before re-enabling execution.

## Deferred to Phase 6

MCP connectors, tool grants, per-resource authorization, proxied connector credentials, human approval policies, and consequential actions remain disabled. Phase 6 must add them through an AIHub-owned gateway; Hermes must never receive broad application credentials or direct infrastructure access.

## Known residuals

- Live Hermes, LiteLLM/vLLM, GPU, network-policy, recovery, concurrency, and adversarial acceptance require MPM infrastructure and endpoints.
- The upstream idempotency cache reduces the duplicate-start window but is not a durable AIHub transaction. Crash testing around remote submission remains a target-environment acceptance item.
- Phase 5 supports private knowledge only. Department, project, organization, and agent-shared memory require approved ownership rules.
- Model and agent activation are bound to exact promoted evaluation evidence. SIEM forwarding and infrastructure-wide alert delivery still require the target environment.
