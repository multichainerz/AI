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
  | sudo bash -s -- --public-scheme https --http-bind 127.0.0.1
```

For an inspect-first workflow that does not open a full-screen pager:

```bash
curl --proto '=https' --tlsv1.2 -fsSLo orcasynapse-install.sh \
  https://raw.githubusercontent.com/multichainerz/AI/main/install.sh
sed -n '1,240p' orcasynapse-install.sh
sudo bash orcasynapse-install.sh --public-scheme https --http-bind 127.0.0.1
```

The one-line form is the default convenience path; the inspect-first form is available for controlled environments without opening a terminal pager. Both accept `--public-scheme http|https` and `--http-bind ADDRESS`. Omitting the scheme leaves the safe `http` default; omitting the bind publishes on every interface. The installer automatically uses plain output when no interactive terminal is attached, and `NO_COLOR=1` disables terminal colors.

The bootstrap resolves `ORCASYNAPSE_REF` (default `main`) to an immutable Git commit, downloads that commit from GitHub, records the source identity under `/opt/orcasynapse`, and handles an existing path through the guarded recovery flow below. An acceptance environment should set an approved commit and checksum explicitly:

```bash
sudo env ORCASYNAPSE_REF=<40-character-commit> ORCASYNAPSE_ARCHIVE_SHA256=<sha256> bash install.sh
```

When `/opt/orcasynapse` already exists, the installer distinguishes a verified installation with the current `hermes-native-v1` schema epoch from older or unknown state. Only a current-epoch installation can use the in-place source update that preserves PostgreSQL volumes, protected secrets, and recovery material. Pre-v4.6.0 installations require a clean reinstall, after a separate `ERASE` confirmation because it permanently removes the Compose stack, named data volumes, accounts, and local secrets. Non-interactive automation must explicitly set `ORCASYNAPSE_EXISTING_INSTALL_ACTION=upgrade|erase|abort`; automated erase additionally requires `ORCASYNAPSE_CONFIRM_ERASE=ERASE`.

An upgrade takes a verified PostgreSQL dump before any file is staged and keeps the release it is replacing until the upgrade is confirmed healthy. If the upgrade then fails, the installer restores that release — the source tree always, and the database when the forward-only migrations have actually moved the schema — restarts the deployment on it, and records what it did in `.local/state/last-upgrade-rollback.json`. Set `ORCASYNAPSE_UPGRADE_ROLLBACK=off` to leave a failed upgrade in place for inspection instead, and see [docs/DATABASE_RESTORE_RUNBOOK.md](../docs/DATABASE_RESTORE_RUNBOOK.md) for the manual procedure and for the one case the schema comparison cannot see.

On a systemd host the installer also enables `orcasynapse-update.timer`, which runs `/usr/local/lib/orcasynapse/orcasynapse-update-agent.sh` every ten minutes. It does nothing until an administrator approves a release in the dashboard; on an approved target it re-runs this bootstrap at that exact commit, health-gates the result, and restores the previous release if the deployment does not come back. It listens on nothing and adds no credential to the host.

From an intact local release bundle, the equivalent host command is:

```bash
sudo ./scripts/install-orcasynapse.sh --public-scheme https --http-bind 127.0.0.1
```

The installer runs six steps: it sizes and preflights the host; checks or installs Docker Compose v2, OpenSSL, and curl; builds the release; generates the database password, credential-encryption key, and permanent Installation Key in a root-only host directory; starts the stack with stock PostgreSQL 17 and waits for readiness; then provisions a PostgreSQL-backed local `admin` account. Application-secret files use a narrowly scoped container group so non-root services can read only the secrets explicitly mounted into them. It prints the one-time temporary password and requires replacement at first sign-in. It separately prints the Installation Key, which must be stored offline in the organization vault and is accepted only for local-account recovery.

The banner and summary show the release version and source commit read from the extracted tree. The summary also states the public scheme in force and, when it is `http`, says plainly that the administrator and enterprise session cookies are not `Secure`. A secret-free install log is written to `.local/state/install-<timestamp>.log` and a machine-readable completion marker to `.local/state/install-complete.json`; the temporary password and Installation Key never enter either.

Set `ORCASYNAPSE_HTTP_PORT` before invoking the script to use a port other than `8080`.

### Public scheme

Terminate TLS at a customer-approved reverse proxy or load balancer before using OrcaSynapse outside a protected deployment network, and declare that with `--public-scheme https`. The bundled Nginx listens on plain HTTP, so it cannot observe the TLS an upstream terminator provides; this flag is the operator's declaration of the scheme browsers really use, and it is the only thing that makes the administrator and enterprise session cookies `Secure`. Declare it only where TLS genuinely terminates upstream — over cleartext a `Secure` cookie is one the browser never sends back. Omitted, the scheme stays `http`, which withholds `Secure` rather than claiming a TLS session the deployment does not have.

It is a flag rather than an environment variable because every command on this page runs through `sudo`, and stock sudoers is `Defaults env_reset`: an exported `ORCASYNAPSE_PUBLIC_SCHEME` is discarded before the script starts, which silently produced plain-HTTP cookies on deployments that had declared `https`. Where an environment variable is genuinely more convenient, `sudo env ORCASYNAPSE_PUBLIC_SCHEME=https ...` and `sudo -E` both work, and both are treated as the same explicit declaration as the flag.

The declaration is recorded in the root-only `.local/state/public-scheme` — an operator setting, never a secret, and never written into `.local/secrets`. Re-running the installer, and the break-glass `rotate-installation-key.sh` below, read it back rather than re-deriving the default, so neither can silently return a correct installation to `http`. Passing the flag again replaces the recorded value and says so. An installation created before this was recorded has nothing to read back: declare the scheme once more on the next install or rotation, and it is remembered from then on. Restarting the stack by hand with `docker compose up -d` bypasses both scripts and both records, so use the scripts, or pass `ORCASYNAPSE_PUBLIC_SCHEME` to that command yourself.

Nothing a client sends can substitute for that declaration: OrcaSynapse's bundled Nginx discards inbound forwarding chains, overwriting `X-Forwarded-Proto` with the declared scheme and `X-Forwarded-For` with its own direct peer, so the upstream proxy's forwarding headers are neither required nor honoured. Direct access to the OrcaSynapse HTTP port must remain restricted.

### Bind address

`--http-bind 127.0.0.1` restricts the published dashboard port to loopback, which is the posture to use when a reverse proxy terminates TLS on the same host. Omitted, it stays `0.0.0.0` — every interface — because the installer prints a LAN address and an Agentic System node reaches this port to enrol.

**A host firewall rule on this port does not restrict it.** Docker publishes through its own NAT path, which is evaluated before ufw's `INPUT` chain, so a rule written against the published port has no effect and an operator who wrote one is left believing the dashboard is protected. This flag is the only control that actually narrows it.

It is a flag for the same reason `--public-scheme` is, and it is recorded the same way, in the root-only `.local/state/http-bind`. That recording is what makes it hold: the value was previously read only by `compose.yaml` and persisted nowhere, so every path that recreated the web container re-derived `0.0.0.0` — including the unattended update, which rebuilds a staging tree and discards a project `.env` on the way. A deployment bound to loopback was silently re-published on every interface by a dashboard-approved update, with nothing printed and the run reported healthy. The installer and `rotate-installation-key.sh` now both read the recording back and both report the address they are binding to.

The published port is recorded alongside it. `rotate-installation-key.sh` used to re-default to `8080`, which relocated a deployment that had been installed on another port and then passed its own readiness check, because that check probed the port the rotation had just moved to.

An installation created before either was recorded has nothing to read back: declare them once more on the next install or rotation, and they are remembered from then on.

The installer refuses to overwrite any partial secret set. A complete existing set is preserved for idempotent restarts. It does not take an SSH password, mount the Docker socket into OrcaSynapse, or grant the dashboard host-level command execution.

## Enroll an isolated Agentic System VM

For Control-plane only or Segmented production, prepare a second Ubuntu systemd VM with private network reachability in both directions. First replace the temporary administrator password and configure exactly one healthy AI Inference route with a discovered model. Then open **Settings → Setup** and select step 2, *Install the agent runtime* — addressable directly at `#settings/setup/runtime` — enter the VM2 API address and the OrcaSynapse address visible from VM2, and issue the short-lived enrollment claim. (There is no Platform area; it became Settings at v4.9.0.)

The VM2 installer is not a permanently public static asset. OrcaSynapse serves the non-secret script through a readiness-gated API only after dashboard setup is complete and AI Inference is healthy and seedable. The script remains available after enrollment so an interrupted VM2 can resume with its protected local recovery state; a live one-time claim is still required to begin a new enrollment.

On VM2, run the installer served by the customer-owned OrcaSynapse host against that same origin:

```bash
curl -fsSL https://orcasynapse.example.internal/install/agentic-node.sh \
  | sudo bash -s -- --connect https://orcasynapse.example.internal
```

Paste the short-lived claim displayed by the dashboard at the hidden prompt. The token is submitted in a redacted POST body rather than a URL or shell-history argument. The downloaded JSON bundle remains an offline fallback: `sudo bash install-agentic-node.sh enrollment.json`.

**Behind a tunnel or Zero Trust.** A control plane fronted by Cloudflare Zero Trust (or any edge that demands an identity) refuses every machine: Hermes, the heartbeat, the corpus and artifact publishers, and the model-gateway callback cannot pass an Access check. Turn on *"The control plane is behind a tunnel or Zero Trust"* in the enrollment form and give VM2 the control plane's **private LAN address** (a literal RFC 1918 IP such as `http://10.0.0.160:8080`, never a name — a private name is a DNS answer, and DNS is what an on-path attacker controls). The whole machine channel then runs direct on the private network and never touches the tunnel; the public address stays for people. The trade is stated in the form: the one-time install command travels that LAN unencrypted, so run it only on a network you trust. PRODUCTION targets still require HTTPS — terminate TLS somewhere the machines can reach, or do not enroll. A node already enrolled against a public origin must be decommissioned and re-enrolled to move; alternatively, add an Access **bypass policy** for `/api/v1/*` and `/install/*` on the API hostname — those routes authenticate themselves with signed node identities and minted gateway credentials.

VM2 generates its Ed25519 private key locally, installs the Hermes gateway at the approved commit, starts it as `orcasynapse-hermes.service`, exchanges the claim once, registers its Hermes service route, and enables signed one-minute heartbeat and corpus-reconciliation timers. The corpus companion publishes only allowlisted, bounded memory and Skill snapshots and applies signed expected-hash mutations through Hermes-native APIs; it is not a second memory service. The OrcaSynapse-selected model route and baseline guardrails are installed through Hermes's root-owned managed scope at `/etc/hermes`, which the unit makes read-only to the running service; runtime secrets remain in the protected Hermes data directory under the OrcaSynapse state root. OrcaSynapse never receives the node private key, reusable SSH credentials, or a remote execution channel. A current heartbeat proves VM2-to-OrcaSynapse reachability; healthy generated connections prove OrcaSynapse-to-VM2 reachability.

Before Production, name an approved Hermes commit in the invitation, terminate OrcaSynapse enrollment traffic with customer-approved TLS, limit Hermes TCP/8642 and Session inbox TCP/8643 to OrcaSynapse, restrict VM2 egress to OrcaSynapse plus approved MCP destinations, and complete the customer PKI/mTLS acceptance gate. Note that VM2's install-time egress is wider than its steady-state egress because a native Hermes install resolves its own dependency chain; see the network allowlist in [AGENTIC_SYSTEM_ENROLLMENT_RUNBOOK.md](../docs/AGENTIC_SYSTEM_ENROLLMENT_RUNBOOK.md). Application signatures do not replace transport encryption or network policy.

If the retained Installation Key must be replaced, a customer with local root authority can invoke the break-glass rotation flow:

```bash
sudo ./scripts/rotate-installation-key.sh --confirm-revoke-recovery-sessions
```

This replaces the root-owned key file, immediately revokes recovery sessions, and recreates the API. The next recovery use records the new verifier in PostgreSQL. Routine administration uses the local account; the Installation Key remains the on-premises break-glass path. (Federated OIDC sign-in was removed at v9.0.0.)

Rotation also recreates the web container, so it reports the public scheme it is about to bring the proxy back on and takes the same `--public-scheme` flag. On an installation that recorded `https` it reads that back and keeps `Secure` on the session cookies; add the flag only to declare a scheme that was never recorded, or to change one.

## Operating the hosts

Each installer leaves an operator CLI on its host, and the CLI is the host's front door for day-two work. Both open a menu when run bare on a terminal and take subcommands non-interactively; both only ever execute the same commands the product already ships, printing each one before running it.

On VM1, `orcasynapse` reports service and release state (`status`), applies the release target approved in **Settings → System** by starting the update agent (`update` — it cannot choose a version itself), tails compose logs (`logs api|web|worker|postgres|agent`), restarts one service (`restart`), and checks docker, readiness, the database, the update timer and disk (`doctor`). A failed update's block marker — and the reason it recorded — appears in `status`, with re-approval in the dashboard as the deliberate retry.

On VM2, `orcasynapse-agent` reports the unit family, Hermes health, heartbeat and release drift (`status`), repairs the node in place from the release its control plane serves (`update` — the `--repair` arm; update OrcaSynapse first, since the node downloads the script from it), runs the desired-state, corpus and artifact publishers immediately (`sync`), checks the clock against the signed channel's ±5-minute window, connectivity, units, the deliverable-file path and disk (`doctor`), tails journals (`logs`), and hands off to the decommissioner (`decommission`, confirmed). The CLI itself is downloaded from the control plane and digest-verified on enrollment and on every repair, so the node always carries the CLI its control plane distributes.

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

After first sign-in, open **Settings → Setup** and use the **Installation recovery** button there to export the encrypted recovery kit, move it off the OrcaSynapse host, and verify the retained copy in the workspace. The local password, Installation Key, and credential-encryption master key have separate purposes: possession of either authentication credential never decrypts stored connector secrets. The recovery kit and its passphrase must be held separately according to customer policy.

Routine service endpoints, API keys, model aliases, operational settings, and connectors are entered through the dashboard and encrypted in PostgreSQL. OrcaSynapse does not deploy HashiCorp Vault, use environment files for routine connectors, accept reusable server credentials, or store Hermes-native memory content.

The public bootstrap and bundled installer preserve separation between PostgreSQL data, the credential-encryption key, the Installation Key, and the off-host recovery kit. A resolved Git commit and archive checksum provide reproducibility, not publisher authenticity. Production release publication still needs OrcaSynapse's signed release manifest and image-digest pipeline; neither a branch download nor a local repository checkout proves publisher signature provenance.
