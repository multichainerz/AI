# OrcaSynapse Installation Bootstrap

On a clean Debian or Ubuntu server, run the public bootstrap from the OrcaSynapse repository:

```bash
curl -fsSL https://raw.githubusercontent.com/multichainerz/AI/main/install.sh | sudo bash
```

For an inspect-first workflow that does not open a full-screen pager:

```bash
curl --proto '=https' --tlsv1.2 -fsSLo orcasynapse-install.sh \
  https://raw.githubusercontent.com/multichainerz/AI/main/install.sh
sed -n '1,240p' orcasynapse-install.sh
sudo bash orcasynapse-install.sh
```

The one-line form is the default convenience path; the inspect-first form is available for controlled environments without opening a terminal pager. The installer automatically uses plain output when no interactive terminal is attached, and `NO_COLOR=1` disables terminal colors.

The bootstrap resolves `ORCASYNAPSE_REF` (default `main`) to an immutable Git commit, downloads that commit from GitHub, records the source identity under `/opt/orcasynapse`, and handles an existing path through the guarded recovery flow below. An acceptance environment should set an approved commit and checksum explicitly:

```bash
sudo env ORCASYNAPSE_REF=<40-character-commit> ORCASYNAPSE_ARCHIVE_SHA256=<sha256> bash install.sh
```

When `/opt/orcasynapse` already exists, the installer distinguishes a verified earlier installation from unknown residue. A verified installation offers a default in-place source update that preserves PostgreSQL volumes, protected secrets, and recovery material. A clean reinstall is also available, but only after a separate `ERASE` confirmation because it permanently removes the Compose stack, named data volumes, accounts, and local secrets. Unknown directories cannot use the preservation path. Non-interactive automation must explicitly set `ORCASYNAPSE_EXISTING_INSTALL_ACTION=upgrade|erase|abort`; automated erase additionally requires `ORCASYNAPSE_CONFIRM_ERASE=ERASE`.

From an intact local release bundle, the equivalent host command is:

```bash
sudo ./scripts/install-orcasynapse.sh
```

The installer runs six steps: it checks or installs Docker Compose v2, OpenSSL, and curl; **preflights the host** (Docker daemon, port collision, disk space, memory, existing-state summary) before any mutation; builds the release; generates the database password, credential-encryption key, and permanent Installation Key in a root-only host directory; starts the stack (PostgreSQL runs the bundled `pgvector/pgvector:pg17` image — the migrator creates the `vector` extension for the knowledge index) and waits for readiness; and provisions a PostgreSQL-backed local `admin` account. Application-secret files use a narrowly scoped container group so the non-root API, worker, and migration processes can read only the secrets explicitly mounted into them. It prints the one-time temporary password and requires replacement at first sign-in. It separately prints the Installation Key, which must be stored offline in the organization vault and is accepted only for local-account recovery.

The banner and summary show the release version and source commit read from the extracted tree. A secret-free install log is written to `.local/state/install-<timestamp>.log` and a machine-readable completion marker to `.local/state/install-complete.json` (the printed temporary password and Installation Key never enter the log). Data volumes created before the pgvector base-image switch are reindexed once automatically after startup (musl-to-glibc collation change); the marker `.local/state/postgres-libc-reindexed` records completion.

Set `ORCASYNAPSE_HTTP_PORT` before invoking the script to use a port other than `8080`. Terminate TLS at a customer-approved reverse proxy or load balancer before using OrcaSynapse outside a protected deployment network. That upstream proxy must overwrite `X-Forwarded-Proto`, and direct access to the OrcaSynapse HTTP port must remain restricted; OrcaSynapse's bundled Nginx discards inbound forwarding chains and reports only its direct peer to the API.

The installer refuses to overwrite any partial secret set. A complete existing set is preserved for idempotent restarts. It does not take an SSH password, mount the Docker socket into OrcaSynapse, or grant the dashboard host-level command execution.

## Enroll an isolated Agentic System VM

For Control-plane only or Segmented production, prepare a second Ubuntu systemd VM with private network reachability in both directions. First replace the temporary dashboard password and configure exactly one healthy AI Inference route with a discovered model. Then open **Deployment > Agentic System**, enter the VM2 API address and the OrcaSynapse address visible from VM2, and issue the short-lived enrollment claim.

The VM2 installer is not a permanently public static asset. OrcaSynapse serves the non-secret script through a readiness-gated API only after dashboard setup is complete and AI Inference is healthy and seedable. The script remains available after enrollment so an interrupted VM2 can resume with its protected local recovery state; a live one-time claim is still required to begin a new enrollment.

On VM2, run the installer served by the customer-owned OrcaSynapse host against that same origin:

```bash
curl -fsSL https://orcasynapse.example.internal/install/agentic-node.sh \
  | sudo bash -s -- --connect https://orcasynapse.example.internal
```

Paste the short-lived claim displayed by the dashboard at the hidden prompt. The token is submitted in a redacted POST body rather than a URL or shell-history argument. The downloaded JSON bundle remains an offline fallback: `sudo bash install-agentic-node.sh enrollment.json`.

VM2 generates its Ed25519 private key locally, starts the official Hermes gateway container, exchanges the claim once, registers its Hermes service route, and enables a signed one-minute heartbeat timer. The OrcaSynapse-selected model route and baseline guardrails are installed through Hermes's root-owned managed scope mounted read-only at `/etc/hermes`; runtime secrets remain in the protected Hermes data volume. OrcaSynapse never receives the node private key, reusable SSH credentials, or a Docker socket. A current heartbeat proves VM2-to-OrcaSynapse reachability; healthy generated connections prove OrcaSynapse-to-VM2 reachability.

Before Production, replace tagged images with digest-pinned approved artifacts, terminate OrcaSynapse enrollment traffic with customer-approved TLS, limit Hermes TCP/8642 to OrcaSynapse, restrict VM2 egress to OrcaSynapse plus approved MCP destinations, and complete the customer PKI/mTLS acceptance gate. Application signatures do not replace transport encryption or network policy.

If the retained Installation Key must be replaced, a customer with local root authority can invoke the break-glass rotation flow:

```bash
sudo ./scripts/rotate-installation-key.sh --confirm-revoke-recovery-sessions
```

This replaces the root-owned key file, immediately revokes recovery sessions, and recreates the API. The next recovery use records the new verifier in PostgreSQL. Local-password and federated OIDC sessions are otherwise independent. Routine administration uses the local account or mapped OIDC groups, including Microsoft Entra ID; the Installation Key remains the on-premises break-glass path.

## Manual development flow

For a developer workstation with Node.js and Docker already installed:

```bash
docker compose build
node scripts/generate-bootstrap.mjs
docker compose up -d --no-build
pnpm admin:provision
```

The provisioning command prints the temporary `admin` password only when it creates the account. Read `.local/secrets/orcasynapse_installation_key` through an approved local secret-reading workflow and store it offline in a password vault; the development generator deliberately does not print secret material to logs.

The generator writes the following files under the Git-ignored `.local/secrets` directory and refuses to replace any existing file:

- `postgres_password`
- `orcasynapse_database_url`
- `orcasynapse_master_key`
- `orcasynapse_installation_key` (permanent, offline local-account recovery credential)

After first sign-in, use **Deployment > Identity and recovery** to export the encrypted recovery kit, move it off the OrcaSynapse host, and verify the retained copy in the dashboard. The local password, Installation Key, and credential-encryption master key have separate purposes: possession of either authentication credential never decrypts stored connector secrets. The recovery kit and its passphrase must be held separately according to customer policy.

Routine service endpoints, API keys, model aliases, operational settings, and connectors are entered through the dashboard and encrypted in PostgreSQL. OrcaSynapse does not deploy HashiCorp Vault, use environment files for routine connectors, accept reusable server credentials, or keep source documents as a permanent file store.

The public bootstrap and bundled installer preserve separation between PostgreSQL data, the credential-encryption key, the Installation Key, and the off-host recovery kit. A resolved Git commit and archive checksum provide reproducibility, not publisher authenticity. Production release publication still needs OrcaSynapse's signed release manifest and image-digest pipeline; neither a branch download nor a local repository checkout proves publisher signature provenance.
