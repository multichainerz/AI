<p align="center">
  <img src="docs/assets/orcasynapse-wordmark.svg" alt="OrcaSynapse - private agentic intelligence and governed execution, on-premises" width="100%" />
</p>

<h3 align="center">Dynamic intelligence, orchestrated into action.</h3>

<p align="center">
  An on-premises control plane for Hermes-native sessions and memory, private knowledge, policy, and governed execution<br />
  around an isolated Hermes runtime — with identity, secrets, audit, and oversight inside infrastructure you control.
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

Two VMs and an OpenAI-compatible inference endpoint, all under your network controls.

| Layer | What you do | What OrcaSynapse manages |
| --- | --- | --- |
| **AI Inference** | Point at an existing endpoint | Discovery, model validation, routing, credentials, health, usage |
| **Agentic System** | Enroll one isolated VM | Hermes runtime, governed execution policy, node identity, observability |
| **Enterprise Access** | Connect your identity provider | Local recovery, OIDC / Microsoft Entra ID, roles, sessions, audit |

No LiteLLM tier, Redis, Valkey, pg-boss, object store, or external vector database. pgvector ships inside the bundled PostgreSQL image.

## Install

One clean Debian or Ubuntu VM. One command. It provisions Docker, PostgreSQL with pgvector, the API, worker, operator workspace, encrypted secrets, and your first administrator.

```bash
curl -fsSL https://raw.githubusercontent.com/multichainerz/AI/main/install.sh | sudo bash
```

<p align="center">
  <img src="docs/assets/orcasynapse-installer.svg" alt="The OrcaSynapse installer: branded banner showing the release and source commit, numbered provisioning steps with progress bars, and a final panel with the direct address" width="88%" />
</p>

Open OrcaSynapse at the address it prints. That is the only command needed on VM1.

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
2. **Connect AI Inference** from **Platform › AI Inference**. OrcaSynapse discovers compatible API paths and available models instead of asking you to guess endpoint URLs.
3. **Enroll VM2** from **Platform › Agentic System**. Once setup and inference are healthy, OrcaSynapse serves the VM2 installer and issues a one-time claim.
4. **Create the first agent** from **Agents › Hermes Profiles**. In Development, **Create & activate** verifies VM2, activates the immutable profile, enables execution, and makes Session ready in one action.
5. **Add Enterprise Access** from **Platform** when you're ready, by connecting OIDC or Microsoft Entra ID and mapping groups to roles.

VM2 generates its own identity, consumes the claim once, receives a scoped inference route, applies the managed guardrail baseline, and starts signed health reporting. Hermes runs as an ordinary systemd service pinned to an approved commit, so `systemctl` and `journalctl` work the way your operators already expect. An interrupted install resumes from protected local state without another claim. OrcaSynapse never needs the VM's SSH password or a remote execution channel.

## What you get

**A readiness command center** — the full-screen Dashboard compresses platform readiness, the next required capability, live service state, existing activity metrics, and the governed execution path into one responsive, theme-aware control surface.

**Governed Sessions** — durable conversations executed through Hermes' native session API. Hermes owns transcript continuity and its built-in memory; OrcaSynapse keeps a sanitized run projection for streaming, cancellation, telemetry, feedback, archive, export, and audit. Closing the browser does not cancel the worker-owned Hermes stream.

**Private document knowledge** — upload TXT, Markdown, HTML, CSV, JSON, PDF, DOCX, PPTX, or XLSX. Text is extracted in flight, embedded locally with BGE-M3, and retrieved from pgvector. Original files are never stored. Pin documents to a conversation to scope exactly what an agent may consult.

**Hermes-first memory** — the agent uses Hermes' native `MEMORY.md`, `USER.md`, and persisted session history exactly where Hermes expects them. OrcaSynapse does not read, mirror, edit, embed, or expose those files. Document knowledge remains a separate, owner-scoped pgvector index on VM1.

Vanilla Hermes keeps transcripts per session but shares `MEMORY.md` and
`USER.md` across sessions in its active home/profile. This pre-production mode
is one trust boundary; it is not multi-user memory isolation.

**An audit trail you can actually read** — every governed action lands in an append-only trail with a filterable Operations view. An optional forwarder ships it to your SIEM with at-least-once delivery, and reports its own health when the destination falls behind or starts rejecting batches.

**Inference that configures itself** — vLLM, llama.cpp, SGLang, Ollama, TGI, or any compatible OpenAI-style server.

**Governed agents** — immutable Hermes profiles, skills, tools, prompts, guardrails, lifecycle states, runs, and safe event projections.

**Enterprise access** — local break-glass recovery plus optional OIDC / Microsoft Entra ID with group-to-role mapping.

## Trust boundaries that stay understandable

- **OrcaSynapse** owns identity, authorization, policy, encrypted configuration, audit, and inference access.
- **PostgreSQL** owns control-plane state, sanitized run/audit projections, and extracted knowledge chunks plus embeddings — never original files, Hermes memory files, or model weights.
- **Hermes** owns native sessions, `MEMORY.md`, `USER.md`, Skills, and execution. It runs as an unprivileged service account under a hardened systemd unit — no new privileges, a read-only system tree, a capability bounding set, restricted address families, and write access limited to managed data and workspace directories. It never reaches PostgreSQL or host service control.
- **VM2** runs Hermes and therefore holds its durable native session and memory state. Back it up when that continuity must survive node replacement; document knowledge remains on VM1.
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
| [Hermes-native memory](docs/AGENT_MEMORY_RUNBOOK.md) | Ownership, backup, privacy, and operational verification |
| [Benchmarks](docs/BENCHMARK_RUNBOOK.md) | Writing a suite, running it, filing the result as evaluation evidence |
| [Product requirements](docs/ORCASYNAPSE_PRD.md) · [Delivery plan](docs/ORCASYNAPSE_PHASED_PLAN.md) | Scope, roles, acceptance tiers |
| [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [License](LICENSE) | Project meta |

> OrcaSynapse is an on-premises acceptance candidate. Production approval remains environment-specific.
