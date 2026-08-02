# MPM AIHub

MPM AIHub is an on-premises control plane for governed local-AI chat, documents, agents, memory, models, tools, and operations.

The active architecture is intentionally small:

- **AIHub host:** React/Vite dashboard, Fastify API, a lightweight runtime executor, PostgreSQL, and Prisma.
- **Agent host:** isolated Hermes Agent plus self-hosted Supermemory Local.
- **Inference host:** vLLM and the approved local model on the GPU server.

AIHub calls vLLM directly for ordinary Chat. Hermes and Supermemory call the same approved model through AIHub's authenticated OpenAI-compatible inference gateway. That keeps the vLLM credential and model route in AIHub while avoiding a second inference proxy.

The application does not require LiteLLM, Redis, Valkey, pg-boss, S3, MinIO, SeaweedFS, or an AIHub-owned pgvector index. PostgreSQL is the control, audit, session, and durable workflow system of record. Supermemory is the only semantic-memory plane.

## What is implemented

- responsive desktop/mobile administration dashboard;
- encrypted dashboard-managed service credentials and versioned configuration;
- PostgreSQL-backed local administrator login, forced temporary-password replacement, offline Installation Key recovery, bounded sessions, optional OIDC, audits, lockout controls, and PostgreSQL domain-state reconciliation;
- direct vLLM Chat with streaming, cancellation, bounded context, usage/latency telemetry, and feedback;
- versioned model, prompt, and deterministic guardrail controls;
- document quarantine, classification, checksums, transient encrypted staging, publication, retrieval, retention, and deletion;
- UTF-8 TXT ingestion with encrypted transient normalization and durable publication to Supermemory;
- Supermemory publication in the governed `mpm-knowledge` namespace with PostgreSQL reauthorization before retrieval;
- immutable Hermes Profile Distributions, standby/active lifecycle, governed runs, cancellation, safe event projection, and optional approved MCP tools;
- one-time, signed Hermes-node enrollment with a node-generated Ed25519 identity and recurring signed heartbeats;
- automatic installation and registration of Supermemory Local on the Hermes node;
- an authenticated `/internal/v1` inference gateway for Hermes and Supermemory, with AIHub-native request policy and bounded responses;
- readiness evidence, recovery-kit controls, service diagnostics, evaluation records, and AI-operations summaries.

The repository is an on-premises acceptance candidate, not a claim that a customer environment is production-approved. Production still requires customer PKI/TLS, firewall evidence, exact image/version pins, backups and restore drills, OIDC acceptance, GPU capacity/load tests, SIEM/monitoring integration, adversarial testing, and formal approval.

## Development

Requirements: Node.js 24+, pnpm 10+, PostgreSQL 17, and Docker when exercising the release topology.

```bash
pnpm install
pnpm db:generate
pnpm dev
```

Vite is the web build/dev server; pnpm is the package manager. They solve different problems and are both used.

Run the worker separately during local development:

```bash
pnpm dev:worker
```

Verify the whole workspace:

```bash
pnpm verify
```

## AIHub installation

The supported release-bundle path is a Debian/Ubuntu server with Docker Compose v2:

```bash
sudo ./scripts/install-aihub.sh
```

The script builds and starts PostgreSQL, migrations, API, runtime executor, and web. It provisions the local `admin` account, prints its one-time temporary password, and requires a password change at first sign-in. It also prints a separate permanent Installation Key; store that key offline in the organization password vault because it is only the break-glass local-account recovery credential. Routine endpoints and credentials are entered through the dashboard and encrypted in PostgreSQL with a separate root-owned master key.

The Installation Key does not expire and is not used for routine sign-in. Local root authority can rotate it with `scripts/rotate-installation-key.sh`; OIDC or Microsoft Entra ID can later become the preferred enterprise identity without removing the local recovery path. See [deploy/BOOTSTRAP.md](deploy/BOOTSTRAP.md).

## Hermes and Supermemory installation

After vLLM is healthy and an active Agent model route exists:

1. Open **Deployment → Production setup → Hermes nodes**.
2. Create an invitation for the isolated runtime VM.
3. Download the enrollment bundle.
4. Copy the bundle and `scripts/install-hermes-node.sh` to that VM.
5. Run `sudo ./install-hermes-node.sh enrollment.json`.

The runtime installer starts the official Hermes container, configures it to use AIHub's inference gateway, installs Supermemory Local with local embeddings, enables the native Hermes Supermemory provider, registers both endpoints in AIHub, and starts signed heartbeats. AIHub does not retain SSH credentials or a Docker socket for the runtime VM.

For production, set exact artifact versions/digests rather than `latest`, enforce TLS, and restrict network paths to the matrix in the [Hermes node enrollment runbook](docs/HERMES_NODE_ENROLLMENT_RUNBOOK.md).

## Data boundaries

- PostgreSQL stores governance, identity, authorization, lifecycle, audit, and job data—not embeddings or permanent source-document bytes.
- AIHub scratch storage is encrypted and ephemeral. It is purged after confirmed publication or expiry and is excluded from backup.
- Enterprise repositories remain authoritative for original documents.
- Supermemory stores durable normalized knowledge and Hermes long-term memory.
- Hermes keeps its native bounded memory and runtime state alongside, not instead of, Supermemory.
- vLLM receives approved model requests only; it is not an authorization or memory system.

## Documentation

- [Current architecture](docs/ARCHITECTURE.md)
- [High-level product requirements](docs/AIHUB_PRD.md)
- [Delivery and acceptance plan](docs/AIHUB_PHASED_PLAN.md)
- [Hermes node enrollment](docs/HERMES_NODE_ENROLLMENT_RUNBOOK.md)
- [Model control](docs/MODEL_CONTROL_RUNBOOK.md)
- [Guardrail control](docs/GUARDRAIL_CONTROL_RUNBOOK.md)
- [Prompt control](docs/PROMPT_CONTROL_RUNBOOK.md)
