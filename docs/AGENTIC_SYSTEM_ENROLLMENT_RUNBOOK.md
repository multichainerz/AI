# Agentic System Node Enrollment

## Purpose

This workflow turns a clean Ubuntu systemd VM into the isolated OrcaSynapse Agentic System. It installs the Hermes Agent runtime, configures it to use OrcaSynapse's authenticated inference gateway, and establishes a signed node identity without retaining SSH credentials.

VM2 runs exactly one plane: the Hermes gateway/API server, installed natively from Hermes's own installer and supervised by systemd as `orcasynapse-hermes.service`. It holds no durable data store - knowledge, and any future agent memory, are served by OrcaSynapse from its own pgvector plane, so a runtime host can be destroyed and re-enrolled without data loss. The installer uses Hermes's root-owned managed scope to pin the approved model route, secret redaction, unattended loop circuit breakers, and an explicit `platform_toolsets.api_server: [no_mcp]` baseline so the stock runtime does not inherit its broad default tool surface.

## Prerequisites

- OrcaSynapse is installed and the temporary local-administrator password has been replaced.
- PostgreSQL is healthy.
- exactly one AI Inference connection is enabled, healthy, and has a selected served model;
- an evaluated Agent model route is active;
- VM2 is a clean Ubuntu systemd VM on x86_64 or aarch64 with outbound access to OrcaSynapse and the artifact sources during installation;
- OrcaSynapse can reach the VM2 Hermes address on TCP 8642;
- the invitation uses a hostname/address that matches customer DNS and TLS policy.

Enter a Hermes commit in the dashboard invitation: the full 40-character git SHA of the runtime revision to install. A commit SHA is a content digest of the tree, so it is as immutable as the registry digest it replaces, and unlike a tag it cannot be moved to different code after review. OrcaSynapse requires one for Production enrollment; the installer reads the pin back out of the finished checkout and refuses to enroll if the installed revision is not the approved one.

## Dashboard workflow

1. Open **Platform → Agentic System**.
2. Create an invitation with the runtime display name, slug, reachable Hermes base URL, approved Hermes commit, and short TTL.
3. Copy the one-time claim. OrcaSynapse stores only its digest.
4. On VM2, download the installer from the OrcaSynapse URL shown by the dashboard. The route is unavailable before dashboard setup and healthy AI Inference are present. It remains available afterward for protected local recovery, while a live claim is required to begin a new enrollment.
5. Run it against the same OrcaSynapse origin, then paste the claim at the hidden prompt:

   ```bash
   curl -fsSL https://orcasynapse.example.internal/install/agentic-node.sh \
     | sudo bash -s -- --connect https://orcasynapse.example.internal
   ```

   **Expect step 4 to take 15-20 minutes on a first install, with long silent stretches.** It clones the Hermes repository and fetches the pinned commit (~180k objects), builds a Python virtual environment, and runs `npm install`. It is not hung. `--skip-browser` suppresses only the Chromium download, not the Node dependency install, and upstream offers no flag for the latter.

6. Return to the dashboard and verify that Hermes and the signed heartbeat are healthy.
7. Run the AI-services and Hermes-profile checks before activation.

For an offline administrative transfer, download the JSON bundle and run `sudo bash install-agentic-node.sh enrollment.json` instead. Do not place the claim in a URL, command argument, or shell history.

## Decommission a VM2 node

Revocation and destruction are intentionally separate. Revoke the node first to disable its runtime credential and generated service connections. Then select **Remove** beside the revoked node and follow the dashboard's two-stage flow:

1. Run the displayed `remove-agentic-node.sh` command on VM2 and type `DESTROY` at its local terminal. It stops and removes the `orcasynapse-hermes` unit, the Hermes installation, the service account, node identity, managed policy, and the heartbeat and desired-state timers. It preserves unrelated systemd units, Ubuntu packages, and external backups. Before any irreversible step it proves the unit is OrcaSynapse-managed - the unit file must carry `X-OrcaSynapse-Managed=true` or name the OrcaSynapse state root in `ReadWritePaths=` - and refuses to touch a Hermes someone else installed. The remover honors the same `ORCASYNAPSE_HERMES_STATE_ROOT` override the installer accepts and reports its own version in the completion panel.
2. Confirm the host-side result, type the exact node slug, and choose **Remove permanently**. OrcaSynapse transactionally removes the runtime-node record, enrollment claims, replay nonces, and the generated Hermes connection. The security audit event remains.

OrcaSynapse has no standing SSH credential or remote execution path on VM2, so host destruction is an explicit operator-attested action. If the VM has already been destroyed by the infrastructure platform, use that destruction event as the host-side evidence. Snapshot and backup retirement remains the infrastructure operator's responsibility.

## What the script does

1. validates the bundle and expiry;
2. installs required host packages when needed (`ca-certificates curl git jq openssl python3 xz-utils`);
3. creates a local Ed25519 identity;
4. installs Hermes at the approved commit, creates the unprivileged `orcasynapse-hermes` service account, and starts `orcasynapse-hermes.service` with persistent state under the OrcaSynapse state root and a read-only `/etc/hermes` managed scope;
5. enrolls with the single-use claim;
6. receives the OrcaSynapse `/internal/v1` URL, dashboard-selected model alias, and a node-scoped bearer key;
7. pins the model route and baseline guardrails in managed scope, disabling native API-server toolsets and default MCP discovery until an OrcaSynapse-reviewed distribution enables them;
8. starts a systemd timer that sends signed replay-protected heartbeats every minute.

After the claim is consumed, the installer writes a root-only `${ORCASYNAPSE_HERMES_STATE_ROOT:-/var/lib/orcasynapse-hermes}/enrollment-state.json` recovery journal before applying managed policy. If a later step fails, rerun the same command: the installer reuses the node identity and scoped configuration, repeats idempotent steps, and removes the recovery journal only after the heartbeat timer starts.

The node reports `ONLINE` once its Hermes API port answers. Treat that as transport health, not proof of generation: installation acceptance also submits a governed `/v1/runs` request because the agent can fail after the gateway has started. VM2 runs a single plane, so there is no longer a window in which the runtime is healthy but a second service is not.

The inference bootstrap never contains the upstream serving credential. Revoking a node disables its generated Hermes connection.

## Network allowlist

| Source | Destination | Required use |
| --- | --- | --- |
| VM2 | OrcaSynapse HTTPS | enrollment, heartbeat, inference gateway |
| OrcaSynapse | VM2 TCP 8642 | Hermes health and governed agent calls |
| VM2 | Ubuntu archive, `hermes-agent.nousresearch.com`, GitHub, PyPI, npm, `astral.sh` | installation and upgrade only - see below |

**Install-time egress is wider than it was under the container runtime, and this is a deliberate trade.** A native Hermes install resolves its own dependency chain - `uv`, a Python toolchain, Node - from the upstream sources above, and those transitive downloads are not checksum-pinned by us. The pin covers the Hermes revision itself, not every dependency it pulls.

**Observed, and worth stating plainly: the dependency set is not reproducible.** Hermes's installer tries a hash-verified `uv.lock` tier first, and at a pinned commit it can fail (`the lockfile needs to be updated, but --locked was provided`) and fall back to a live PyPI resolve, which it reports as `installed via fallback tier`. Two nodes enrolled a month apart therefore run identical Hermes code and possibly different dependency versions. The commit pin is an accurate statement about the runtime tree and *not* a statement about the whole installed environment. Where reproducibility of the full dependency set is a requirement, that has to come from an internal mirror rather than from this installer. This egress is needed only while `install-agentic-node.sh` runs; once the node is enrolled, steady-state traffic is the two rows above and nothing else, so the allowlist can be narrowed again after installation.

**An air-gapped install is not supported on this path.** The previous container image could be mirrored into an internal registry and installed with no public egress; a native install cannot, because the dependency resolution happens on the host at install time. An air-gapped deployment needs an internal mirror of each source above, which is outside what this installer does today. Treat that as a known limitation when planning a disconnected production environment.

Deny VM2 access to OrcaSynapse PostgreSQL, enterprise storage administration, hypervisor/deployment APIs, and unrestricted external networks. Do not expose port 8642 to user networks or the public internet.

## Secrets and state

- `${ORCASYNAPSE_HERMES_STATE_ROOT:-/var/lib/orcasynapse-hermes}` contains node identity (root-only, mode 0700), the Hermes application state at `data/`, and its OS home/runtime workspace at `home/`. Both runtime directories are owned by the `orcasynapse-hermes` service account. The systemd unit explicitly binds `HOME` and `WorkingDirectory` to `home/`, while root-owned managed policy pins Hermes's `terminal.cwd` there; this keeps runtime work inside the writable state root while `ProtectHome=yes` continues to hide the host's conventional home directories. The state root itself is mode 0711: the service account must traverse it to reach its directories, but must not be able to list or read the identity beside them.
- Managed policy is a root-owned `/etc/hermes/config.yaml`. The unit's `ReadOnlyPaths=` makes it unwritable to the running service, which is what the read-only bind mount used to provide.
- OrcaSynapse stores encrypted Hermes and inference-gateway secrets in PostgreSQL.
- The invitation token is single-use, bound to the OrcaSynapse control-plane origin, and expires even if never consumed.
- The node private key never leaves VM2.

Restrict journal readers on VM2 and include key rotation and journal-retention behavior in production acceptance.

## Backup and restore

Back up `${ORCASYNAPSE_HERMES_STATE_ROOT:-/var/lib/orcasynapse-hermes}/data` for sessions, Skills, profiles, built-in memory, and runtime configuration. Knowledge and control-plane state live in PostgreSQL and are covered by the database backup.

Preferred host-loss procedure:

1. revoke the missing node in OrcaSynapse;
2. restore runtime data only under the approved recovery procedure, or create a clean node;
3. issue a new invitation and identity;
4. verify inference gateway authentication, document authorization, and deletion;
5. retain the recovery evidence.

## Upgrade

Do not use an invitation as a generic remote administrator. Upgrade with pinned artifacts under customer change control: an upgrade is a new invitation naming a new Hermes commit, followed by a re-enrollment. Before promotion, test the exact Hermes commit, API contracts, state migration, backup, rollback, and agent cancellation in a non-production environment.

Hermes's own installer ignores `--commit` when the existing checkout is already newer, which would leave a host running a revision the control plane never approved. OrcaSynapse passes `--force-commit` so the approved pin always wins, including a deliberate downgrade to an earlier approved commit, and then reads the commit back out of the finished checkout rather than trusting the value it asked for.

### Repair the runtime boundary without re-enrollment

An already-enrolled node whose Hermes gateway is healthy but whose runs fail against `/home/orcasynapse-hermes` can reconcile the service account and hardened unit without rotating identity or credentials:

```bash
curl -fsSL https://orcasynapse.example.internal/install/agentic-node.sh \
  | sudo bash -s -- --repair
```

The repair mode requires an intact completed enrollment and an OrcaSynapse-owned systemd unit. It changes only the service account home, managed runtime directories, and runtime unit, then restarts Hermes and verifies `/health`. It refuses incomplete state and units it cannot prove OrcaSynapse owns.
