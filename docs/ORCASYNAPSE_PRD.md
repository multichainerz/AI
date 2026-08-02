# OrcaSynapse Product Requirements

## Product outcome

OrcaSynapse gives an organization one on-premises dashboard for local-AI chat, document knowledge, Hermes agents, model routes, policies, integrations, and operational evidence without turning the agent runtime into an infrastructure administrator.

The product should feel usable after two actions: install OrcaSynapse on the control-plane host, then use the dashboard to connect an OpenAI-compatible inference server and enroll the isolated Hermes/Supermemory host.

## Users

- **Platform administrator:** installs, connects services, manages topology, recovery, and health.
- **Security administrator:** owns identity, guardrail, prompt, tool, and approval policy.
- **AI operations administrator:** manages model routes, evaluations, profiles, capacity evidence, and incidents.
- **Auditor:** reads immutable configuration, evidence, and audit history.
- **Enterprise user:** chats, submits governed agent work, and uses only authorized knowledge.

## Scope

### Dashboard

The responsive React application provides Chat, Documents, Agents, Models, Guardrails, Prompts, Integrations, AI Operations, and Deployment workspaces. Desktop and mobile layouts must use one coherent design system and expose the same security state.

### Chat

OrcaSynapse provides streaming Chat through an approved inference route. It persists conversations, final responses, token usage, time-to-first-token/latency where available, cancellation/failure state, feedback, and sanitized audit data in PostgreSQL. The browser never receives the upstream serving credential.

Agentic Chat and governed tasks use Hermes. OrcaSynapse shows run status, projected tool/subagent activity, sources, cancellation, and final output without storing hidden reasoning, raw tool secrets, or unrestricted event payloads.

### Documents and knowledge

OrcaSynapse is a content-extraction and publication workflow, not a permanent file server.

- Original enterprise systems remain authoritative.
- Uploaded bytes exist only in encrypted transient staging.
- This release accepts UTF-8 TXT input only.
- Rich files and images are rejected at upload rather than entering an incomplete extraction path.
- Only normalized content is durably published to Supermemory.
- PostgreSQL stores lifecycle, authorization, provenance, checksum, and audit metadata.
- Retrieval is reauthorized against PostgreSQL before entering a model request.
- Deletion removes both the durable Supermemory object and remaining transient material.

### Hermes agents

OrcaSynapse manages immutable Profile Distributions: behavior instruction, selected model alias, Skill references, limits, memory policy, tool grants, and guardrails. Profiles move through draft, standby, active, and suspended states with exact-version evidence.

Hermes runs in an isolated environment and can reach only:

- OrcaSynapse's authenticated inference gateway;
- its local scoped Supermemory service;
- the OrcaSynapse-governed MCP gateway when an approved profile grants it;
- explicitly allowlisted runtime destinations.

OrcaSynapse does not give Hermes PostgreSQL credentials, Docker control, host filesystem access, enterprise-storage administration, or unrestricted outbound access.

### Memory

Self-hosted Supermemory Local is the semantic-memory plane. Hermes gets a profile-scoped `orcasynapse-agent-{identity}` container. OrcaSynapse publishes governed document knowledge to `orcasynapse-knowledge`; Hermes receives that knowledge only through OrcaSynapse's authorization boundary.

Hermes's native bounded memory remains active alongside Supermemory. OrcaSynapse must preserve and document both recovery domains.

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

OrcaSynapse records connection health, model/prompt/policy revisions, evaluations, incidents, durable workflow state, agent runs, document lifecycle, onboarding evidence, and recovery state. Monitoring distinguishes live automated evidence from manual or stale attestations.

## Installation experience

### OrcaSynapse host

The public GitHub bootstrap resolves an immutable OrcaSynapse commit and starts PostgreSQL, migrations, API, runtime executor, and web with Docker Compose. It provisions a PostgreSQL-backed local administrator with a one-time temporary password, generates a separate credential-encryption master key and offline Installation Key, and requires the customer to replace the password at first sign-in and retain the recovery key in an organizational vault. The dashboard owns routine endpoint and credential entry; OIDC, including Microsoft Entra ID, is an optional post-activation identity layer. Production publication additionally requires a publisher-signed release manifest and pinned image digests.

### Agent host

The dashboard creates a short-lived one-use enrollment claim. The customer downloads one script from their own OrcaSynapse origin and executes it on a clean Ubuntu systemd VM. The script resolves the non-secret installation profile from OrcaSynapse, then:

1. creates an Ed25519 runtime identity;
2. starts a constrained official Hermes container;
3. enrolls it with OrcaSynapse;
4. receives an OrcaSynapse inference-gateway route, alias, and node key;
5. installs checksum-verified Supermemory Local with CPU-local `Xenova/bge-m3` embeddings (1024 dimensions);
6. configures Hermes's native Supermemory provider with a profile-scoped tag;
7. registers Supermemory with OrcaSynapse;
8. enables signed heartbeats.

The node persists a root-only recovery journal immediately after enrollment so all subsequent provisioning steps can be resumed without issuing another claim. Production invitations require a digest-pinned Hermes image, an exact Supermemory release, and an HTTPS OrcaSynapse origin.

OrcaSynapse retains no SSH password/key and no remote Docker socket. Upgrades use a separately signed/pinned release workflow rather than standing remote administration.

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
- maintaining an OrcaSynapse pgvector index or duplicate embedding plane;
- requiring Redis, Valkey, or S3-compatible object storage;
- exposing unrestricted Hermes capabilities to users;
- claiming production readiness without customer-environment tests.

## Acceptance

Development acceptance requires direct Chat, transient text publication, authorized retrieval/deletion, Hermes enrollment, native agent memory, signed heartbeat, and dashboard health against real endpoints.

Pilot acceptance adds representative users/data, model evaluation, load/cancellation, restore practice, incident exercises, false-positive review, and operational ownership.

Production acceptance adds exact artifact pins, TLS/PKI, firewall evidence, OIDC group mapping, recovery/RPO/RTO proof, GPU admission, adversarial testing, SIEM/monitoring, training, and signed customer approval.
