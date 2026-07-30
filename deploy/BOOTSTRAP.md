# AIHub Installation Bootstrap

An intact AIHub release bundle contains the application, Compose manifest, migrations, and the host installer. On a clean Debian or Ubuntu server, run:

```bash
sudo ./scripts/install-aihub.sh
```

The installer checks or installs Docker Compose v2, OpenSSL, and curl; builds the release; generates the database password and credential-encryption key with root-only permissions; starts the stack; waits for readiness; and prints a short-lived, single-use installation claim. Open the displayed dashboard URL immediately and enter that claim. It is exchanged once for an HttpOnly administrator session and is never used as an API credential. A later installer rerun preserves the protected material and will not display a consumed or expired claim.

Set `AIHUB_HTTP_PORT` before invoking the script to use a port other than `8080`. `AIHUB_CLAIM_TTL_MINUTES` may be set from 10 through 1440 and defaults to 30 minutes. Terminate TLS at a customer-approved reverse proxy or load balancer before using AIHub outside a protected deployment network. That upstream proxy must overwrite `X-Forwarded-Proto`, and direct access to the AIHub HTTP port must remain restricted; AIHub's bundled Nginx discards inbound forwarding chains and reports only its direct peer to the API.

The installer refuses to overwrite any partial secret set. A complete existing set is preserved for idempotent restarts. It does not take an SSH password, mount the Docker socket into AIHub, or grant the dashboard host-level command execution.

If the first browser session is lost before OIDC administrator groups are configured, a customer with local root authority can invoke the audited break-glass flow:

```bash
sudo ./scripts/issue-installation-claim.sh --confirm-revoke-bootstrap-sessions
```

This stops the API, atomically retires the prior claim record, revokes only claim-derived administrator sessions, writes a new expiring claim, force-recreates the API and web services so file-backed secret mounts are refreshed, and records the local-root event in the audit ledger. It does not revoke federated OIDC administrator sessions. Routine administration should use mapped OIDC groups; replacement claims are recovery operations, not shared passwords.

## Manual development flow

For a developer workstation with Node.js and Docker already installed, build before creating the expiring claim:

```bash
docker compose build
node scripts/generate-bootstrap.mjs
docker compose up -d --no-build
```

Read `.local/secrets/aihub_bootstrap_token` through an approved local secret-reading workflow and enter it immediately in the dashboard; the development generator deliberately does not print secret material to logs.

The generator writes the following files under the Git-ignored `.local/secrets` directory and refuses to replace any existing file:

- `postgres_password`
- `aihub_database_url`
- `aihub_master_key`
- `aihub_bootstrap_token` (the compatibility filename for the single-use installation claim)
- `aihub_installation_claim_expires_at`

After claiming the installation, use **Deployment > Identity and recovery** to export the encrypted recovery kit, move it off the AIHub host, and verify the retained copy in the dashboard. AIHub stores only its checksum, encryption-key fingerprint, ownership, and verification evidence. The kit and its passphrase must be held separately according to the customer recovery policy. Losing the server key and every recovery-kit copy makes encrypted connector credentials unrecoverable.

Routine service endpoints, API keys, model aliases, operational settings, and connectors are entered through the dashboard and encrypted in PostgreSQL. AIHub does not deploy HashiCorp Vault, use environment files for routine connectors, accept reusable server credentials, or keep source documents as a permanent file store.

The signed release-bundle installer is the sole supported deployment path. Its pinned manifest preserves separation between PostgreSQL data, the credential-encryption key, the installation claim, and the off-host recovery kit. Production release publication still needs MPM's bundle-signing and image-digest pipeline; a local repository checkout does not by itself prove publisher signature provenance.
