# Model Control Runbook

OrcaSynapse's Models workspace is the approved workload catalogue. It does not download, load, or reconfigure models on a GPU server.

## Workloads

| Workload | Serving connection | Use |
| --- | --- | --- |
| Chat | Inference Server | default route for direct OrcaSynapse Chat |
| Agent | Inference Server | alias pinned by the internal gateway for Hermes |

Chat and Agent routes must use an approved OpenAI-compatible Inference Server connection. OrcaSynapse's knowledge embeddings (BGE-M3, 1024 dimensions, pgvector) run locally on VM1 in the API and worker processes and are deliberately not a model route: they are a control-plane capability, not an approved workload alias.

## Lifecycle

1. Register and successfully test the serving connection.
2. Create a draft route with exact alias and bounded limits.
3. Evaluate representative quality, safety, context, streaming, cancellation, and performance behavior.
4. Promote immutable `MODEL` evidence for the exact candidate/version.
5. Activate with a reason; select one default Chat route and one active Agent route.
6. Suspend on incident, failed evaluation, or incompatible upstream change.

After first activation for a workload, OrcaSynapse fails closed if its governed active route disappears. It does not fall back to a free-form connection alias.

## Runtime behavior

Direct Chat uses the active default Chat alias. The internal runtime gateway uses the active Agent alias and replaces any caller-supplied model. It caps requested output tokens to the route and connection limits. The upstream inference API key is decrypted only in the API process and is never returned to the browser or to Hermes.

## Acceptance

Against the exact production inference-backend/model build, retain evidence for:

- `/v1/models` and `/v1/chat/completions` compatibility;
- the exact chat template, reasoning parser, and tool-call parser;
- streaming chunks and terminal usage fields;
- cancellation and timeout propagation;
- context and maximum-output boundaries;
- structured output and tool calls used by Hermes;
- malformed/upstream failure sanitization;
- RTX 6000 PRO capacity, concurrency, KV-cache pressure, thermals, and soak behavior;
- rollback to the previous approved alias/build.
