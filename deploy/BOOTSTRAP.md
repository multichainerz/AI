# OrcaSynapse Installation Bootstrap

## Host sizing

VM1 needs at least **2 vCPU, 4 GiB of memory, and 5 GiB of free disk**; **4 vCPU and 8 GiB** is the recommended production control-plane allocation. Disk is the only hard requirement of the three. The installer measures all three before dependency installation, so a host that misses the disk requirement is refused before Docker is installed or enabled. Docker daemon and HTTP-port checks necessarily run after Docker is available.

On a clean Debian or Ubuntu server, run the public bootstrap from the OrcaSynapse repository:

```bash
curl -fsSL https://raw.githubusercontent.com/multichainerz/AI/main/install.sh | sudo bash
```

Behind an upstream TLS terminator, declare the scheme browsers really use — see **Public scheme** below — by adding the flag to the same command:

```bash
curl -fsSL https://raw.githubusercontent.com/multichainerz/AI/main/install.sh \
  | sudo bash -s -- --public-scheme https
```

For an inspect-first workflow that does not open a full-screen pager:

```bash
curl --proto '=https' --tlsv1.2 -fsSLo orcasynapse-install.sh \
  https://raw.githubusercontent.com/multichainerz/AI/main/install.sh
sed -n '1,240p' orcasynapse-install.sh
sudo bash orcasynapse-install.sh --public-scheme https
```

The one-line form is the default convenience path; the inspect-first form is available for controlled environments without opening a terminal pager. Both accept `--public-scheme http|https`, and omitting it leaves the safe `http` default. The installer automatically uses plain output when no interactive terminal is attached, and `NO_COLOR=1` disables terminal colors.

The bootstrap resolves `ORCASYNAPSE_REF` (default `main`) to an immutable Git commit, downloads that commit from GitHub, records the source identity under `/opt/orcasynapse`, and handles an existing path through the guarded recovery flow below. An acceptance environment should set an approved commit and checksum explicitly:

```bash
sudo env ORCASYNAPSE_REF=<40-character-commit> ORCASYNAPSE_ARCHIVE_SHA256=<sha256> bash install.sh
```

When `/opt/orcasynapse` already exists, the installer distinguishes a verified installation with the current `hermes-native-v1` schema epoch from older or unknown state. Only a current-epoch installation can use the in-place source update that preserves PostgreSQL volumes, protected secrets, and recovery material. Pre-v3.16 installations require a clean reinstall, after a separate `ERASE` confirmation because it permanently removes the Compose stack, named data volumes, accounts, and local secrets. Non-interactive automation must explicitly set `ORCASYNAPSE_EXISTING_INSTALL_ACTION=upgrade|erase|abort`; automated erase additionally requires `ORCASYNAPSE_CONFIRM_ERASE=ERASE`.

From an intact local release bundle, the equivalent host command is:

```bash
sudo ./scripts/install-orcasynapse.sh --public-scheme https
```

The installer runs six steps: it sizes and preflights the host; checks or installs Docker Compose v2, OpenSSL, and curl; builds the release; generates the database password, credential-encryption key, and permanent Installation Key in a root-only host directory; starts the stack with stock PostgreSQL 17 and waits for readiness; then provisions a PostgreSQL-backed local `admin` account. Application-secret files use a narrowly scoped container group so non-root services can read only the secrets explicitly mounted into them. It prints the one-time temporary password and requires replacement at first sign-in. It separately prints the Installation Key, which must be stored offline in the organization vault and is accepted only for local-account recovery.

The banner and summary show the release version and source commit read from the extracted tree. The summary also states the public scheme in force and, when it is `http`, says plainly that the administrator and enterprise session cookies are not `Secure`. A secret-free install log is written to `.local/state/install-<timestamp>.log` and a machine-readable completion marker to `.local/state/install-complete.json`; the temporary password and Installation Key never enter either.

Set `ORCASYNAPSE_HTTP_PORT` before invoking the script to use a port other than `8080`.

### Public scheme

Terminate TLS at a customer-approved reverse proxy or load balancer before using OrcaSynapse outside a protected deployment network, and declare that with `--public-scheme https`. The bundled Nginx listens on plain HTTP, so it cannot observe the TLS an upstream terminator provides; this flag is the operator's declaration of the scheme browsers really use, and it is the only thing that makes the administrator and enterprise session cookies `Secure`. Declare it only where TLS genuinely terminates upstream — over cleartext a `Secure` cookie is one the browser never sends back. Omitted, the scheme stays `http`, which withholds `Secure` rather than claiming a TLS session the deployment does not have.

It is a flag rather than an environment variable because every command on this page runs through `sudo`, and stock sudoers is `Defaults env_reset`: an exported `ORCASYNAPSE_PUBLIC_SCHEME` is discarded before the script starts, which silently produced plain-HTTP cookies on deployments that had declared `https`. Where an environment variable is genuinely more convenient, `sudo env ORCASYNAPSE_PUBLIC_SCHEME=https ...` and `sudo -E` both work, and both are treated as the same explicit declaration as the flag.

The declaration is recorded in the root-only `.local/state/public-scheme` — an operator setting, never a secret, and never written into `.local/secrets`. Re-running the installer, and the break-glass `rotate-installation-key.sh` below, read it back rather than re-deriving the default, so neither can silently return a correct installation to `http`. Passing the flag again replaces the recorded value and says so. An installation created before this was recorded has nothing to read back: declare the scheme once more on the next install or rotation, and it is remembered from then on. Restarting the stack by hand with `docker compose up -d` bypasses both scripts and both records, so use the scripts, or pass `ORCASYNAPSE_PUBLIC_SCHEME` to that command yourself.

Nothing a client sends can substitute for that declaration: OrcaSynapse's bundled Nginx discards inbound forwarding chains, overwriting `X-Forwarded-Proto` with the declared scheme and `X-Forwarded-For` with its own direct peer, so the upstream proxy's forwarding headers are neither required nor honoured. Direct access to the OrcaSynapse HTTP port must remain restricted.

The installer refuses to overwrite any partial secret set. A complete existing set is preserved for idempotent restarts. It does not take an SSH password, mount the Docker socket into OrcaSynapse, or grant the dashboard host-level command execution.

## Enroll an isolated Agentic System VM

For Control-plane only or Segmented production, prepare a second Ubuntu systemd VM with private network reachability in both directions. First replace the temporary administrator password and configure exactly one healthy AI Inference route with a discovered model. Then open **Platform > Agentic System**, enter the VM2 API address and the OrcaSynapse address visible from VM2, and issue the short-lived enrollment claim.

The VM2 installer is not a permanently public static asset. OrcaSynapse serves the non-secret script through a readiness-gated API only after dashboard setup is complete and AI Inference is healthy and seedable. The script remains available after enrollment so an interrupted VM2 can resume with its protected local recovery state; a live one-time claim is still required to begin a new enrollment.

On VM2, run the installer served by the customer-owned OrcaSynapse host against that same origin:

```bash
curl -fsSL https://orcasynapse.example.internal/install/agentic-node.sh \
  | sudo bash -s -- --connect https://orcasynapse.example.internal
```

Paste the short-lived claim displayed by the dashboard at the hidden prompt. The token is submitted in a redacted POST body rather than a URL or shell-history argument. The downloaded JSON bundle remains an offline fallback: `sudo bash install-agentic-node.sh enrollment.json`.

VM2 generates its Ed25519 private key locally, installs the Hermes gateway at the approved commit, starts it as `orcasynapse-hermes.service`, exchanges the claim once, registers its Hermes service route, and enables a signed one-minute heartbeat timer. The OrcaSynapse-selected model route and baseline guardrails are installed through Hermes's root-owned managed scope at `/etc/hermes`, which the unit makes read-only to the running service; runtime secrets remain in the protected Hermes data directory under the OrcaSynapse state root. OrcaSynapse never receives the node private key, reusable SSH credentials, or a remote execution channel. A current heartbeat proves VM2-to-OrcaSynapse reachability; healthy generated connections prove OrcaSynapse-to-VM2 reachability.

Before Production, name an approved Hermes commit in the invitation, terminate OrcaSynapse enrollment traffic with customer-approved TLS, limit Hermes TCP/8642 to OrcaSynapse, restrict VM2 egress to OrcaSynapse plus approved MCP destinations, and complete the customer PKI/mTLS acceptance gate. Note that VM2's install-time egress is wider than its steady-state egress because a native Hermes install resolves its own dependency chain; see the network allowlist in [AGENTIC_SYSTEM_ENROLLMENT_RUNBOOK.md](../docs/AGENTIC_SYSTEM_ENROLLMENT_RUNBOOK.md). Application signatures do not replace transport encryption or network policy.

If the retained Installation Key must be replaced, a customer with local root authority can invoke the break-glass rotation flow:

```bash
sudo ./scripts/rotate-installation-key.sh --confirm-revoke-recovery-sessions
```

This replaces the root-owned key file, immediately revokes recovery sessions, and recreates the API. The next recovery use records the new verifier in PostgreSQL. Local-password and federated OIDC sessions are otherwise independent. Routine administration uses the local account or mapped OIDC groups, including Microsoft Entra ID; the Installation Key remains the on-premises break-glass path.

Rotation also recreates the web container, so it reports the public scheme it is about to bring the proxy back on and takes the same `--public-scheme` flag. On an installation that recorded `https` it reads that back and keeps `Secure` on the session cookies; add the flag only to declare a scheme that was never recorded, or to change one.

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

After first sign-in, use **Platform > Installation recovery** to export the encrypted recovery kit, move it off the OrcaSynapse host, and verify the retained copy in the workspace. The local password, Installation Key, and credential-encryption master key have separate purposes: possession of either authentication credential never decrypts stored connector secrets. The recovery kit and its passphrase must be held separately according to customer policy.

Routine service endpoints, API keys, model aliases, operational settings, and connectors are entered through the dashboard and encrypted in PostgreSQL. OrcaSynapse does not deploy HashiCorp Vault, use environment files for routine connectors, accept reusable server credentials, or store Hermes-native memory content.

The public bootstrap and bundled installer preserve separation between PostgreSQL data, the credential-encryption key, the Installation Key, and the off-host recovery kit. A resolved Git commit and archive checksum provide reproducibility, not publisher authenticity. Production release publication still needs OrcaSynapse's signed release manifest and image-digest pipeline; neither a branch download nor a local repository checkout proves publisher signature provenance.
