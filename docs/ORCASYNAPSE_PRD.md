# OrcaSynapse Product Requirements

## Product intent

OrcaSynapse is a private control plane for operating Hermes-based agentic workflows on customer infrastructure. It gives administrators one place to enroll the runtime, approve inference, define agents, constrain native tools, observe execution, preserve audit evidence, and respond to incidents.

## Current scope

### Dashboard and Sessions

- Show readiness, service health, activity, and the governed execution path.
- Create, fork, archive, and delete conversations backed by Hermes-native sessions.
- Stream visible responses and safe run events at the point they occur, grouping consecutive repeated tool calls without losing chronology or per-call detail.
- Keep agent identity visible, present compact response telemetry, expose composer context usage, and support cancellation.
- Keep the PostgreSQL transcript as a user-visible operational projection only.

### Agents and Settings

- Version and activate agent profiles, instructions, Skills metadata, limits, and model aliases.
- Browse and lexically search a signed mirror of Hermes memory and Skill files, inspect revisions, and submit governed CRUD changes.
- Register and test OpenAI-compatible inference connections.
- Manage model routes, prompt templates, guardrail policies, native toolset admissions, and governed tool metadata.
- Enroll, attest, monitor, revoke, repair, and remove a VM2 Hermes node.
- Check official stable OrcaSynapse release tags and provide a version-pinned VM1 update command without granting the browser or application container host control.

### Workspace experience

- Use Tailwind CSS and source-owned shadcn-style primitives as the shared control foundation.
- Preserve OrcaSynapse-specific dashboard, session, corpus, and operations compositions above those primitives.
- Use one semantic token contract for light and dark appearances, one semi-rounded component radius, and Lucide for functional interface icons.
- Remain operable by keyboard, trap and restore dialog focus, expose semantic disabled and status states, and keep accessible control names.
- Satisfy the production `style-src 'self'` policy without runtime stylesheet injection, JSX inline styles, off-origin visual assets, or missing self-hosted fonts.

### Operations and assurance

- Record run state, sanitized events, usage, failures, evaluations, and incidents.
- Separate the three operational questions into their own surfaces: Health (what is degraded now), Release gates (what evidence an activation carries), and the Audit trail (what happened). The production-readiness register remains in the schema but has no console surface: nothing in the product can create a control, so a screen for it would always be empty.
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
- unattended browser-initiated VM1 or VM2 host updates;
- multi-tenant isolation of a shared vanilla Hermes memory home;
- Redis, a queue broker, an object store, or a separate model-routing tier.

## Acceptance

A release is acceptable when repository verification and CSP closure pass, a fresh stock-PostgreSQL migration is idempotent, retired tables/extensions are absent, VM1 installs cleanly, VM2 enrolls at its approved Hermes commit, a native session turn completes, cancellation and failure evidence remain legible, keyboard focus remains contained in modal workflows, audit forwarding remains durable, and all public and internal documentation states the same ownership boundaries.
