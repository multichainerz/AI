# Hermes and Supermemory Node Enrollment

## Purpose

This workflow turns a clean Debian/Ubuntu VM into the isolated OrcaSynapse agent runtime. It installs Hermes Agent and Supermemory Local, configures both to use OrcaSynapse's authenticated inference gateway, and establishes a signed node identity without retaining SSH credentials.

The installer follows the current upstream integration model: Hermes runs its official Docker gateway/API server, external memory providers are additive to built-in `MEMORY.md`/`USER.md`, and Supermemory Local is a single self-hosted binary with embedded graph storage and local embeddings. It uses Hermes's root-owned managed scope to pin the approved model route, Supermemory provider, secret redaction, unattended loop circuit breakers, and an explicit `platform_toolsets.api_server: [no_mcp]` baseline so the official image does not inherit its broad default tool surface.

## Prerequisites

- OrcaSynapse is installed and claimed.
- PostgreSQL is healthy.
- exactly one Inference Server connection is enabled and healthy;
- an evaluated Agent model route is active;
- VM2 is a clean supported Linux host with outbound access to OrcaSynapse and the artifact sources during installation;
- OrcaSynapse can reach the VM2 Hermes address on TCP 8642 and Supermemory address on TCP 6767;
- the invitation uses a hostname/address that matches customer DNS and TLS policy.

For production, use a Hermes image digest and set `ORCASYNAPSE_SUPERMEMORY_VERSION` to an exact release. Validate the Hermes `supermemory` Python package version as part of the bill of materials.

## Dashboard workflow

1. Open **Deployment → Production setup → Hermes nodes**.
2. Create an invitation with the runtime display name, slug, reachable Hermes base URL, approved image reference, and short TTL.
3. Copy the one-time claim. OrcaSynapse stores only its digest.
4. On VM2, download the installer from the OrcaSynapse URL shown by the dashboard.
5. Run it against the same OrcaSynapse origin, then paste the claim at the hidden prompt:

   ```bash
   curl -fsS https://orcasynapse.example.internal/install/hermes-node.sh -o orcasynapse-node-install.sh
   sudo env ORCASYNAPSE_SUPERMEMORY_VERSION=<exact-version> \
     bash orcasynapse-node-install.sh --connect https://orcasynapse.example.internal
   ```

6. Return to the dashboard and verify that Hermes, Supermemory, and the signed heartbeat are healthy.
7. Run the AI-services and Hermes-profile checks before activation.

For an offline administrative transfer, download the JSON bundle and run `sudo bash orcasynapse-node-install.sh enrollment.json` instead. Do not place the claim in a URL, command argument, or shell history.

## What the script does

1. validates the bundle and expiry;
2. installs required host packages when needed;
3. creates a local Ed25519 identity;
4. starts the constrained official Hermes container with persistent `/opt/data` and read-only `/etc/hermes` managed scope;
5. enrolls with the single-use claim;
6. receives the OrcaSynapse `/internal/v1` URL, approved model alias, and a node-scoped bearer key;
7. installs the checksum-verified Supermemory Local binary and starts it under a dedicated system user;
8. configures Supermemory to use the OrcaSynapse gateway and local embeddings;
9. installs/enables Hermes's native Supermemory provider with `orcasynapse-agent-{identity}` and custom containers disabled;
10. pins the model route and baseline guardrails in managed scope, disabling native API-server toolsets and default MCP discovery until an OrcaSynapse-reviewed distribution enables them;
11. registers the VM2 Supermemory endpoint and encrypted API key with OrcaSynapse;
12. starts a systemd timer that sends signed replay-protected heartbeats every minute.

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

Preferred host-loss procedure:

1. revoke the missing node in OrcaSynapse;
2. restore runtime data only under the approved recovery procedure, or create a clean node;
3. issue a new invitation and identity;
4. verify namespace isolation, inference gateway authentication, memory recall, document authorization, and deletion;
5. retain the recovery evidence.

## Upgrade

Do not use an invitation as a generic remote administrator. Upgrade with pinned, signed artifacts under customer change control. Before promotion, test the exact Hermes image, Supermemory binary/SDK, API contracts, state migration, backup, rollback, memory isolation, and agent cancellation in a non-production environment.
