<p align="center">
  <img src="docs/assets/orcasynapse-wordmark.svg" alt="OrcaSynapse - private AI operations and agentic control plane" width="100%" />
</p>

<h3 align="center">Your private AI. One control plane. Fully on-premises.</h3>

<p align="center">
  Connect any OpenAI-compatible inference server to governed Hermes agents — with private document knowledge on pgvector, durable agent memory, enterprise access, and an audit trail that can feed your SIEM.
</p>

<p align="center">
  <a href="https://github.com/multichainerz/AI/actions/workflows/verify.yml"><img alt="Build" src="https://github.com/multichainerz/AI/actions/workflows/verify.yml/badge.svg" /></a>
  <a href="https://github.com/multichainerz/AI/tags"><img alt="Release" src="https://img.shields.io/github/v/tag/multichainerz/AI?label=release&color=2ea043" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-BUSL--1.1-blue" /></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white" />
  <img alt="React" src="https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white" />
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-17%20%2B%20pgvector-4169E1?logo=postgresql&logoColor=white" />
  <img alt="Deployment" src="https://img.shields.io/badge/deployment-on--premises-7457DF" />
</p>

## Install OrcaSynapse

Start with one clean Debian or Ubuntu VM. The installer provisions Docker, PostgreSQL with pgvector, the API, worker, dashboard, encrypted secrets, and the first local administrator.

```bash
curl --fail --show-error --location --progress-bar https://raw.githubusercontent.com/multichainerz/AI/main/install.sh | sudo bash
```

Open the dashboard URL printed by the installer. That is the only command needed on VM1.

<details>
<summary>Prefer to inspect the bootstrap first?</summary>

```bash
curl --fail --show-error --location --progress-bar --output orcasynapse-install.sh https://raw.githubusercontent.com/multichainerz/AI/main/install.sh
sed -n '1,260p' orcasynapse-install.sh
sudo bash orcasynapse-install.sh
```

Production environments can pin an approved commit and archive checksum. See the [installation and recovery guide](deploy/BOOTSTRAP.md).
</details>

## Private AI without the infrastructure maze

OrcaSynapse turns three clear layers into one governed experience:

| Layer | What the administrator does | What OrcaSynapse manages |
| --- | --- | --- |
| **AI Inference** | Select an existing inference endpoint | Discovery, model validation, routing, credentials, health, and usage |
| **Agentic System** | Enroll one isolated VM | Hermes, Supermemory agent memory, managed policy, node identity, and observability |
| **Enterprise Access** | Connect organizational identity | Local recovery, OIDC / Microsoft Entra ID, roles, sessions, and audit |

```mermaid
flowchart LR
  PEOPLE["Employees and administrators"] --> ORCA["VM1: OrcaSynapse\nPostgreSQL + pgvector knowledge\nappend-only audit trail"]
  ORCA --> INFERENCE["AI Inference: vLLM, llama.cpp, SGLang, Ollama, TGI"]
  ORCA <-->|"governed runs and signed heartbeats"| AGENTS["VM2: Hermes runtime\n+ Supermemory agent memory"]
  AGENTS -->|"node-scoped model access via /internal/v1"| ORCA
  ORCA -.->|"optional audit forwarding"| SIEM["Your SIEM"]
```

No LiteLLM tier, Redis, Valkey, pg-boss, object store, or external vector database service is required — pgvector ships inside the bundled PostgreSQL image.

## From two empty VMs to governed agents

1. **Install VM1** with the one-line command above and sign in to OrcaSynapse.
2. **Connect AI Inference** from the dashboard. OrcaSynapse discovers compatible API paths and available models instead of asking you to guess endpoint URLs.
3. **Enroll VM2** from **Deployment > Agentic System**. After administrator setup and AI Inference validation, OrcaSynapse serves the VM2 installer; the dashboard generates a one-time claim when a new node is ready to enroll.
4. **Create the first agent** from **Hermes Profiles**. In Development, **Create & activate** verifies VM2, activates the immutable Profile, enables Hermes execution, and makes Chat ready in one action.
5. **Add Enterprise Access** when ready by connecting OIDC or Microsoft Entra ID and mapping groups to administrative roles.

The VM2 installer creates its identity locally, consumes the claim once, receives the dashboard-selected model alias through a scoped OrcaSynapse inference route, applies the managed guardrail baseline, and starts signed health reporting. Once a claim is consumed, protected root-only recovery state lets the same command resume interrupted memory or policy setup without another claim. The installer URL returns no script until administrator setup and AI Inference are ready. OrcaSynapse never needs the VM's SSH password or Docker socket.

## What you get

- Hermes-first Chat with durable multi-turn context, stable memory scope, resumable token streaming, structured tool and subagent activity, governed allow-once approvals, explicit cancellation, first-token and token-usage telemetry, feedback, search, fork, archive, export, and retained conversations. Closing or refreshing the browser does not cancel VM2 execution.
- **Private document knowledge**: upload TXT, Markdown, HTML, CSV, JSON, PDF, DOCX, PPTX, or XLSX; OrcaSynapse extracts the text in flight, embeds it locally with BGE-M3, and retrieves it from pgvector — original files are never retained. Pin documents to a conversation to scope what an agent may consult.
- **An audit trail you can actually read**: every governed action lands in an append-only trail with a filterable dashboard view, and an optional forwarder ships it to your SIEM with at-least-once delivery and health reporting.
- Smart inference discovery for vLLM, llama.cpp, SGLang, Ollama, TGI, and compatible OpenAI-style servers.
- Governed Hermes profiles, skills, tools, prompts, guardrails, lifecycle states, runs, and safe event projections.
- Durable agent memory through self-hosted Supermemory Local on the isolated runtime VM.
- Encrypted PostgreSQL-backed configuration, sessions, authorization, workflow state, audit, and operational evidence.
- Local recovery plus optional OIDC / Microsoft Entra ID for enterprise administration.

## Trust boundaries that stay understandable

- **OrcaSynapse** owns identity, authorization, policy, encrypted configuration, audit, and inference access.
- **PostgreSQL** owns control-plane state plus extracted knowledge chunks and their embeddings — never original enterprise files (extraction is in-flight; source bytes are not stored) and never model weights.
- **Hermes** runs in an isolated environment with only approved model, memory, and tool capabilities.
- **Supermemory** owns the agents' long-lived memory on VM2; document knowledge retrieval is served and governed entirely by OrcaSynapse.
- **Inference credentials** remain on VM1. Agent nodes receive a bounded node-scoped gateway credential.

Production acceptance still requires customer-approved TLS/PKI, firewall policy, exact artifact pins, backup and restore testing, identity acceptance, GPU capacity testing, and security approval.

## Development

Requirements: Node.js 24+, pnpm 10+, and Docker.

```bash
pnpm install
docker run -d --name orca-base -p 15432:5432 \
  -e POSTGRES_USER=orca -e POSTGRES_PASSWORD=orca -e POSTGRES_DB=postgres \
  pgvector/pgvector:pg17
export ORCASYNAPSE_TEST_DATABASE_URL=postgresql://orca:orca@127.0.0.1:15432/postgres
pnpm dev
```

The test database must run a **pgvector** image — the migrator creates the `vector` extension. Vite serves the React dashboard; pnpm manages the TypeScript workspace. Run the worker separately with `pnpm dev:worker`, verify the complete monorepo with `pnpm verify`, and see [CONTRIBUTING.md](CONTRIBUTING.md) for the release convention.

## Documentation

- [Architecture and trust boundaries](docs/ARCHITECTURE.md)
- [Installation and recovery](deploy/BOOTSTRAP.md)
- [Agentic System enrollment](docs/AGENTIC_SYSTEM_ENROLLMENT_RUNBOOK.md)
- [Audit trail and SIEM forwarding](docs/AUDIT_TRAIL_RUNBOOK.md)
- [Product requirements](docs/ORCASYNAPSE_PRD.md)
- [Delivery and acceptance plan](docs/ORCASYNAPSE_PHASED_PLAN.md)
- [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md) · [License (BUSL-1.1)](LICENSE)

> OrcaSynapse is currently an on-premises acceptance candidate. Production approval remains environment-specific.
