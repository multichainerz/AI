<p align="center">
  <img src="docs/assets/orcasynapse-wordmark.svg" alt="OrcaSynapse - private AI operations and agentic control plane" width="100%" />
</p>

<h3 align="center">Your private AI. One control plane. Fully on-premises.</h3>

<p align="center">
  Point OrcaSynapse at any OpenAI-compatible inference server and it gives you governed Hermes agents,<br />
  private document knowledge on pgvector, and an audit trail your SIEM can read — on hardware you own.
</p>

<p align="center">
  <a href="https://github.com/multichainerz/AI/actions/workflows/verify.yml"><img alt="Build" src="https://github.com/multichainerz/AI/actions/workflows/verify.yml/badge.svg" /></a>
  <a href="https://github.com/multichainerz/AI/tags"><img alt="Release" src="https://img.shields.io/github/v/tag/multichainerz/AI?label=release&color=2ea043" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-BUSL--1.1-blue" /></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white" />
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-17%20%2B%20pgvector-4169E1?logo=postgresql&logoColor=white" />
  <img alt="Deployment" src="https://img.shields.io/badge/deployment-on--premises-7457DF" />
</p>

## How it fits together

<p align="center">
  <img src="docs/assets/orcasynapse-architecture.svg" alt="OrcaSynapse production baseline: VM1 runs the control plane with PostgreSQL and pgvector; VM2 runs only the isolated Hermes runtime; VM1 calls an OpenAI-compatible inference server and can forward audit batches to a SIEM" width="100%" />
</p>

Two VMs and an inference endpoint. Nothing leaves your network.

| Layer | What you do | What OrcaSynapse manages |
| --- | --- | --- |
| **AI Inference** | Point at an existing endpoint | Discovery, model validation, routing, credentials, health, usage |
| **Agentic System** | Enroll one isolated VM | Hermes runtime, managed policy, node identity, observability |
| **Enterprise Access** | Connect your identity provider | Local recovery, OIDC / Microsoft Entra ID, roles, sessions, audit |

No LiteLLM tier, Redis, Valkey, pg-boss, object store, or external vector database. pgvector ships inside the bundled PostgreSQL image.

## Install

One clean Debian or Ubuntu VM. One command. It provisions Docker, PostgreSQL with pgvector, the API, worker, dashboard, encrypted secrets, and your first administrator.

```bash
curl -fsSL https://raw.githubusercontent.com/multichainerz/AI/main/install.sh | sudo bash
```

<p align="center">
  <img src="docs/assets/orcasynapse-installer.svg" alt="The OrcaSynapse installer: branded banner showing the release and source commit, numbered provisioning steps with progress bars, and a final panel with the dashboard URL" width="88%" />
</p>

Open the dashboard URL it prints. That is the only command needed on VM1.

<details>
<summary>Prefer to inspect the bootstrap first?</summary>

```bash
curl -fsSL -o orcasynapse-install.sh https://raw.githubusercontent.com/multichainerz/AI/main/install.sh
sed -n '1,260p' orcasynapse-install.sh
sudo bash orcasynapse-install.sh
```

Production environments can pin an approved commit and archive checksum. See the [installation and recovery guide](deploy/BOOTSTRAP.md).
</details>

## From two empty VMs to governed agents

1. **Install VM1** with the command above and sign in.
2. **Connect AI Inference.** OrcaSynapse discovers compatible API paths and available models instead of asking you to guess endpoint URLs.
3. **Enroll VM2** from **Deployment › Agentic System**. Once setup and inference are healthy, OrcaSynapse serves the VM2 installer and issues a one-time claim.
4. **Create the first agent** from **Hermes Profiles**. In Development, **Create & activate** verifies VM2, activates the immutable profile, enables execution, and makes Chat ready in one action.
5. **Add Enterprise Access** when you're ready, by connecting OIDC or Microsoft Entra ID and mapping groups to roles.

VM2 generates its own identity, consumes the claim once, receives a scoped inference route, applies the managed guardrail baseline, and starts signed health reporting. An interrupted install resumes from protected local state without another claim. OrcaSynapse never needs the VM's SSH password or Docker socket.

## What you get

**Hermes-first Chat** — durable conversations backed by governed agent runs. Closing the browser doesn't cancel execution: streams resume, cancellation is explicit, and every run carries tool and subagent activity, telemetry, feedback, fork, archive, and export.

**Private document knowledge** — upload TXT, Markdown, HTML, CSV, JSON, PDF, DOCX, PPTX, or XLSX. Text is extracted in flight, embedded locally with BGE-M3, and retrieved from pgvector. Original files are never stored. Pin documents to a conversation to scope exactly what an agent may consult.

**Agents that remember, on your terms** — memory lives in the same pgvector plane as your documents, scoped to one person and one agent. Each agent's profile chooses what it stores: nothing at all (the default), recall without writing, learn from what the person says, or learn from the whole exchange. What is stored are facts extracted after the answer, not the messages themselves — a turn is mostly questions and greetings, and storing it verbatim makes recall match old questions instead of useful facts. One installation-wide policy caps every agent at once, and any stored memory can be read and deleted from the dashboard.

**An audit trail you can actually read** — every governed action lands in an append-only trail with a filterable dashboard view. An optional forwarder ships it to your SIEM with at-least-once delivery, and reports its own health when the destination falls behind or starts rejecting batches.

**Inference that configures itself** — vLLM, llama.cpp, SGLang, Ollama, TGI, or any compatible OpenAI-style server.

**Governed agents** — immutable Hermes profiles, skills, tools, prompts, guardrails, lifecycle states, runs, and safe event projections.

**Enterprise access** — local break-glass recovery plus optional OIDC / Microsoft Entra ID with group-to-role mapping.

## Trust boundaries that stay understandable

- **OrcaSynapse** owns identity, authorization, policy, encrypted configuration, audit, and inference access.
- **PostgreSQL** owns control-plane state plus extracted knowledge chunks and their embeddings — never original files, never model weights.
- **Hermes** runs isolated, with only approved model, memory, and tool capabilities. It never reaches PostgreSQL, Docker, or the open network.
- **VM2** runs the agent runtime and nothing else. It holds no durable store: knowledge and agent memory are served and governed entirely by OrcaSynapse, and never transit VM2.
- **Inference credentials** stay on VM1. Agent nodes get a bounded, node-scoped gateway credential.

Production acceptance still requires your own TLS/PKI, firewall policy, artifact pins, backup and restore testing, identity acceptance, GPU capacity testing, and security approval.

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

The test database must run a **pgvector** image — the migrator creates the `vector` extension. Run the worker with `pnpm dev:worker`, verify everything with `pnpm verify`, and see [CONTRIBUTING.md](CONTRIBUTING.md) for the release convention.

## Documentation

| | |
| --- | --- |
| [Architecture](docs/ARCHITECTURE.md) | System boundaries, knowledge lifecycle, network policy, recovery |
| [Installation and recovery](deploy/BOOTSTRAP.md) | Bootstrap, pinning, upgrade and erase paths, key rotation |
| [Agentic System enrollment](docs/AGENTIC_SYSTEM_ENROLLMENT_RUNBOOK.md) | VM2 enrollment, allowlist, decommission |
| [Audit trail and SIEM forwarding](docs/AUDIT_TRAIL_RUNBOOK.md) | Reading the trail, forwarding, health states |
| [Agent memory](docs/AGENT_MEMORY_RUNBOOK.md) | What agents store, the installation ceiling, retention, deletion |
| [Benchmarks](docs/BENCHMARK_RUNBOOK.md) | Writing a suite, running it, filing the result as evaluation evidence |
| [Product requirements](docs/ORCASYNAPSE_PRD.md) · [Delivery plan](docs/ORCASYNAPSE_PHASED_PLAN.md) | Scope, roles, acceptance tiers |
| [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [License](LICENSE) | Project meta |

> OrcaSynapse is an on-premises acceptance candidate. Production approval remains environment-specific.
