# Hermes Runtime Node Enrollment

AIHub supports one active isolated Hermes execution boundary. The customer installs AIHub on VM1, then uses the Deployment wizard to enroll VM2 without giving AIHub reusable SSH credentials or access to the host Docker socket.

## Trust model

- An administrator issues a random enrollment claim that expires in 10 to 1,440 minutes and is returned only in the downloadable bundle.
- PostgreSQL stores only the SHA-256 claim digest. Issuing a replacement revokes earlier unused claims for that node.
- VM2 generates an Ed25519 private key under `/var/lib/aihub-hermes/identity` with root-only permissions. Only the public key and its fingerprint reach AIHub.
- Enrollment consumes the claim atomically under a PostgreSQL advisory lock and creates the encrypted Hermes API connection.
- Each heartbeat signs the timestamp, unique nonce, and canonical request digest. AIHub accepts a five-minute clock window and persists nonce uniqueness to reject replay.
- Revocation disables both the node identity and its generated Hermes connection. Re-enrollment requires rebuilding or deliberately clearing the old VM state after revocation.

This application identity authenticates the VM2 heartbeat. It does not replace TLS, customer firewall policy, image provenance, host hardening, or a future customer-PKI/mTLS control.

## Customer workflow

1. Install AIHub on VM1 with `sudo ./scripts/install-aihub.sh` and claim it in the browser.
2. Select Control-plane only or Segmented production in **Deployment > Architecture**.
3. Open **Deployment > Hermes nodes** and enter:
   - a stable node name and slug;
   - the private VM2 URL that VM1 can reach, normally `https://hermes-01.internal:8642` or protected HTTP during development;
   - the AIHub URL that VM2 can reach;
   - the expected VM2 hostname when the customer's inventory has assigned one;
   - an approved Hermes image reference, pinned by digest for Production.
4. Download the one-time JSON bundle.
5. On VM2, download `/install/hermes-node.sh` from VM1, copy the JSON using the customer's approved administrative channel, and run the installer as root.
6. Refresh the node panel. `Online` proves the signed outbound heartbeat; `Healthy` under **AIHub → Hermes** proves the reverse API route.
7. Configure LiteLLM before issuing the invitation. During enrollment AIHub decrypts the one healthy LiteLLM route only inside the API, returns it to the authenticated VM2 installer over the enrollment channel, and VM2 writes its local Hermes provider files. The key is never placed in the browser bundle. Configure OCR, Supermemory, model routes, Profiles, guardrails, and governed tools in their dashboard workspaces.

## Runtime layout on VM2

The installer creates:

- `/var/lib/aihub-hermes/data` — the persistent `/opt/data` mount containing Hermes `.env`, `state.db`, sessions, built-in memory, and gateway state;
- `/var/lib/aihub-hermes/identity/node.key` — the node signing key, never mounted into Hermes;
- `/usr/local/lib/aihub/hermes-heartbeat.sh` — the bounded heartbeat client;
- `aihub-hermes-heartbeat.service` and `.timer` — the one-minute systemd heartbeat;
- `aihub-hermes` — the official gateway container with resource, PID, capability, and privilege-escalation limits.

The Docker socket is never mounted into AIHub or Hermes. Hermes Profile behavior remains versioned in PostgreSQL and is injected into each governed Runs API submission; the installer does not copy AIHub Profile files into the upstream container.

## Required network policy

| Source | Destination | Purpose |
|---|---|---|
| VM1 AIHub | VM2 TCP/8642 | Hermes health, capability, toolset, Runs, event, and stop APIs |
| VM2 host heartbeat | VM1 AIHub HTTPS | Enrollment and signed heartbeat |
| VM2 Hermes | approved LiteLLM endpoint | Model inference only |
| VM2 Hermes | approved AIHub MCP gateway | Only when governed tools are enabled and accepted |

Deny user networks, public ingress, PostgreSQL, enterprise storage administration, hypervisor/orchestrator control, and unapproved egress. Preserve time synchronization because signed requests have a bounded clock window.

## Lifecycle and recovery

- **Drain** prevents the node from presenting as normally available while existing operational work is handled.
- **Resume** returns a recently reporting node online; otherwise it remains offline until the next valid heartbeat.
- **Suspend** rejects signed node traffic without destroying identity history.
- **Revoke** is permanent for that enrollment and disables the generated connector.

Back up Hermes `/opt/data` according to the customer session-continuity objective. PostgreSQL backup preserves AIHub governance and audit, but it cannot recreate lost Hermes `state.db` native session continuity. The Ed25519 identity may be backed up only if customer policy explicitly requires restoring the same node identity; otherwise revoke and re-enroll a replacement node.

## Current production gates

- MPM-signed AIHub release bundles and an approved image registry/digest pipeline;
- customer-approved TLS/private CA distribution and, where required, mTLS;
- negative network tests proving deny paths;
- Hermes provider bootstrap to the approved LiteLLM alias;
- pinned Hermes compatibility for Runs, events, stop, toolsets, and the hardened private MCP context contract;
- backup/restore of Hermes state and honest loss behavior;
- capacity, load, security, and organizational acceptance evidence.
