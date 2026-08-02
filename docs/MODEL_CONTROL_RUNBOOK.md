# Model Control Runbook

OrcaSynapse's Models workspace is the approved workload catalogue. It does not download, load, or reconfigure models on a GPU server.

## Workloads

| Workload | Serving connection | Use |
| --- | --- | --- |
| Chat | Inference Server | default route for direct OrcaSynapse Chat |
| Agent | Inference Server | alias pinned by the internal gateway for Hermes and Supermemory |

Chat and Agent routes must use an approved OpenAI-compatible Inference Server connection. Supermemory's local embedding model is a Supermemory deployment concern and does not create an OrcaSynapse model route or vector plane. OrcaSynapse requests multilingual `Xenova/bge-m3` (1024 dimensions) and verifies what the runtime loads; the current local-server binary lineage falls back to its English-only 768-dimensional default because of [upstream issue #1336](https://github.com/supermemoryai/supermemory/issues/1336). Supermemory v0.0.5 remains the current workflow-safe pin because v0.0.6 cannot process documents.

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
