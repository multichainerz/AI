# OrcaSynapse Product Requirements

## Product outcome

OrcaSynapse gives an organization one on-premises agentic intelligence harness for governed Sessions, private document knowledge, Hermes-native memory and execution, model routes, policies, integrations, and operational evidence without turning the agent runtime into an infrastructure administrator.

The product should feel usable after two actions: install OrcaSynapse on the control-plane host, then use the dashboard to connect an OpenAI-compatible inference server and enroll the isolated Hermes host.

## Users

- **Platform administrator:** installs, connects services, manages topology, recovery, and health.
- **Security administrator:** owns identity, guardrail, prompt, tool, and approval policy.
- **AI operations administrator:** manages model routes, evaluations, profiles, capacity evidence, and incidents.
- **Auditor:** reads immutable configuration, evidence, and audit history.
- **Enterprise user:** works in governed Sessions, submits agent work, and uses only authorized knowledge.

## Scope

### Dashboard

The responsive React application provides six product areas: Dashboard, Session, Knowledge, Agents, Platform, and Operations. The Dashboard is a single-screen readiness command center; the other areas own their workflows without becoming duplicate top-level destinations. Desktop and mobile layouts expose the same security and readiness state, and light/dark presentation is shared across the application.

### Session

A normal Session always uses an active Hermes Profile and stable Hermes-native runtime session. Each message creates one governed run projection; OrcaSynapse sends only the new turn, while Hermes loads and persists its own transcript. OrcaSynapse persists the workspace projection, final response, usage and latency where Hermes reports them, cancellation/failure state, feedback, and sanitized audit data in PostgreSQL. The browser never receives the upstream serving credential.

OrcaSynapse shows run status, projected tool/subagent activity, sources, cancellation, and final output without storing hidden reasoning, raw tool secrets, or unrestricted event payloads. Direct model testing belongs only in the Platform inference playground.

### Documents and knowledge

OrcaSynapse owns document knowledge end to end on the control plane. It is an extraction and retrieval plane for derived knowledge, not a permanent file server.

- Original enterprise systems remain authoritative.
- Uploaded bytes are processed in flight and are never retained by OrcaSynapse; only extracted chunks and their embeddings persist.
- Supported formats are TXT, Markdown, HTML, CSV, JSON, PDF, DOCX, PPTX, and XLSX; images are rejected, and scanned PDFs without a text layer fail with an explicit error (there is no OCR).
- OrcaSynapse performs extraction, chunking, and CPU-local BGE-M3 embedding; PostgreSQL/pgvector owns the semantic index.
- PostgreSQL also stores lifecycle, authorization, provenance, checksum, and audit metadata.
- Retrieval is owner-scoped by construction; conversations can pin an explicit document set, and each agent run records the knowledge it was allowed to consult.
- Deletion removes the stored chunks and marks the metadata record deleted.

### Hermes agents

OrcaSynapse manages immutable Profile Distributions: behavior instruction, selected model alias, Skill references, limits, document access, tool grants, and guardrails. Hermes itself owns memory behavior. In Development, creating the first Profile performs the live Hermes check, activates that immutable version, and enables Session in one action. Pilot and Production activation additionally require promoted exact-version evaluation evidence; standby remains available for pre-release validation.

Hermes runs in an isolated environment and can reach only:

- OrcaSynapse's authenticated inference gateway;
- the OrcaSynapse-governed MCP gateway when an approved profile grants it (implemented, but unreachable against current Hermes builds — see ARCHITECTURE);
- explicitly allowlisted runtime destinations.

OrcaSynapse does not give Hermes PostgreSQL credentials, host service control, host filesystem access, enterprise-storage administration, or unrestricted outbound access.

### Memory

Hermes is the sole active owner of agent memory and conversational continuity. VM2 persists Hermes' native session database, `MEMORY.md`, and `USER.md` under the managed runtime state root. OrcaSynapse never reads, mirrors, edits, embeds, or exposes their contents and never replays its PostgreSQL message projection as model context. The audit plane records who initiated a run, safe lifecycle events, and how it ended without becoming a second memory store.

Native transcripts are session-specific. Vanilla `MEMORY.md` and `USER.md` are
shared across sessions in the active Hermes home/profile, so this pre-production
mode is a single trust boundary and is not accepted as multi-user memory
isolation.

Document knowledge remains a separate owner-scoped pgvector plane on VM1. Legacy OrcaSynapse memory schemas remain only for migration and rollback compatibility and are not granted to active runs.

### Inference and guardrails

One OpenAI-compatible inference server is the only model-serving dependency. The backend may be vLLM, llama.cpp, SGLang, Ollama, TGI, or a custom compatible implementation. OrcaSynapse calls it directly and exposes a private OpenAI-compatible gateway to enrolled runtimes. The gateway must:

- authenticate a node-scoped bearer secret stored encrypted by OrcaSynapse;
- ignore caller-selected model IDs and pin the active approved Agent alias;
- enforce bounded messages and token limits;
- reject configured unsafe control characters and recognizable credential patterns;
- enforce PostgreSQL-backed request limits;
- keep the upstream inference key server-side;
- sanitize upstream failures;
- support bounded streaming and cancellation.

The initial guardrail layer is deterministic and auditable. Semantic classifiers, DLP engines, or specialist safety models may be added later as optional narrow integrations; they must never become authorization authorities.

### Operations

OrcaSynapse records connection health, model/prompt/policy revisions, evaluations, incidents, durable workflow state, agent runs, document lifecycle, onboarding evidence, and recovery state. Monitoring distinguishes live automated evidence from manual or stale attestations. The append-only audit trail is readable in the dashboard under the `audit:read` scope, and an optional forwarder ships it to a customer SIEM with at-least-once delivery and health reporting observed by AI Ops.

## Installation experience

### OrcaSynapse host

The public GitHub bootstrap resolves an immutable OrcaSynapse commit and starts PostgreSQL, migrations, API, runtime executor, and web with Docker Compose. It provisions a PostgreSQL-backed local administrator with a one-time temporary password, generates a separate credential-encryption master key and offline Installation Key, and requires the customer to replace the password at first sign-in and retain the recovery key in an organizational vault. The dashboard owns routine endpoint and credential entry; OIDC, including Microsoft Entra ID, is an optional post-activation identity layer. Production publication additionally requires a publisher-signed release manifest and pinned image digests.

### Agent host

The dashboard creates a short-lived one-use enrollment claim. The customer downloads one script from their own OrcaSynapse origin and executes it on a clean Ubuntu systemd VM. The script resolves the non-secret installation profile from OrcaSynapse, then:

1. creates an Ed25519 runtime identity;
2. installs Hermes at the approved commit and starts it as a constrained systemd service;
3. enrolls it with OrcaSynapse;
4. receives an OrcaSynapse inference-gateway route, alias, and node key;
5. applies the OrcaSynapse-managed native-memory policy and guardrail baseline;
6. enables signed heartbeats.

The node persists a root-only recovery journal immediately after enrollment so all subsequent provisioning steps can be resumed without issuing another claim. Production invitations require a commit-pinned Hermes runtime and an HTTPS OrcaSynapse origin.

OrcaSynapse retains no SSH password/key and no remote execution channel. Upgrades use a separately pinned release workflow rather than standing remote administration: a new invitation names a new Hermes commit and the node re-enrolls.

## Security requirements

- default deny and least privilege across every workspace;
- separate scoped administrator roles and enterprise-user sessions;
- encrypted credentials with an off-host recovery procedure;
- salted, slow-hashed local passwords, bounded sessions and lockout controls, plus permanent Installation Key verification restricted to break-glass recovery and separate one-time Hermes enrollment invitations;
- signed, replay-protected runtime-node requests;
- TLS and customer network controls for every cross-host connection;
- no secrets in browser payloads, logs, audits, or model context;
- explicit classification and owner checks for document retrieval;
- fail-closed behavior after governed model/prompt/policy adoption;
- immutable evidence and reasoned lifecycle transitions;
- bounded inputs, outputs, event ingestion, concurrency, and retention.

## Non-goals

- replacing enterprise document repositories;
- administering arbitrary GPU hosts or downloading models;
- implementing a general provider router comparable to LiteLLM;
- operating an external vector database service (the knowledge index is pgvector inside the bundled PostgreSQL);
- requiring Redis, Valkey, or S3-compatible object storage;
- exposing unrestricted Hermes capabilities to users;
- claiming production readiness without customer-environment tests.

## Acceptance

Development acceptance requires Hermes-first Sessions, local document ingestion into the pgvector knowledge index, authorized status/deletion, Hermes enrollment, native agent memory, signed heartbeat, and capability-based Dashboard readiness against real endpoints.

Pilot acceptance adds representative users/data, model evaluation, load/cancellation, restore practice, incident exercises, false-positive review, and operational ownership.

Production acceptance adds exact artifact pins, TLS/PKI, firewall evidence, OIDC group mapping, recovery/RPO/RTO proof, GPU admission, adversarial testing, SIEM/monitoring, training, and signed customer approval.
