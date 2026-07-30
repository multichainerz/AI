# MPM AIHub — Product Requirements Document

**Status:** Draft v0.1  
**Product:** MPM AIHub  
**Deployment:** On-premises  
**Audience:** MPM IT, AI Engineering, Security, Infrastructure, Management, and implementation partners

## 1. Product Summary

MPM AIHub is a centralized on-premises platform for accessing, operating, governing, and monitoring MPM's AI capabilities. It provides employees with a secure AI assistant while giving authorized administrators one dashboard for AI models, agents, documents, memory, integrations, policies, infrastructure, usage, and audit activity.

AIHub will be built incrementally. This PRD defines the product boundaries and high-level responsibilities of each component; detailed workflows, schemas, interfaces, and operating procedures will be developed as each component is implemented.

## 2. Problem Statement

MPM has on-premises AI infrastructure and production AI use cases, but access, document processing, model operations, agent workflows, integrations, guardrails, and monitoring are fragmented. Employees need an accessible way to use internal AI, while IT needs centralized control over what the AI can access, which models it uses, how actions are approved, and how the platform is operated.

## 3. Product Vision

Create MPM's trusted internal AI operating platform: one secure interface for employees and one control plane for IT to manage the complete lifecycle of on-premises AI services.

## 4. Goals

- Provide one internal AI interface for conversational, knowledge, document, and agent-assisted work.
- Keep MPM data, inference, memory, and document processing on-premises.
- Centralize AI operations in a management dashboard.
- Improve adoption through a consistent and user-friendly experience.
- Allow agents to access only approved tools, systems, and data.
- Provide traceability for model requests, document processing, memory, tool calls, approvals, and administrative changes.
- Support incremental delivery without locking AIHub to a specific model or storage vendor.
- Operate without an application-level Redis dependency; use PostgreSQL and `pg-boss` for durable coordination.
- Make service endpoints, model routes, credentials, connectors, and operational settings manageable from AIHub rather than requiring routine environment-file changes.

## 5. Non-Goals for the Initial Product

- Training foundation models from scratch.
- General-purpose public SaaS or external customer tenancy.
- Fully autonomous high-impact actions without approval controls.
- Replacing MPM's ERP, DMS, SIEM, identity provider, or other systems of record.
- Supporting every enterprise integration in the first release.
- Implementing an AIHub-owned vector database alongside Supermemory.

## 6. Primary Users

### Employee

Uses chat, internal knowledge, document assistance, and approved agent capabilities.

### Department Power User

Uses specialized agents, departmental knowledge, document workflows, and approved integrations.

### AI Operator

Manages models, prompts, agents, document processing, memory, evaluation, and operational health.

### System Administrator

Manages infrastructure, identity, integrations, storage, deployment, secrets, backups, and availability.

### Security and Governance Administrator

Manages policies, permissions, approvals, retention, sensitive-data controls, and audit review.

### Management

Views adoption, operational status, business usage, risks, capacity, and measurable outcomes.

## 7. Product Principles

- **On-premises first:** MPM data and inference remain under MPM control.
- **Least privilege:** users and agents receive only the access required for their task.
- **AIHub-controlled execution:** AIHub is the source of truth for every endpoint, MCP server, tool, resource scope, and action that Hermes may access.
- **Human control:** consequential tool actions require explicit policy checks and, where required, human approval.
- **Traceable by default:** significant AI and administrative events are auditable.
- **PostgreSQL first:** PostgreSQL is the operational source of truth and coordination platform.
- **One semantic layer:** Supermemory is the sole memory, embedding, retrieval, and RAG abstraction.
- **Vendor-neutral object storage:** AIHub uses a dashboard-configured S3-compatible endpoint without coupling the application to a specific storage product.
- **Replaceable models:** applications use LiteLLM and stable internal interfaces rather than calling model servers directly.
- **Configuration control plane:** authorized administrators configure integrations, endpoints, routes, and secrets centrally through AIHub.
- **Progressive delivery:** begin with controlled use cases and add autonomy only after evaluation.

## 8. Product Components

### 8.1 Central AI Operations Dashboard

The dashboard is the primary administrative landing page for the AIHub platform.

It will provide high-level visibility into:

- platform and component health;
- GPU status and model availability;
- active users, conversations, and agent runs;
- token usage, latency, throughput, and errors;
- document-processing volume and failures;
- queue health and pending jobs;
- integration and connector status;
- pending approvals and policy violations;
- storage capacity and retention status;
- recent administrative and security events.

Dashboard visibility will be filtered by role and organizational scope.

### 8.2 Chat Workspace

The Chat workspace is the primary employee experience.

It will support:

- authenticated conversations with MPM's internal AI;
- streamed model responses;
- conversation history;
- source and document references;
- file attachments;
- agent and workspace selection where authorized;
- visibility into tool activity and approval requests;
- user feedback on answer quality;
- clear indication of model, agent, and knowledge scope in use.

### 8.3 Agent and Hermes Management

AIHub will use a hardened Hermes deployment for controlled agentic execution.

The Agent component will manage:

- agent profiles and purposes;
- model assignment;
- system instructions and skills;
- allowed MCP servers and tools;
- data and memory scopes;
- maximum turns, timeouts, and concurrency;
- approval requirements;
- safe-mode and kill-switch controls;
- allowed internal AIHub infrastructure endpoints;
- network egress and destination allowlists;
- run-scoped service identities and credentials;
- agent versioning and promotion between development and production;
- run history and failure inspection.

Hermes will operate inside a default-deny execution boundary. It will not independently decide or configure which infrastructure, MCP servers, or tools it can reach. AIHub will calculate the effective permissions for every agent run and enforce those permissions at the network, gateway, tool, and approval layers.

Hermes may access only:

- AIHub application services explicitly provided for agent use;
- the approved LiteLLM model endpoint;
- the approved memory/context interface;
- MCP servers assigned to the selected agent;
- individual tools granted within those MCP servers;
- resource scopes and actions permitted for the requesting user and agent.

Hermes will not receive direct access to PostgreSQL, S3 administration, Coolify, the Docker socket, host infrastructure, unrestricted filesystems, unrestricted shell execution, or the public internet unless a future use case is explicitly approved and exposed through a controlled AIHub tool.

For each run, AIHub will produce an effective capability set based on the user, role, department, agent profile, environment, tool grants, resource scopes, and approval policies. Every tool invocation will be revalidated at execution time. Changes, grants, denials, and emergency revocations will be auditable.

### 8.4 Document and Converter Workspace

The Converter component will turn approved enterprise documents into usable AI context.

It will provide:

- document upload and batch ingestion;
- file validation and quarantine;
- native text extraction where suitable;
- page rendering for scanned or visual documents;
- OCR using Unlimited-OCR;
- normalized Markdown and structured extraction artifacts;
- document status, version, source, checksum, and ownership metadata;
- processing retries and failure review;
- controlled publishing to Supermemory;
- deletion, reprocessing, and retention controls.

All long-running document work will execute asynchronously through PostgreSQL-backed jobs.

### 8.5 Knowledge and Memory Management

Supermemory will be AIHub's single semantic context layer for enterprise knowledge, retrieval, embeddings, and durable agent memory.

AIHub will provide controls to:

- define organizational, departmental, agent, project, and user memory scopes;
- publish approved documents and conversations;
- retrieve relevant context for chat and agents;
- inspect the source of retrieved context;
- correct, forget, or delete memories;
- apply retention and sensitivity policies;
- monitor ingestion and synchronization status;
- prevent cross-department or cross-user context leakage.

PostgreSQL will store source records and Supermemory references, not duplicate embeddings.

### 8.6 Model and Inference Management

The Models component will centralize available models and their serving endpoints.

Initial model roles are expected to include:

- Poolside Laguna S 2.1 NVFP4 for complex Hermes agent workflows;
- Unlimited-OCR for document parsing;
- Qwen3 Embedding for semantic indexing through Supermemory;
- additional smaller models for efficient or specialized workloads as evaluated.

The component will provide:

- model catalogue and deployment status;
- LiteLLM routes and vLLM endpoints;
- model role, license, version, and environment metadata;
- GPU assignment and memory utilization;
- health checks and availability;
- context, concurrency, and request limits;
- controlled rollout and rollback;
- benchmark and evaluation results;
- development and production separation.

### 8.7 LiteLLM Gateway

LiteLLM will be the centralized model API gateway between AIHub/Hermes and vLLM.

It will be responsible for:

- stable OpenAI-compatible internal endpoints;
- model routing and aliases;
- authentication and virtual access keys;
- request limits and usage accounting;
- supported input/output guardrail hooks;
- model fallback where approved;
- request metadata and operational logging;
- endpoint health and failure handling.

Distributed response caching will remain disabled initially.

### 8.8 Guardrails and Policy Management

Guardrails will be managed as layered policies rather than as a single filter.

AIHub will support policies for:

- model access by user, role, department, and use case;
- sensitive-data and PII handling;
- prompt and output restrictions;
- document classification and retrieval scope;
- agent tool permissions;
- agent network destinations and internal service access;
- agent-to-MCP and agent-to-tool assignments;
- user, department, environment, and resource-level tool scopes;
- read versus write actions;
- approval thresholds;
- maximum cost, duration, turns, and concurrency;
- blocked destinations and data egress;
- emergency suspension of models, tools, agents, or integrations.

Policy decisions and violations will be auditable.

### 8.9 Integration and MCP Management

The Integration workspace will manage connections between AIHub and approved enterprise systems.

It will provide:

- connector catalogue;
- integration ownership and business purpose;
- credential references stored through an approved secrets manager;
- connection testing and health status;
- read/write scope configuration;
- allowed agents and user groups;
- synchronization schedules;
- MCP server and tool registration;
- per-agent MCP and tool grants;
- per-tool resource and action scopes;
- network destinations and service identities used by each connector;
- approval and review status;
- integration activity and audit history.

Initial integrations will be prioritized by confirmed MPM use cases.

AIHub will be the authoritative control plane for these grants. Hermes configuration may contain generated runtime settings, but those settings will be derived from AIHub and will not be treated as an independent permission source.

### 8.10 Jobs and Workflow Operations

`pg-boss` will provide durable asynchronous processing using PostgreSQL.

The Jobs component will manage:

- OCR and document conversion;
- Supermemory ingestion and deletion;
- connector synchronization;
- scheduled agent tasks;
- model and integration health checks;
- retention and cleanup;
- retries, backoff, dead-letter handling, and manual replay;
- job concurrency and priority;
- job-level operational visibility.

Workers will be idempotent and use stable operation identifiers.

### 8.11 S3-Compatible Object Storage

The configured S3-compatible service will store AIHub's binary and generated artifacts.

Initial storage scopes will include:

- quarantined uploads;
- original documents;
- derived page images, OCR output, Markdown, and JSON;
- temporary exports;
- backup artifacts where appropriate.

AIHub will store bucket, object key, version, checksum, size, and classification metadata in PostgreSQL. S3 service administration will remain separate from application administration.

### 8.12 Identity and Access Management

AIHub will integrate with MPM's identity provider using OIDC or another approved enterprise protocol.

It will support:

- SSO;
- role-based access control;
- organizational and departmental scope;
- administrative separation of duties;
- service identities for internal components;
- session and access revocation;
- periodic access review;
- least-privilege defaults.

### 8.13 Approvals

The Approvals workspace will give authorized reviewers control over consequential agent actions.

It will provide:

- pending approval inbox;
- action summary and proposed target;
- requesting user, agent, and tool identity;
- supporting context and risk classification;
- approve, reject, expire, or cancel controls;
- optional multi-reviewer requirements;
- complete decision history.

### 8.14 Audit and Governance

AIHub will maintain a traceable record of significant activity.

Audit coverage will include:

- authentication and administrative actions;
- model, agent, policy, and integration changes;
- document access and processing;
- memory publication and deletion;
- tool calls and approvals;
- model requests at an appropriate privacy-safe level;
- security events and policy violations;
- retention and deletion events.

Audit events may be forwarded to MPM's SIEM according to governance requirements.

### 8.15 Observability and Infrastructure Operations

The Operations component will provide health, performance, capacity, and reliability visibility across AIHub.

It will cover:

- application and worker health;
- PostgreSQL and `pg-boss` health;
- S3 object-store health and capacity;
- Supermemory availability and ingestion latency;
- LiteLLM and vLLM health;
- GPU memory, utilization, temperature, and errors;
- model latency, throughput, context utilization, and failures;
- agent duration, tool calls, retries, and success rate;
- alerts and incident timelines;
- backup and restore status.

### 8.16 Platform Settings

Authorized administrators will manage shared platform configuration, including:

- organizational settings;
- environments, service endpoints, authentication methods, and TLS settings;
- LiteLLM and vLLM endpoints, model aliases, routes, limits, and health checks;
- PostgreSQL-dependent application settings and `pg-boss` worker policies;
- S3 endpoints, buckets, credentials, addressing mode, and storage policies;
- Supermemory endpoints, credentials, embedding configuration, and memory scopes;
- OCR service endpoints and processing defaults;
- MCP servers, connector endpoints, credentials, scopes, and allowed tools;
- identity provider, notification, observability, and SIEM connections;
- feature flags;
- default models and agents;
- storage and retention policies;
- notification channels;
- maintenance mode;
- platform version and migration status.

Configuration changes will support validation, test-connection checks, version history, controlled activation, rollback, and complete audit trails. Sensitive values will be masked after entry and will never be returned to the browser or written to application logs.

### 8.17 Configuration and Secrets Vault

AIHub will provide an on-premises configuration and secrets vault so routine operation does not depend on administrators editing environment files or restarting unrelated services.

The vault will provide:

- encrypted storage for API keys, passwords, client secrets, certificates, and connector credentials;
- envelope encryption using authenticated encryption and a separately protected master key;
- role-separated create, update, test, rotate, disable, and audit operations;
- secret versioning and rotation without exposing previous plaintext values;
- references from models, agents, MCP servers, and connectors instead of duplicated credentials;
- runtime-only secret resolution by authorized backend services;
- configuration export and import with secrets excluded by default;
- backup and recovery procedures for both encrypted records and the master key.

Hermes will not receive general connector credentials. AIHub will either proxy the permitted operation or issue a narrowly scoped, short-lived runtime capability when supported. Frontend clients will never receive infrastructure secrets.

AIHub still requires a minimal bootstrap trust mechanism because the application cannot securely retrieve the database credential and the key used to decrypt its own vault from that same encrypted database. Installation will generate these bootstrap values and mount them as protected local secret files or Docker/Coolify secrets. After bootstrap, all supported endpoints, keys, certificates, model routes, and connector settings will be managed from the AIHub dashboard. A future HSM or external on-premises secrets manager may replace the local master-key file without changing the administrator experience.

## 9. High-Level Technical Architecture

```mermaid
flowchart TB
    U["MPM Users and Administrators"] --> W["React AIHub"]
    W --> A["Node.js / TypeScript API"]

    A --> P["PostgreSQL + Prisma"]
    P --> Q["pg-boss"]
    Q --> WK["Node.js Workers"]

    A --> C["Agent Access Control"]
    C -. "Run-scoped capabilities" .-> H["Hardened Hermes"]
    H --> G["Policy, Tool Gateway, and Approval Layer"]
    G --> MCP["Approved MCP and Enterprise Systems"]

    H --> L["LiteLLM"]
    L --> V["vLLM Model Services"]

    WK --> O["Unlimited-OCR"]
    WK --> S["S3-compatible storage"]
    WK --> M["Supermemory"]
    H <--> M

    A --> OBS["Observability and SIEM"]
```

## 10. Data Ownership

- **PostgreSQL:** operational records, configuration, identity mappings, conversations, jobs, approvals, audit metadata, and external-service bindings.
- **AIHub secrets vault:** encrypted credential payloads and versions stored in PostgreSQL; the master encryption key is held separately from the database.
- **S3-compatible storage:** original files and generated binary/text artifacts.
- **Supermemory:** embeddings, semantic retrieval, enterprise knowledge context, and durable agent/user memory.
- **vLLM/model storage:** loaded model weights and inference runtime state.
- **SIEM/observability systems:** operational telemetry and security monitoring according to MPM policy.

No component may directly depend on another component's private database schema.

## 11. Non-Functional Requirements

### Security

- On-premises processing and storage.
- Encryption in transit and at rest where supported.
- No default public model or storage endpoints.
- Strong secrets handling and service identities.
- No plaintext infrastructure credentials in the browser, logs, audit payloads, or routine configuration exports.
- Minimal install-time bootstrap secrets kept outside the AIHub database; routine service configuration is performed in the dashboard.
- Least-privilege access and network segmentation.

### Reliability

- Durable jobs and safe retries.
- Health checks for every critical service.
- Backup and restore procedures.
- Recovery from worker and model-service restarts.
- Defined degraded behavior when a non-critical component is unavailable.

### Performance

- Stream chat responses as they are generated.
- Keep administrative pages responsive during long-running AI work.
- Process document jobs asynchronously.
- Establish performance targets from pilot measurements rather than assumptions.

### Maintainability

- TypeScript contracts shared between frontend and backend.
- Stable service adapters for models, storage, memory, and integrations.
- Versioned database migrations and APIs.
- Component-level configuration and health reporting.
- Versioned, validated, and reversible configuration changes through AIHub.

### Compliance and Governance

- Support MPM retention, deletion, residency, and audit requirements.
- Prevent unauthorized cross-scope retrieval.
- Preserve evidence for agent approvals and consequential actions.

## 12. Deployment Approach

Coolify will be used as the initial on-premises application and service deployment control plane. Pilot deployments may use simplified single-node service topologies. Production readiness will be evaluated independently for PostgreSQL, the selected S3-compatible service, Supermemory, model serving, GPU availability, backups, and DRC recovery.

The initial installer will provision AIHub's database access and master encryption key as mounted Coolify/Docker secrets or protected local files. These are bootstrap dependencies only. Administrators will configure all subsequent supported services and credentials from AIHub's Settings and Integration workspaces.

The AIHub application will not depend on Redis. PostgreSQL and `pg-boss` will provide durable coordination. Valkey may be evaluated only if a measured scaling requirement or supported vendor dependency cannot be met through the PostgreSQL ecosystem.

## 13. Delivery Phases

The authoritative implementation sequence, exit gates, dependencies, and MPM inputs are defined in `docs/AIHUB_PHASED_PLAN.md`. The shared phase map is:

- Phase 0: technical validation and scope baseline;
- Phase 1: platform foundation and configuration control plane;
- Phase 2: controlled internal chat and enterprise identity;
- Phase 3: document storage, conversion, and OCR;
- Phase 4: enterprise knowledge and agent memory;
- Phase 5: hardened Hermes agent runtime;
- Phase 6: MCP connectors and human approvals;
- Phase 7: AI operations, guardrails, and evaluation;
- Phase 8: production hardening and pilot rollout.

This PRD defines the target product; a capability listed here is not considered implemented or accepted until its corresponding phase gate is demonstrated.

## 14. Initial Success Measures

- Monthly and weekly active AIHub users.
- Repeat usage and department adoption.
- User-rated answer usefulness.
- Successful document processing rate.
- Retrieval relevance and source correctness.
- Agent task success and approval rate.
- Reduction in manual effort for selected workflows.
- Model availability, latency, and error rate.
- Number and severity of policy violations or unauthorized actions.
- Recovery performance for failed jobs and service interruptions.

## 15. Major Risks

- A single production GPU remains a capacity and availability constraint.
- Laguna's agentic coding strength may not translate directly to every MPM business use case.
- Incorrect memory or document scoping could expose information across departments.
- Broad MCP permissions could create unsafe agent actions.
- User adoption may remain limited without training and use-case ownership.
- Simplified Coolify service templates may not provide production-grade HA by default.
- Self-hosted Supermemory licensing, deployment dependencies, and support must be confirmed.
- Object versioning and WORM behavior must be validated before being treated as compliance controls.

## 16. Open Product Decisions

- First three employee and departmental use cases.
- Initial departments and pilot users.
- Exact Qwen3 Embedding variant.
- Memory-capture policy for conversations.
- Required document classifications and retention periods.
- Initial MCP systems and read/write permissions.
- Approval matrix for consequential actions.
- Production GPU redundancy and DRC model-serving approach.
- Production S3-compatible service, bucket policy, topology, and backup target.
- Required Supermemory commercial support and air-gapped packaging.

## 17. Product Acceptance at a High Level

AIHub is successful when an authorized MPM user can securely access internal AI, retrieve approved enterprise knowledge, process documents, and use controlled agent capabilities, while MPM administrators can centrally manage and audit models, agents, memory, documents, integrations, policies, storage, jobs, infrastructure, and usage from one platform.

No Hermes run will be accepted as compliant if it can reach an infrastructure endpoint, MCP server, tool, resource, or action that is not explicitly authorized by the effective AIHub policy for that run.
