# OrcaSynapse Product Requirements

## Product intent

OrcaSynapse is a private control plane for operating Hermes-based agentic workflows on customer infrastructure. It gives administrators one place to enroll the runtime, approve inference, define agents, constrain native tools, observe execution, preserve audit evidence, and respond to incidents.

## Current scope

### Dashboard and Sessions

- Show readiness, service health, activity, and the governed execution path.
- Create, fork, archive, and delete conversations backed by Hermes-native sessions.
- Stream visible responses and safe run events, support cancellation, and collect feedback.
- Keep the PostgreSQL transcript as a user-visible operational projection only.

### Agents and Settings

- Version and activate agent profiles, instructions, Skills metadata, limits, and model aliases.
- Browse and lexically search a signed mirror of Hermes memory and Skill files, inspect revisions, and submit governed CRUD changes.
- Register and test OpenAI-compatible inference connections.
- Manage model routes, prompt templates, guardrail policies, native toolset admissions, and governed tool metadata.
- Enroll, attest, monitor, revoke, repair, and remove a VM2 Hermes node.

### Operations and assurance

- Record run state, sanitized events, usage, failures, evaluations, readiness controls, and incidents.
- Preserve an append-only audit trail for administrative and execution lifecycle actions.
- Forward audit batches to an optional SIEM with retry-safe cursor state.
- Enforce local administrator, recovery, and OIDC role/scope boundaries.

## Memory contract

Hermes is the only owner of runtime context and memory. OrcaSynapse must:

- use stable native Hermes session IDs;
- allow Hermes to maintain its own transcript and built-in memory;
- avoid replaying control-plane chat rows as model history;
- keep VM2 authoritative while mirroring only allowlisted `MEMORY.md`, `USER.md`, Skill, bundle, provenance, and pending-change files for administrator observability;
- apply writes on VM2 through Hermes-native mutation APIs, signed commands, expected hashes, and separate approval for destructive changes;
- never mirror Hermes's session database or use the corpus mirror as model context;
- never embed or semantically index the corpus;
- retain auditability without turning operational evidence into an agent-memory store.

The current vanilla Hermes home/profile shares file-backed memory across its sessions. Until a stronger isolation topology is designed and accepted, the installation is one trust boundary and is not marketed as per-user memory isolation.

## Deployment requirements

- VM1: Docker Compose, Nginx, API, worker, web workspace, and stock PostgreSQL 17.
- VM2: clean Ubuntu systemd host with vanilla Hermes pinned to an approved commit.
- Inference: an existing OpenAI-compatible endpoint and an approved served model.
- Network: bidirectional VM1/VM2 reachability for API calls and signed heartbeats, with VM2 denied direct database access.
- Secrets: protected host files for bootstrap secrets and envelope-encrypted routine connector credentials.

`v4.6.0` is a greenfield generation. Installation must refuse an older database rather than imply that removed subsystems were migrated safely.

## Explicit non-goals

- owning or serving Hermes memory as an agent context source;
- local semantic retrieval, file ingestion, embedding, or vector indexing;
- an external memory service;
- a synthetic benchmark runner;
- remote shell administration of VM2;
- hosting or scheduling GPU inference;
- multi-tenant isolation of a shared vanilla Hermes memory home;
- Redis, a queue broker, an object store, or a separate model-routing tier.

## Acceptance

A release is acceptable when repository verification passes, a fresh stock-PostgreSQL migration is idempotent, retired tables/extensions are absent, VM1 installs cleanly, VM2 enrolls at its approved Hermes commit, a native session turn completes, cancellation and failure evidence remain legible, audit forwarding remains durable, and all public documentation states the same ownership boundaries.
