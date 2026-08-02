# OrcaSynapse Installation Bootstrap

On a clean Debian or Ubuntu server, run the public bootstrap from the OrcaSynapse repository:

```bash
curl --proto '=https' --tlsv1.2 -fsSLo orcasynapse-install.sh \
  https://raw.githubusercontent.com/multichainerz/AI/main/install.sh
sudo bash orcasynapse-install.sh
```

For an inspect-first workflow that does not open a full-screen pager:

```bash
curl --proto '=https' --tlsv1.2 -fsSLo orcasynapse-install.sh \
  https://raw.githubusercontent.com/multichainerz/AI/main/install.sh
sed -n '1,240p' orcasynapse-install.sh
sudo bash orcasynapse-install.sh
```

`less install.sh` only displayed the file in a terminal pager; it was not an installation step. Pressing `q` exits `less`. The installer automatically uses plain output when no interactive terminal is attached, and `NO_COLOR=1` explicitly disables terminal colors.

The bootstrap resolves `ORCASYNAPSE_REF` (default `main`) to an immutable Git commit, downloads that commit from GitHub, records the source identity under `/opt/orcasynapse`, and refuses to overwrite a different installation. An acceptance environment should set an approved commit and checksum explicitly:

```bash
sudo env ORCASYNAPSE_REF=<40-character-commit> ORCASYNAPSE_ARCHIVE_SHA256=<sha256> bash install.sh
```

From an intact local release bundle, the equivalent host command is:

```bash
sudo ./scripts/install-orcasynapse.sh
```

The installer checks or installs Docker Compose v2, OpenSSL, and curl; builds the release; generates the database password, credential-encryption key, and permanent Installation Key with root-only permissions; starts the stack; waits for readiness; and provisions a PostgreSQL-backed local `admin` account. It prints the one-time temporary password and requires replacement at first sign-in. It separately prints the Installation Key, which must be stored offline in the organization vault and is accepted only for local-account recovery.

Set `ORCASYNAPSE_HTTP_PORT` before invoking the script to use a port other than `8080`. Terminate TLS at a customer-approved reverse proxy or load balancer before using OrcaSynapse outside a protected deployment network. That upstream proxy must overwrite `X-Forwarded-Proto`, and direct access to the OrcaSynapse HTTP port must remain restricted; OrcaSynapse's bundled Nginx discards inbound forwarding chains and reports only its direct peer to the API.

The installer refuses to overwrite any partial secret set. A complete existing set is preserved for idempotent restarts. It does not take an SSH password, mount the Docker socket into OrcaSynapse, or grant the dashboard host-level command execution.

## Enroll an isolated Hermes VM

For Control-plane only or Segmented production, prepare a second Debian or Ubuntu VM with private network reachability in both directions. In the dashboard, open **Deployment > Hermes nodes**, enter the VM2 API address and the OrcaSynapse address visible from VM2, then issue the short-lived enrollment claim.

On VM2, download the installer from the customer-owned OrcaSynapse host and run it against that same origin:

```bash
curl -fsS https://orcasynapse.example.internal/install/hermes-node.sh -o install-hermes-node.sh
sudo bash install-hermes-node.sh --connect https://orcasynapse.example.internal
```

Paste the short-lived claim displayed by the dashboard at the hidden prompt. The token is submitted in a redacted POST body rather than a URL or shell-history argument. The downloaded JSON bundle remains an offline fallback: `sudo bash install-hermes-node.sh enrollment.json`.

VM2 generates its Ed25519 private key locally, starts the official Hermes gateway container, exchanges the claim once, installs checksum-verified Supermemory Local with local embeddings, enables Hermes's scoped native Supermemory provider, registers both service routes, and enables a signed one-minute heartbeat timer. The OrcaSynapse-selected model route and baseline guardrails are installed through Hermes's root-owned managed scope mounted read-only at `/etc/hermes`; runtime secrets remain in the protected Hermes data volume. OrcaSynapse never receives the node private key, reusable SSH credentials, or a Docker socket. A current heartbeat proves VM2-to-OrcaSynapse reachability; healthy generated connections prove OrcaSynapse-to-VM2 reachability.

Before Production, replace tagged images and unpinned Supermemory versions with approved artifacts, terminate OrcaSynapse enrollment traffic with customer-approved TLS, limit Hermes TCP/8642 and Supermemory TCP/6767 to OrcaSynapse, restrict VM2 egress to OrcaSynapse plus approved MCP destinations, and complete the customer PKI/mTLS acceptance gate. Application signatures do not replace transport encryption or network policy.

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
