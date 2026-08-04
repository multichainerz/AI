# Agentic System Node Enrollment

## Purpose

This workflow turns a clean Ubuntu systemd VM into the isolated OrcaSynapse Agentic System. It installs the Hermes Agent runtime, configures it to use OrcaSynapse's authenticated inference gateway, and establishes a signed node identity without retaining SSH credentials.

VM2 runs exactly one plane: Hermes's official Docker gateway/API server. It holds no durable data store - knowledge, and any future agent memory, are served by OrcaSynapse from its own pgvector plane, so a runtime host can be destroyed and re-enrolled without data loss. The installer uses Hermes's root-owned managed scope to pin the approved model route, secret redaction, unattended loop circuit breakers, and an explicit `platform_toolsets.api_server: [no_mcp]` baseline so the official image does not inherit its broad default tool surface.

## Prerequisites

- OrcaSynapse is installed and the temporary local-administrator password has been replaced.
- PostgreSQL is healthy.
- exactly one AI Inference connection is enabled, healthy, and has a selected served model;
- an evaluated Agent model route is active;
- VM2 is a clean Ubuntu systemd VM on x86_64 or aarch64 with outbound access to OrcaSynapse and the artifact sources during installation;
- OrcaSynapse can reach the VM2 Hermes address on TCP 8642;
- the invitation uses a hostname/address that matches customer DNS and TLS policy.

For production, enter a Hermes image digest in the dashboard invitation. OrcaSynapse rejects mutable `latest` artifacts in Production. In Development, the installer may accept a tag from the invitation but resolves the pull to its registry digest before starting, enrolling, or reporting the runtime.

## Dashboard workflow

1. Open **Deployment → Agentic System**.
2. Create an invitation with the runtime display name, slug, reachable Hermes base URL, approved image reference, and short TTL.
3. Copy the one-time claim. OrcaSynapse stores only its digest.
4. On VM2, download the installer from the OrcaSynapse URL shown by the dashboard. The route is unavailable before dashboard setup and healthy AI Inference are present. It remains available afterward for protected local recovery, while a live claim is required to begin a new enrollment.
5. Run it against the same OrcaSynapse origin, then paste the claim at the hidden prompt:

   ```bash
   curl -fsSL https://orcasynapse.example.internal/install/agentic-node.sh \
     | sudo bash -s -- --connect https://orcasynapse.example.internal
   ```

6. Return to the dashboard and verify that Hermes and the signed heartbeat are healthy.
7. Run the AI-services and Hermes-profile checks before activation.

For an offline administrative transfer, download the JSON bundle and run `sudo bash install-agentic-node.sh enrollment.json` instead. Do not place the claim in a URL, command argument, or shell history.

## Decommission a VM2 node

Revocation and destruction are intentionally separate. Revoke the node first to disable its runtime credential and generated service connections. Then select **Remove** beside the revoked node and follow the dashboard's two-stage flow:

1. Run the displayed `remove-agentic-node.sh` command on VM2 and type `DESTROY` at its local terminal. It stops and removes the managed Hermes container, node identity, managed policy, and heartbeat units. It preserves Docker, unrelated containers, Ubuntu packages, and external backups. The remover honors the same `ORCASYNAPSE_HERMES_STATE_ROOT` override the installer accepts, removes the recorded Hermes image layers even when the container was already deleted by hand, and reports its own version in the completion panel.
2. Confirm the host-side result, type the exact node slug, and choose **Remove permanently**. OrcaSynapse transactionally removes the runtime-node record, enrollment claims, replay nonces, and the generated Hermes connection. The security audit event remains.

OrcaSynapse has no standing SSH credential or Docker socket on VM2, so host destruction is an explicit operator-attested action. If the VM has already been destroyed by the infrastructure platform, use that destruction event as the host-side evidence. Snapshot and backup retirement remains the infrastructure operator's responsibility.

## What the script does

1. validates the bundle and expiry;
2. installs required host packages when needed;
3. creates a local Ed25519 identity;
4. starts the constrained official Hermes container with persistent `/opt/data` and read-only `/etc/hermes` managed scope;
5. enrolls with the single-use claim;
6. receives the OrcaSynapse `/internal/v1` URL, dashboard-selected model alias, and a node-scoped bearer key;
7. pins the model route and baseline guardrails in managed scope, disabling native API-server toolsets and default MCP discovery until an OrcaSynapse-reviewed distribution enables them;
8. starts a systemd timer that sends signed replay-protected heartbeats every minute.

After the claim is consumed, the installer writes a root-only `${ORCASYNAPSE_HERMES_STATE_ROOT:-/var/lib/orcasynapse-hermes}/enrollment-state.json` recovery journal before applying managed policy. If a later step fails, rerun the same command: the installer reuses the node identity and scoped configuration, repeats idempotent steps, and removes the recovery journal only after the heartbeat timer starts.

The node reports `ONLINE` once its Hermes API port answers. VM2 runs a single plane, so there is no longer a window in which the runtime is healthy but a second service is not.

The inference bootstrap never contains the upstream serving credential. Revoking a node disables its generated Hermes connection.

## Network allowlist

| Source | Destination | Required use |
| --- | --- | --- |
| VM2 | OrcaSynapse HTTPS | enrollment, heartbeat, inference gateway |
| OrcaSynapse | VM2 TCP 8642 | Hermes health and governed agent calls |
| VM2 | approved artifact registries | installation/upgrade only; mirror internally for air-gapped production |

Deny VM2 access to OrcaSynapse PostgreSQL, host Docker APIs, enterprise storage administration, hypervisor/deployment APIs, and unrestricted external networks. Do not expose port 8642 to user networks or the public internet.

## Secrets and state

- `${ORCASYNAPSE_HERMES_STATE_ROOT:-/var/lib/orcasynapse-hermes}` contains node identity, the Hermes data volume, and root-owned managed policy mounted read-only into the container.
- OrcaSynapse stores encrypted Hermes and inference-gateway secrets in PostgreSQL.
- The invitation token is single-use, bound to the OrcaSynapse control-plane origin, and expires even if never consumed.
- The node private key never leaves VM2.

Restrict journal readers on VM2 and include key rotation and journal-retention behavior in production acceptance.

## Backup and restore

Back up Hermes `/opt/data` for sessions, Skills, profiles, built-in memory, and runtime configuration. Knowledge and control-plane state live in PostgreSQL and are covered by the database backup.

Preferred host-loss procedure:

1. revoke the missing node in OrcaSynapse;
2. restore runtime data only under the approved recovery procedure, or create a clean node;
3. issue a new invitation and identity;
4. verify inference gateway authentication, document authorization, and deletion;
5. retain the recovery evidence.

## Upgrade

Do not use an invitation as a generic remote administrator. Upgrade with pinned, signed artifacts under customer change control. Before promotion, test the exact Hermes image, API contracts, state migration, backup, rollback, and agent cancellation in a non-production environment.
