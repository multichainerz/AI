# OrcaSynapse Architecture

OrcaSynapse is the identity, policy, orchestration, and observability plane around an isolated Hermes runtime. It is not a second agent framework, a file repository, or a model server.

## Production baseline

```mermaid
flowchart LR
  USER["Browser"] --> WEB["OrcaSynapse dashboard"]

  subgraph VM1["VM1 · control plane"]
    WEB --> API["Fastify API"]
    API <--> PG["PostgreSQL + pgvector<br/>control-plane state, knowledge chunks,<br/>agent memory, embeddings, audit trail"]
    WORKER["Hermes run reconciler"] <--> PG
  end

  subgraph VM2["VM2 · isolated agentic system"]
    HERMES["Hermes Agent<br/>no durable store"]
  end

  subgraph GPU["AI Inference"]
    SERVER["OpenAI-compatible server"] <--> MODEL["Approved local model"]
  end

  WORKER -->|"submit, observe, cancel"| HERMES
  HERMES -->|"node-scoped inference route"| API
  API -->|"approved alias and bounded request"| SERVER
  API -.->|"optional audit forwarding"| SIEM["Customer SIEM"]
```

The minimum deployment is two VMs plus an existing inference endpoint. VM1 runs OrcaSynapse and PostgreSQL (the bundled image is `pgvector/pgvector:pg17`; the migrator creates the `vector` extension). VM2 runs only the Hermes runtime. The inference endpoint may be vLLM, llama.cpp, SGLang, Ollama, TGI, or another compatible server.

## One owner for each kind of state

| Component | Owns | Never owns |
| --- | --- | --- |
| OrcaSynapse | workforce and administrator identity, authorization, encrypted endpoints, Profile releases, policy, audit, document knowledge (extracted chunks and their embeddings), metadata, incidents, and operational evidence | agent execution, original files, or model weights |
| PostgreSQL | OrcaSynapse control-plane state, durable Hermes-run state, extracted knowledge chunks and agent memory with pgvector embeddings, and the append-only audit trail | original source bytes, Hermes session internals, or model weights |
| Hermes | agent sessions, loop execution, Skills, tool and sub-agent behavior, and bounded native memory | enterprise authorization, PostgreSQL access, or inference credentials |
| AI Inference | OpenAI-compatible model serving | routing authority, durable memory, or enterprise credentials |

There is no direct Chat-to-model path. Normal Chat creates a governed Hermes Agent Run. A PostgreSQL worker acquires an exclusive renewable processing lease, submits the run to VM2, follows safe lifecycle events, supports explicit cancellation, and finalizes both the run and linked Chat message. The browser stream is only a live subscriber: disconnecting it does not cancel durable execution. The run ID is the idempotency key; the conversation ID is the stable Hermes session ID.

After VM2 is enrolled and healthy, a Development administrator can use **Create & activate** once: OrcaSynapse runs the Hermes compatibility check, activates the immutable Profile Distribution, and enables the global execution boundary. Pilot and Production continue requiring promoted evaluation evidence before activation.

## Knowledge lifecycle

Document knowledge is entirely local to VM1; no VM2 service participates.

1. The browser uploads a source to OrcaSynapse.
2. OrcaSynapse authenticates the identity and validates classification, file name, MIME type, retention, and the 50 MB limit. Supported formats: TXT, Markdown, HTML, CSV, JSON, PDF, DOCX, PPTX, XLSX (images are rejected).
3. OrcaSynapse extracts the text **in flight** (unpdf for PDF, officeparser for Office formats, direct decoding for text formats), chunks it, and embeds each chunk with CPU-local BGE-M3 (1024 dimensions).
4. PostgreSQL stores the chunks and embeddings (`DocumentChunk`, HNSW cosine index) plus ownership, classification, checksum, size, status, retention, and audit metadata. **Original file bytes are never stored**; a failed transfer requires re-upload.
5. Retrieval is an owner-scoped pgvector similarity search. Chat can **pin documents to a conversation** (`ChatConversationDocument`), and each agent run records the document set it was allowed to consult (`AgentRun.knowledgeDocumentIds`).
6. Deletion removes the chunks and marks the metadata record deleted.

There is no OCR: scanned or image-only PDFs carry no extractable text layer and fail indexing with an explicit error; the dashboard states this limitation instead of claiming universal local extraction.

## Memory boundaries

- **Agent memory** is served by OrcaSynapse from the same pgvector plane as document knowledge (`AgentMemory`), scoped to `(ownerSubject, agentProfileId)` by predicates inside every statement. The worker recalls before submitting a run and injects the result into the run's instructions under a `RECALLED MEMORY` heading, with the same untrusted-data framing as knowledge excerpts. With a single Hermes turn there is no loop in which the agent could request memory mid-run, so retrieving up front loses nothing and keeps the decision about what an agent may know inside OrcaSynapse.
- **What an agent stores is a per-profile choice** (`memoryMode`), defaulting to `DOCUMENTS_ONLY` so an installation stores nothing about anyone until an administrator decides otherwise. `LEARN_USER` stores the person's own turns and never the model's output, so a wrong answer cannot become a durable fact; `LEARN_EXCHANGE` opts into storing both sides. The mode is frozen onto each run as capabilities, so editing a profile cannot change what an in-flight run may do.
- One installation-wide `MemoryPolicy` caps every agent at once. A profile may be narrower than the ceiling but never wider, and the ceiling is read at capture time so suspending it applies to runs already in flight. Everything stored is readable and deletable from **Platform → Memory** under the `memory:read` / `memory:manage` scopes. See [AGENT_MEMORY_RUNBOOK.md](AGENT_MEMORY_RUNBOOK.md).
- Memory is bounded by pruning on write: expired items are dropped and the oldest beyond the per-agent cap are trimmed.
- **Document knowledge** (enterprise sources) lives in PostgreSQL/pgvector on VM1, scoped per owner by SQL predicate — it never transits VM2.
- Hermes `MEMORY.md` and `USER.md` remain small native runtime files because the upstream external-memory provider is additive.

## Benchmarks and the evaluation ledger

Two systems that look alike and are not. `EvaluationRun` is a **record**: an operator states how many cases passed, and promotion is gated on that evidence. `BenchmarkRun` **executes** — it drives the live stack and produces those numbers. So benchmarks feed the ledger rather than duplicating it, which is why `evaluationRunId` sits on the benchmark run and why both reuse the `evaluations:read` / `evaluations:manage` scopes: running one *is* evaluation work, so no role needed a new grant.

A chat case queues an ordinary `AgentRun` and the worker's own processor picks it up, so a benchmark exercises the same queue, profile version, retrieval, boundary and capability checks as a person's message. Nothing about it is simulated. A run reads agent memory and never writes to it — capture would change the system being measured, and the second run of a suite would then score differently because of the first.

Every check is a string or latency comparison whose verdict is stored beside the case; nothing is judged by a model, because scoring that cannot be audited cannot argue a release is safe. Executed against the live stack, a run in flight has no pass rate, and its target — agent, version, model alias, owner subject — is denormalised onto the row so a historical result keeps reading true after the profile it used is edited or deleted. See [BENCHMARK_RUNBOOK.md](BENCHMARK_RUNBOOK.md).

## Audit trail and SIEM forwarding

Every governed action writes an append-only `AuditEvent`. The trail is readable in the dashboard (**Operations > Audit trail**, `audit:read` scope, keyset-paged) and can be forwarded to a customer SIEM configured as a service connection: a timer-driven forwarder POSTs JSON batches with a keyset cursor, at-least-once delivery (a failed batch never advances the cursor), and duplicate-safe event IDs. Forwarding health (`HEALTHY` / `BEHIND` / `FAILING` / `NOT_CONFIGURED`) is reported in the audit view and observed by AI Ops, which opens an incident when the destination rejects batches. See [AUDIT_TRAIL_RUNBOOK.md](AUDIT_TRAIL_RUNBOOK.md).

## Runtime and tool boundaries

The VM2 installer pins the OrcaSynapse inference route, installs Hermes natively at an approved 40-character git commit under systemd, and applies secret redaction and loop circuit breakers in Hermes managed configuration. The commit is the artifact identity: it is a content digest of the runtime tree, verified by reading it back out of the installed checkout rather than by trusting the value the installer requested. Isolation is enforced by the unit rather than by a container -- an unprivileged service account, `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, a capability bounding set, a restricted address-family set, and write access limited to the runtime's own data directory. A seccomp `SystemCallFilter=` is not yet applied and is tracked as follow-up hardening. The default distribution exposes no native model-callable MCP toolset. OrcaSynapse's governed MCP surface is **currently unreachable**, not merely default-deny: it refuses to hand over credentials unless the runtime advertises `private_run_context: "orcasynapse_mcp_headers_v1"`, a contract that exists only in this repository and that no shipped Hermes advertises. Even with that waived, Hermes invokes a tool as `session.call_tool(name, arguments)` with no session, run or user forwarded, over a connection shared by every run and every person — so a call cannot be scoped to its requester, which owner-scoped tools require. The read-only document-metadata handler is implemented but cannot fire. The dashboard does not advertise a consequential-action approval inbox because this release cannot originate those actions; legacy approval records remain migration-compatible but are not an active product surface.

Node lifecycle is an execution boundary:

- **Drain** rejects new work and lets accepted work finish.
- **Suspend** denies new and active work.
- **Resume** restores admission only after the signed heartbeat and Hermes connection are healthy.
- **Revoke** permanently disables node-scoped Hermes and inference access.
- **Remove** deletes the dashboard registration only after revocation; the operator separately runs the generated VM2 cleanup command to destroy local runtime data.

## Network policy

| Source | Destination | Purpose |
| --- | --- | --- |
| Browser | OrcaSynapse HTTPS | dashboard and API only |
| OrcaSynapse | PostgreSQL | private control-plane data, knowledge index, audit trail |
| OrcaSynapse | Hermes TCP 8642 | governed runs, status, and stop |
| Hermes | OrcaSynapse internal inference API | node-scoped model access |
| OrcaSynapse | AI Inference | approved OpenAI-compatible model calls |
| OrcaSynapse | Customer SIEM (optional) | forwarded audit batches |

Deny browser access to VM2 and inference, Hermes access to PostgreSQL or host service control, and unrestricted VM2 egress. Enrollment signatures identify the node but do not replace customer-approved TLS/mTLS and firewall controls.

VM2 needs wider egress *while installing* than it does in steady state, because a native Hermes install resolves its own dependency chain from public sources. See the network allowlist in [AGENTIC_SYSTEM_ENROLLMENT_RUNBOOK.md](AGENTIC_SYSTEM_ENROLLMENT_RUNBOOK.md); an air-gapped VM2 install is not supported on this path.

## Durability and recovery

- Back up PostgreSQL with a tested customer RPO/RTO and point-in-time recovery where required. The backup now carries the knowledge index and audit trail alongside control-plane state.
- Back up Hermes persistent data when sessions and Skills must survive VM replacement. Agent memory and knowledge live in PostgreSQL, so they are covered by the database backup above.
- Store the OrcaSynapse Installation Key and encrypted recovery kit off-host, then test recovery.
- Restore into an isolated environment and verify identity, Profile, model route, knowledge retrieval, and deletion behavior.
- Worker leases expire and can be recovered by another VM1 worker; terminal worker transitions also finalize linked Chat messages so browser or API-stream loss does not strand the conversation.

## Explicit non-dependencies

OrcaSynapse does not require Redis, Valkey, pg-boss, LiteLLM, S3-compatible storage, SeaweedFS, MinIO, an external vector database service, or a separate OCR service. pgvector is required and ships inside the bundled PostgreSQL image.
