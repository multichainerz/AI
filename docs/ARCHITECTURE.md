# AIHub Architecture

## Production baseline

```mermaid
flowchart LR
  subgraph VM1["AIHub host"]
    WEB["React / Vite dashboard"]
    API["Fastify API and inference gateway"]
    WORKER["PostgreSQL state reconciler"]
    PG["PostgreSQL"]
    WEB --> API
    API <--> PG
    WORKER <--> PG
  end

  subgraph VM2["Isolated agent host"]
    HERMES["Hermes Agent"]
    SM["Supermemory Local"]
    HERMES <--> SM
  end

  subgraph GPU["Inference server"]
    VLLM["vLLM"]
    MODEL["Approved local model"]
    VLLM <--> MODEL
  end

  API -->|"approved direct Chat"| VLLM
  API -->|"governed agent runs"| HERMES
  HERMES -->|"node-scoped bearer key"| API
  SM -->|"node-scoped bearer key"| API
  API -->|"approved alias + local policy"| VLLM
  WORKER -->|"normalized knowledge"| SM
```

Development may co-locate services, but production acceptance assumes separate trust zones for AIHub, the agent runtime, and GPU inference.

## Ownership

| Component | Owns | Does not own |
| --- | --- | --- |
| AIHub | identity, authorization, service configuration, encrypted credentials, model/prompt/guardrail policy, document lifecycle, agent profiles, approvals, audit, inference gateway | model serving, semantic index internals, original enterprise files |
| PostgreSQL | AIHub control data, audit, sessions, durable domain workflow state, authorization provenance | embeddings, source bytes, Hermes runtime state |
| Runtime executor | idempotent reconciliation of unfinished PostgreSQL domain rows | independent queue state, semantic memory |
| Hermes | agent loop, tools/subagents, sessions, built-in bounded memory, native Supermemory integration | enterprise authorization, vLLM credentials, AIHub database access |
| Supermemory Local | semantic graph, normalized knowledge, long-term agent memory, local embeddings | AIHub authorization decisions, original-file authority |
| vLLM | OpenAI-compatible inference for the approved model | routing authority, enterprise policy, durable memory |

There is no LiteLLM tier. AIHub's internal gateway is deliberately narrow: it authenticates enrolled runtimes, pins the active Agent model alias, applies deterministic request checks and response bounds, rate-limits requests in PostgreSQL, and forwards to vLLM. It is not a general multi-provider proxy.

## Memory namespaces

- `mpm-agent-{identity}` is Hermes's profile-scoped native memory. Hermes may read and write it through its Supermemory provider.
- `mpm-knowledge` contains normalized enterprise document knowledge published by AIHub.
- AIHub reauthorizes every enterprise-knowledge result against current PostgreSQL ownership and publication state before it can enter Chat or a governed agent run.
- Hermes is not given unrestricted custom-container access. Access to enterprise knowledge remains mediated by AIHub.

Hermes's `MEMORY.md` and `USER.md` remain active because the official external-memory-provider model is additive. They hold small curated runtime facts; Supermemory provides deeper cross-session semantic memory.

The installed baseline pins the Hermes `api_server` platform to `no_mcp` and exposes no native model-callable toolsets. This does not disable automatic Supermemory recall/capture. Tools and subagent delegation are capabilities of Hermes, but they are not part of the production trust boundary until an AIHub-reviewed distribution explicitly enables and verifies them.

## Document lifecycle

1. AIHub validates, classifies, checksums, encrypts, and quarantines an upload in transient scratch space.
2. AIHub accepts UTF-8 TXT input and normalizes it directly; rich documents and images are rejected by this release.
3. The runtime executor reconciles the document row and publishes normalized content to `mpm-knowledge`.
4. After Supermemory confirms indexing, AIHub purges every staged byte for that document generation.
5. PostgreSQL retains only lifecycle, authorization, provenance, checksum, and audit metadata.
6. Deletion removes the Supermemory object and related transient staging.

This is intentionally not an enterprise file store. Source systems remain authoritative, and failed publication after staging expiry requires a fresh upload or connector fetch.

## Network policy

| Source | Destination | Purpose |
| --- | --- | --- |
| Browser | AIHub HTTPS | dashboard/API only |
| AIHub | PostgreSQL | private application/data network |
| AIHub | vLLM | direct Chat and gateway forwarding |
| AIHub runtime | Supermemory TCP 6767 | governed knowledge publication/retrieval |
| AIHub | Hermes TCP 8642 | governed run submission/status/stop |
| Hermes host | AIHub `/internal/v1` | model inference without a vLLM credential |
| Hermes host | AIHub runtime-node API | enrollment, memory registration, signed heartbeat |
| Hermes | local Supermemory TCP 6767 | native memory |

Deny browser-to-Hermes, browser-to-vLLM, Hermes-to-PostgreSQL, Hermes-to-Docker-control, and unrestricted outbound runtime access. Production must use customer-approved TLS/mTLS or equivalent private-network controls; the enrollment signature is application identity, not a replacement for transport security.

## Durability and recovery

- Back up PostgreSQL with point-in-time recovery appropriate to the customer RPO/RTO.
- Back up the complete Supermemory data directory consistently; it contains graph state, auth state, and local embedding state.
- Back up Hermes `/opt/data` when session continuity, Skills, built-in memory, and runtime configuration must survive host loss.
- Never back up AIHub document scratch as a knowledge repository.
- Retain the encrypted AIHub credential-recovery kit off-host and test it.
- Test restore into an isolated environment and verify model-route, namespace, authorization, and deletion behavior before declaring production readiness.

## Explicit non-dependencies

The application does not require Redis, Valkey, pg-boss, LiteLLM, S3-compatible storage, SeaweedFS, MinIO, or a separate pgvector service. Those may exist elsewhere in a customer's infrastructure but are not AIHub runtime dependencies.
