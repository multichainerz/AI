# Hermes and Supermemory Node Enrollment

## Purpose

This workflow turns a clean Debian/Ubuntu VM into the isolated AIHub agent runtime. It installs Hermes Agent and Supermemory Local, configures both to use AIHub's authenticated inference gateway, and establishes a signed node identity without retaining SSH credentials.

The installer follows the current upstream integration model: Hermes runs its official Docker gateway/API server, external memory providers are additive to built-in `MEMORY.md`/`USER.md`, and Supermemory Local is a single self-hosted binary with embedded graph storage and local embeddings. It writes an explicit `platform_toolsets.api_server: [no_mcp]` baseline so the official Hermes image does not inherit its broad default tool surface.

## Prerequisites

- AIHub is installed and claimed.
- PostgreSQL is healthy.
- exactly one vLLM connection is enabled and healthy;
- an evaluated Agent model route is active;
- VM2 is a clean supported Linux host with outbound access to AIHub and the artifact sources during installation;
- AIHub can reach the VM2 Hermes address on TCP 8642 and Supermemory address on TCP 6767;
- the invitation uses a hostname/address that matches customer DNS and TLS policy.

For production, use a Hermes image digest and set `AIHUB_SUPERMEMORY_VERSION` to an exact release. Validate the Hermes `supermemory` Python package version as part of the bill of materials.

## Dashboard workflow

1. Open **Deployment → Production setup → Hermes nodes**.
2. Create an invitation with the runtime display name, slug, reachable Hermes base URL, approved image reference, and short TTL.
3. Download the generated JSON bundle. AIHub stores only the token digest.
4. Transfer the bundle and `scripts/install-hermes-node.sh` to VM2 through the customer's approved channel.
5. Run:

   ```bash
   sudo AIHUB_SUPERMEMORY_VERSION=<exact-version> ./install-hermes-node.sh enrollment.json
   ```

6. Return to the dashboard and verify that Hermes, Supermemory, and the signed heartbeat are healthy.
7. Run the AI-services and Hermes-profile checks before activation.

## What the script does

1. validates the bundle and expiry;
2. installs required host packages when needed;
3. creates a local Ed25519 identity;
4. starts the constrained official Hermes container with persistent `/opt/data`;
5. enrolls with the single-use claim;
6. receives the AIHub `/internal/v1` URL, approved model alias, and a node-scoped bearer key;
7. installs the checksum-verified Supermemory Local binary and starts it under a dedicated system user;
8. configures Supermemory to use the AIHub gateway and local embeddings;
9. installs/enables Hermes's native Supermemory provider with `mpm-agent-{identity}` and custom containers disabled;
10. disables native API-server toolsets and default MCP discovery until an AIHub-reviewed distribution enables them;
11. registers the VM2 Supermemory endpoint and encrypted API key with AIHub;
12. starts a systemd timer that sends signed replay-protected heartbeats every minute.

The inference bootstrap never contains the vLLM credential. Revoking a node disables its generated Hermes connection and managed Supermemory connection.

Supermemory auto-recall and auto-capture remain active in this baseline because the memory provider is not a native model-callable toolset.

## Network allowlist

| Source | Destination | Required use |
| --- | --- | --- |
| VM2 | AIHub HTTPS | enrollment, memory registration, heartbeat, inference gateway |
| AIHub | VM2 TCP 8642 | Hermes health and governed agent calls |
| AIHub worker | VM2 TCP 6767 | document publication and authorized retrieval |
| Hermes container | VM2 TCP 6767 | native long-term memory |
| VM2 | approved artifact registries | installation/upgrade only; mirror internally for air-gapped production |

Deny VM2 access to AIHub PostgreSQL, host Docker APIs, enterprise storage administration, hypervisor/deployment APIs, and unrestricted external networks. Do not expose ports 8642 or 6767 to user networks or the public internet.

## Secrets and state

- `${AIHUB_HERMES_STATE_ROOT:-/var/lib/aihub-hermes}` contains node identity and the Hermes data volume.
- `${AIHUB_SUPERMEMORY_STATE_ROOT:-/var/lib/aihub-supermemory}` contains the binary, runtime environment, API key, and graph data.
- AIHub stores encrypted Hermes, inference-gateway, and Supermemory secrets in PostgreSQL.
- The invitation token is single-use, bound to the AIHub control-plane origin, and expires even if never consumed.
- The node private key never leaves VM2.

System journal access is root-equivalent for this workflow because Supermemory prints its generated API key on first boot. Restrict journal readers, complete registration promptly, and include key rotation/journal-retention behavior in production acceptance.

## Backup and restore

Back up Hermes `/opt/data` for sessions, Skills, profiles, built-in memory, and runtime configuration. Back up the complete Supermemory data directory consistently for graph, auth, and local-embedding state. PostgreSQL backup alone cannot reconstruct either runtime.

Preferred host-loss procedure:

1. revoke the missing node in AIHub;
2. restore runtime data only under the approved recovery procedure, or create a clean node;
3. issue a new invitation and identity;
4. verify namespace isolation, inference gateway authentication, memory recall, document authorization, and deletion;
5. retain the recovery evidence.

## Upgrade

Do not use an invitation as a generic remote administrator. Upgrade with pinned, signed artifacts under customer change control. Before promotion, test the exact Hermes image, Supermemory binary/SDK, API contracts, state migration, backup, rollback, memory isolation, and agent cancellation in a non-production environment.
