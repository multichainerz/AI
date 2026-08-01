# AIHub Installation Bootstrap

An intact AIHub release bundle contains the application, Compose manifest, migrations, and the host installer. On a clean Debian or Ubuntu server, run:

```bash
sudo ./scripts/install-aihub.sh
```

The installer checks or installs Docker Compose v2, OpenSSL, and curl; builds the release; generates the database password, credential-encryption key, and permanent Installation Key with root-only permissions; starts the stack; waits for readiness; and prints the Installation Key. Store it in the organization password vault before closing the terminal. It establishes bounded HttpOnly administrator sessions and remains the local recovery credential.

Set `AIHUB_HTTP_PORT` before invoking the script to use a port other than `8080`. Terminate TLS at a customer-approved reverse proxy or load balancer before using AIHub outside a protected deployment network. That upstream proxy must overwrite `X-Forwarded-Proto`, and direct access to the AIHub HTTP port must remain restricted; AIHub's bundled Nginx discards inbound forwarding chains and reports only its direct peer to the API.

The installer refuses to overwrite any partial secret set. A complete existing set is preserved for idempotent restarts. It does not take an SSH password, mount the Docker socket into AIHub, or grant the dashboard host-level command execution.

## Enroll an isolated Hermes VM

For Control-plane only or Segmented production, prepare a second Debian or Ubuntu VM with private network reachability in both directions. In the dashboard, open **Deployment > Hermes nodes**, enter the VM2 API address and the AIHub address visible from VM2, then issue and download the short-lived enrollment bundle.

On VM2, download the installer from the AIHub host, copy the enrollment JSON through the customer's approved administrative path, and run:

```bash
curl -fsS https://aihub.example.internal/install/hermes-node.sh -o install-hermes-node.sh
chmod +x install-hermes-node.sh
sudo ./install-hermes-node.sh aihub-hermes-runtime-01-enrollment.json
```

VM2 generates its Ed25519 private key locally, starts the official Hermes gateway container, exchanges the claim once, installs checksum-verified Supermemory Local with local embeddings, enables Hermes's scoped native Supermemory provider, registers both service routes, and enables a signed one-minute heartbeat timer. AIHub never receives the node private key, reusable SSH credentials, or a Docker socket. A current heartbeat proves VM2-to-AIHub reachability; healthy generated connections prove AIHub-to-VM2 reachability.

Before Production, replace tagged images and unpinned Supermemory versions with approved artifacts, terminate AIHub enrollment traffic with customer-approved TLS, limit Hermes TCP/8642 and Supermemory TCP/6767 to AIHub, restrict VM2 egress to AIHub plus approved MCP destinations, and complete the customer PKI/mTLS acceptance gate. Application signatures do not replace transport encryption or network policy.

If the retained Installation Key must be replaced, a customer with local root authority can invoke the break-glass rotation flow:

```bash
sudo ./scripts/rotate-installation-key.sh --confirm-revoke-local-sessions
```

This replaces the root-owned key file and recreates the API. The next successful use records the new verifier in PostgreSQL and revokes prior local-key sessions. Federated OIDC sessions are not revoked. Routine administration may use mapped OIDC groups, including Microsoft Entra ID; the Installation Key remains the on-premises recovery path.

## Manual development flow

For a developer workstation with Node.js and Docker already installed:

```bash
docker compose build
node scripts/generate-bootstrap.mjs
docker compose up -d --no-build
```

Read `.local/secrets/aihub_installation_key` through an approved local secret-reading workflow and store it in a password vault; the development generator deliberately does not print secret material to logs.

The generator writes the following files under the Git-ignored `.local/secrets` directory and refuses to replace any existing file:

- `postgres_password`
- `aihub_database_url`
- `aihub_master_key`
- `aihub_installation_key` (permanent local administrator activation and recovery credential)

After activation, use **Deployment > Identity and recovery** to export the encrypted recovery kit, move it off the AIHub host, and verify the retained copy in the dashboard. The Installation Key and credential-encryption master key have separate purposes: possession of the dashboard key never decrypts stored connector secrets. The recovery kit and its passphrase must be held separately according to customer policy.

Routine service endpoints, API keys, model aliases, operational settings, and connectors are entered through the dashboard and encrypted in PostgreSQL. AIHub does not deploy HashiCorp Vault, use environment files for routine connectors, accept reusable server credentials, or keep source documents as a permanent file store.

The signed release-bundle installer is the sole supported deployment path. Its pinned manifest preserves separation between PostgreSQL data, the credential-encryption key, the Installation Key, and the off-host recovery kit. Production release publication still needs MPM's bundle-signing and image-digest pipeline; a local repository checkout does not by itself prove publisher signature provenance.
