# Agentic System Node Enrollment

## Purpose

This workflow turns a clean Ubuntu systemd VM into the isolated OrcaSynapse Agentic System. It installs Hermes Agent and Supermemory Local, configures both to use OrcaSynapse's authenticated inference gateway, and establishes a signed node identity without retaining SSH credentials.

The installer follows the current upstream integration model: Hermes runs its official Docker gateway/API server, external memory providers are additive to built-in `MEMORY.md`/`USER.md`, and Supermemory Local is a single self-hosted binary with embedded graph storage. OrcaSynapse requests CPU-local `Xenova/bge-m3` embeddings (1024 dimensions), streams first-boot model-download progress, and reports the model the runtime actually loads. It uses Hermes's root-owned managed scope to pin the approved model route, Supermemory provider, secret redaction, unattended loop circuit breakers, and an explicit `platform_toolsets.api_server: [no_mcp]` baseline so the official image does not inherit its broad default tool surface.

## Prerequisites

- OrcaSynapse is installed and the temporary local-administrator password has been replaced.
- PostgreSQL is healthy.
- exactly one AI Inference connection is enabled, healthy, and has a selected served model;
- an evaluated Agent model route is active;
- VM2 is a clean Ubuntu systemd VM on x86_64 or aarch64 with outbound access to OrcaSynapse and the artifact sources during installation;
- OrcaSynapse can reach the VM2 Hermes address on TCP 8642 and Supermemory address on TCP 6767;
- the invitation uses a hostname/address that matches customer DNS and TLS policy.

For production, enter a Hermes image digest and exact Supermemory release in the dashboard invitation. OrcaSynapse rejects mutable `latest` artifacts in Production. In Development, the installer may accept a tag from the invitation but resolves the pull to its registry digest before starting, enrolling, or reporting the runtime. New invitations default to Supermemory v0.0.7-rc.2 because it contains the upstream large-document workflow fix; v0.0.6 remains blocked by a workflow-packaging defect. Promote a newer stable release only after validation, and record the Hermes `supermemory` Python package in the bill of materials.

## Dashboard workflow

1. Open **Deployment → Agentic System**.
2. Create an invitation with the runtime display name, slug, reachable Hermes base URL, approved image reference, and short TTL.
3. Copy the one-time claim. OrcaSynapse stores only its digest.
4. On VM2, download the installer from the OrcaSynapse URL shown by the dashboard. The route is unavailable before dashboard setup and healthy AI Inference are present. It remains available afterward for protected local recovery, while a live claim is required to begin a new enrollment.
5. Run it against the same OrcaSynapse origin, then paste the claim at the hidden prompt:

   ```bash
   curl --fail --show-error --location --progress-bar https://orcasynapse.example.internal/install/agentic-node.sh \
     | sudo bash -s -- --connect https://orcasynapse.example.internal
   ```

6. Return to the dashboard and verify that Hermes, Supermemory, and the signed heartbeat are healthy.
7. Run the AI-services and Hermes-profile checks before activation.

For an offline administrative transfer, download the JSON bundle and run `sudo bash install-agentic-node.sh enrollment.json` instead. Do not place the claim in a URL, command argument, or shell history.

## Decommission a VM2 node

Revocation and destruction are intentionally separate. Revoke the node first to disable its runtime credential and generated service connections. Then select **Remove** beside the revoked node and follow the dashboard's two-stage flow:

1. Run the displayed `remove-agentic-node.sh` command on VM2 and type `DESTROY` at its local terminal. It stops and removes the managed Hermes container, Supermemory runtime and durable data, node identity, managed policy, heartbeat units, and the dedicated service account. It preserves Docker, unrelated containers, Ubuntu packages, and external backups.
2. Confirm the host-side result, type the exact node slug, and choose **Remove permanently**. OrcaSynapse transactionally removes the runtime-node record, enrollment claims, replay nonces, and generated Hermes/Supermemory connections. The security audit event remains.

OrcaSynapse has no standing SSH credential or Docker socket on VM2, so host destruction is an explicit operator-attested action. If the VM has already been destroyed by the infrastructure platform, use that destruction event as the host-side evidence. Snapshot and backup retirement remains the infrastructure operator's responsibility.

## What the script does

1. validates the bundle and expiry;
2. installs required host packages when needed;
3. creates a local Ed25519 identity;
4. starts the constrained official Hermes container with persistent `/opt/data` and read-only `/etc/hermes` managed scope;
5. enrolls with the single-use claim;
6. receives the OrcaSynapse `/internal/v1` URL, dashboard-selected model alias, and a node-scoped bearer key;
7. installs the checksum-verified Supermemory Local binary and starts it under a dedicated system user;
8. configures Supermemory extraction to use the OrcaSynapse gateway, requests local `Xenova/bge-m3`, displays model-download progress, and verifies the loaded model;
9. installs/enables Hermes's native Supermemory provider with `orcasynapse-agent-{identity}` and custom containers disabled;
10. pins the model route and baseline guardrails in managed scope, disabling native API-server toolsets and default MCP discovery until an OrcaSynapse-reviewed distribution enables them;
11. registers the VM2 Supermemory endpoint and encrypted API key with OrcaSynapse;
12. starts a systemd timer that sends signed replay-protected heartbeats every minute.

After the claim is consumed, the installer writes a root-only `${ORCASYNAPSE_HERMES_STATE_ROOT:-/var/lib/orcasynapse-hermes}/enrollment-state.json` recovery journal before installing memory or policy. If a later step fails, rerun the same command: the installer reuses the node identity and scoped configuration, repeats idempotent steps, and removes the recovery journal only after memory registration and heartbeat startup succeed.

The inference bootstrap never contains the upstream serving credential. Revoking a node disables its generated Hermes connection and managed Supermemory connection.

Supermemory auto-recall and auto-capture remain active in this baseline because the memory provider is not a native model-callable toolset.

## Network allowlist

| Source | Destination | Required use |
| --- | --- | --- |
| VM2 | OrcaSynapse HTTPS | enrollment, memory registration, heartbeat, inference gateway |
| OrcaSynapse | VM2 TCP 8642 | Hermes health and governed agent calls |
| OrcaSynapse worker | VM2 TCP 6767 | document publication and authorized retrieval |
| Hermes container | VM2 TCP 6767 | native long-term memory |
| VM2 | approved artifact registries | installation/upgrade only; mirror internally for air-gapped production |

Deny VM2 access to OrcaSynapse PostgreSQL, host Docker APIs, enterprise storage administration, hypervisor/deployment APIs, and unrestricted external networks. Do not expose ports 8642 or 6767 to user networks or the public internet.

## Secrets and state

- `${ORCASYNAPSE_HERMES_STATE_ROOT:-/var/lib/orcasynapse-hermes}` contains node identity, the Hermes data volume, and root-owned managed policy mounted read-only into the container.
- `${ORCASYNAPSE_SUPERMEMORY_STATE_ROOT:-/var/lib/orcasynapse-supermemory}` contains the binary, runtime environment, API key, and graph data.
- OrcaSynapse stores encrypted Hermes, inference-gateway, and Supermemory secrets in PostgreSQL.
- The invitation token is single-use, bound to the OrcaSynapse control-plane origin, and expires even if never consumed.
- The node private key never leaves VM2.

System journal access is root-equivalent for this workflow because Supermemory prints its generated API key on first boot. Restrict journal readers, complete registration promptly, and include key rotation/journal-retention behavior in production acceptance.

## Backup and restore

Back up Hermes `/opt/data` for sessions, Skills, profiles, built-in memory, and runtime configuration. Back up the complete Supermemory data directory consistently for graph, auth, and local-embedding state. PostgreSQL backup alone cannot reconstruct either runtime.

### Current upstream Supermemory limitations

- Supermemory v0.0.6 is blocked by the installer because its missing RivetKit module leaves ingestion queued and search empty. See [#1315](https://github.com/supermemoryai/supermemory/issues/1315) and [#1324](https://github.com/supermemoryai/supermemory/issues/1324). New nodes pin v0.0.7-rc.2, whose release notes identify the self-hosted large-document workflow fix; replace the release candidate with a stable pin after equivalent validation.
- The installer requests multilingual `Xenova/bge-m3` at 1024 dimensions and reports the model observed in the first-boot log. If a release falls back to `Xenova/bge-base-en-v1.5`, the installer warns rather than claiming multilingual readiness; validate Indonesian recall before Production approval.

Preferred host-loss procedure:

1. revoke the missing node in OrcaSynapse;
2. restore runtime data only under the approved recovery procedure, or create a clean node;
3. issue a new invitation and identity;
4. verify namespace isolation, inference gateway authentication, memory recall, document authorization, and deletion;
5. retain the recovery evidence.

## Upgrade

Do not use an invitation as a generic remote administrator. Upgrade with pinned, signed artifacts under customer change control. Before promotion, test the exact Hermes image, Supermemory binary/SDK, API contracts, state migration, backup, rollback, memory isolation, and agent cancellation in a non-production environment.
