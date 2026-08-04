# Model Control Runbook

OrcaSynapse's Models workspace is the approved workload catalogue. It does not download, load, or reconfigure models on a GPU server.

## Workloads

| Workload | Serving connection | Use |
| --- | --- | --- |
| Chat | Inference Server | default route for direct OrcaSynapse Chat |
| Agent | Inference Server | alias pinned by the internal gateway for Hermes and Supermemory |

Chat and Agent routes must use an approved OpenAI-compatible Inference Server connection. Supermemory's CPU-local embedding model is a VM2 agent-memory deployment concern and does not create an OrcaSynapse model route; OrcaSynapse's own document-knowledge embeddings (BGE-M3, 1024 dimensions, pgvector) run locally on VM1 and are likewise not a model route. The VM2 installer requests multilingual `Xenova/bge-m3` for Supermemory and verifies the model reported during first boot. New nodes pin v0.0.7-rc.2 because it fixes the upstream 128 KiB large-document workflow limit; v0.0.6 remains blocked because its published workflow runtime cannot process documents.

## Lifecycle

1. Register and successfully test the serving connection.
2. Create a draft route with exact alias and bounded limits.
3. Evaluate representative quality, safety, context, streaming, cancellation, and performance behavior.
4. Promote immutable `MODEL` evidence for the exact candidate/version.
5. Activate with a reason; select one default Chat route and one active Agent route.
6. Suspend on incident, failed evaluation, or incompatible upstream change.

After first activation for a workload, OrcaSynapse fails closed if its governed active route disappears. It does not fall back to a free-form connection alias.

## Runtime behavior

Direct Chat uses the active default Chat alias. The internal runtime gateway uses the active Agent alias and replaces any caller-supplied model. It caps requested output tokens to the route and connection limits. The upstream inference API key is decrypted only in the API process and is never returned to the browser, Hermes, or Supermemory.

## Acceptance

Against the exact production inference-backend/model build, retain evidence for:

- `/v1/models` and `/v1/chat/completions` compatibility;
- the exact chat template, reasoning parser, and tool-call parser;
- streaming chunks and terminal usage fields;
- cancellation and timeout propagation;
- context and maximum-output boundaries;
- structured output and tool calls used by Hermes/Supermemory;
- malformed/upstream failure sanitization;
- RTX 6000 PRO capacity, concurrency, KV-cache pressure, thermals, and soak behavior;
- rollback to the previous approved alias/build.
