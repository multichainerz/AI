<p align="center">
  <img src="docs/assets/orcasynapse-wordmark.svg" alt="OrcaSynapse - private agentic intelligence and governed execution, on-premises" width="100%" />
</p>

<h3 align="center">Dynamic intelligence, orchestrated into action.</h3>

<p align="center">
  An on-premises control plane for Hermes-native sessions, corpus observability, agent profiles, models, policy, tools, and audit.<br />
  Hermes remains the sole owner of execution context and native memory.
</p>

<p align="center">
  <a href="https://github.com/multichainerz/AI/actions/workflows/verify.yml"><img alt="Build" src="https://github.com/multichainerz/AI/actions/workflows/verify.yml/badge.svg" /></a>
  <a href="https://github.com/multichainerz/AI/tags"><img alt="Release" src="https://img.shields.io/github/v/tag/multichainerz/AI?label=release&color=2ea043" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-BUSL--1.1-blue" /></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white" />
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-17-4169E1?logo=postgresql&logoColor=white" />
  <img alt="Deployment" src="https://img.shields.io/badge/deployment-on--premises-7457DF" />
</p>

## Architecture

<p align="center">
  <img src="docs/assets/orcasynapse-architecture.svg" alt="VM1 runs the OrcaSynapse control plane and PostgreSQL; VM2 runs the isolated Hermes runtime and owns native sessions and memory; an OpenAI-compatible endpoint provides inference; audit batches can be forwarded to a SIEM" width="100%" />
</p>

The baseline uses two VMs and an existing OpenAI-compatible inference endpoint:

- **VM1 — control plane:** web workspace, API, worker, stock PostgreSQL 17, encrypted configuration, a searchable revision mirror of the allowlisted Hermes corpus, sanitized run projections, incidents, and the append-only audit trail.
- **VM2 — Hermes runtime:** native sessions, Skills, toolsets, `MEMORY.md`, `USER.md`, and runtime execution under a hardened systemd service.
- **Inference:** a dashboard-approved model route. Credentials remain on VM1; VM2 receives a scoped gateway credential.
- **SIEM (optional):** at-least-once forwarding of the retained audit trail.

There is no control-plane vector store, embedding model, document library, external memory service, Redis, queue broker, object store, or LiteLLM tier.

## Install

v4.6.0 established the greenfield `hermes-native-v1` schema generation. v4.7.0 added the Corpus companion; subsequent v4.7.x patches hardened its privilege transition and ensure every mirrored Skill support tree has an observed parent.

**Any VM1 installation carrying the `hermes-native-v1` schema epoch updates in place**, whichever release it was installed from. `install.sh` reads the literal marker at `.local/state/schema-epoch` and compares it to that string; it parses no version number anywhere in the decision. Rerun the current generated VM2 installer with `--repair` to install the current companion. A database from before v4.6.0 carries no marker and still requires a clean installation.

On a clean Debian or Ubuntu VM1:

```bash
curl -fsSL https://raw.githubusercontent.com/multichainerz/AI/main/install.sh | sudo bash
```

The installer provisions Docker, stock PostgreSQL 17, the API, worker, workspace, protected secrets, and the first administrator. Open the address it prints, connect inference, then use **Settings → Setup**, step 2 (*Install the agent runtime*), to generate the one-time VM2 enrollment command.

VM2 installs vanilla Hermes at the approved commit, applies the managed native-memory and toolset baseline, enrolls its node identity, reports signed heartbeats, and publishes a signed allowlisted corpus snapshot. OrcaSynapse does not require SSH credentials or a remote shell channel.

## Product surfaces

- **Dashboard:** one-screen readiness and operations command center.
- **Session:** durable conversations over Hermes’ native session API, with streaming, cancellation, telemetry, feedback, archive, export, and audit projections.
- **Agents:** immutable Profile Distributions and run history (Profiles), a repository-style view of Hermes-native Skills and memory, and runtime toolset admissions (Tools).
- **Settings:** bring-up and Hermes enrollment (Setup), inference routes, prompts, guardrails, enterprise identity, encrypted connections, and application updates.
- **Operations:** health and incidents, the audit trail, and optional SIEM forwarding.

## Memory and audit

Hermes is the only memory owner. OrcaSynapse sends a conversation UUID as the Hermes native session ID and never replays PostgreSQL chat history as model context. A root-owned VM2 companion publishes signed, bounded snapshots of allowlisted `MEMORY.md`, `USER.md`, Skill, bundle, provenance, and pending-change files. PostgreSQL provides lexical search and immutable revisions; it is never used as model context. Session databases, credentials, symlinks, secret-like files, oversized files, and unapproved paths are excluded.

Governed edits travel back as signed mutation commands with an observed-content hash. Hermes applies memory changes through its native MemoryStore and Skill changes through its native validation and mutation functions. Destructive changes require a second administrator. VM1 never mounts VM2 storage and has no SSH or remote-shell path.

PostgreSQL remains the system of record for control-plane configuration, the non-authoritative corpus mirror, and sanitized operational evidence. Run lifecycle events, corpus decisions, telemetry, failures, and user actions remain auditable without creating a second agent-memory source.

Vanilla Hermes keeps transcripts per session but shares file-backed memory within the active Hermes home/profile. This pre-production topology is one trust boundary and is not multi-user memory isolation.

## Development

Requirements: Node.js 24+, pnpm 10+, Docker, and stock PostgreSQL 17.

```bash
pnpm install
docker run -d --name orca-base -p 15432:5432 \
  -e POSTGRES_USER=orca -e POSTGRES_PASSWORD=orca -e POSTGRES_DB=postgres \
  postgres:17-bookworm
export ORCASYNAPSE_TEST_DATABASE_URL=postgresql://orca:orca@127.0.0.1:15432/postgres
pnpm verify
```

Use `pnpm dev` for the API and workspace and `pnpm dev:worker` for durable Hermes dispatch.

## Documentation

| Guide | Scope |
| --- | --- |
| [Architecture](docs/ARCHITECTURE.md) | Ownership, data flow, network boundaries, and recovery |
| [Installation and recovery](deploy/BOOTSTRAP.md) | VM1 bootstrap, clean-install requirement, secrets, backup, and erase |
| [Agentic System enrollment](docs/AGENTIC_SYSTEM_ENROLLMENT_RUNBOOK.md) | VM2 enrollment, native state, toolset allowlist, and decommission |
| [Audit trail and SIEM forwarding](docs/AUDIT_TRAIL_RUNBOOK.md) | Reading, forwarding, health, and replay behavior |
| [Model controls](docs/MODEL_CONTROL_RUNBOOK.md) | Model registration, versioning, and activation |
| [Prompt controls](docs/PROMPT_CONTROL_RUNBOOK.md) | Versioned prompts and promotion |
| [Guardrail controls](docs/GUARDRAIL_CONTROL_RUNBOOK.md) | Runtime policy versioning and activation |
| [Product requirements](docs/ORCASYNAPSE_PRD.md) | Current scope, roles, and acceptance boundaries |
| [Web design system](apps/web/DESIGN_SYSTEM.md) | shadcn/Tailwind source boundaries, tokens, CSP, and accessibility |
| [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [License](LICENSE) | Project meta |

> OrcaSynapse is an on-premises pre-production control plane. Production approval remains environment-specific.
