# Model Control Runbook

OrcaSynapse's Models workspace is the approved workload catalogue. It does not download, load, or reconfigure models on a GPU server.

## Workloads

| Workload | Serving connection | Use |
| --- | --- | --- |
| Chat | Inference Server | default route for direct OrcaSynapse Chat |
| Agent | Inference Server | alias pinned by the internal gateway for Hermes |

Chat and Agent routes must use an approved OpenAI-compatible Inference Server connection. OrcaSynapse does not run a separate embedding model or inference sidecar on VM1.

## Lifecycle

1. Register and successfully test the serving connection.
2. Create a draft route with exact alias and bounded limits.
3. Verify representative quality, safety, context, streaming, cancellation, and performance behavior against that exact version. OrcaSynapse does not record this verification; retain it wherever your change record lives.
4. Activate with a reason; select one default Chat route and one active Agent route.
5. Suspend on incident, regression, or incompatible upstream change.

Activation requires the selected serving connection to be enabled and healthy, and the connection kind to match the workload. It carries no separate evidence precondition: OrcaSynapse used to demand a promoted evaluation run for the exact `model:<slug>` and version, and that requirement — along with the Release gates screen that produced it — was removed.

A material edit (version, alias, limits, connection) returns a route to draft, so an activated route is always the exact version that was reviewed. The route version is immutable within a revision and the activation reason is retained in the audit trail.

The internal inference gateway requires exactly one ACTIVE default Agent route. It does not fall back to a free-form connection alias, including on already-enrolled nodes that never activated a catalogue route. Setup step 2 can write that first default from the observed catalogue; this workspace is how later routes are admitted, activated, and suspended.

## Runtime behavior

Direct Chat uses the active default Chat alias. The internal runtime gateway uses the active Agent alias and replaces any caller-supplied model. It caps requested output tokens to the route and connection limits. The upstream inference API key is decrypted only in the API process and is never returned to the browser or to Hermes.

## Acceptance

Against the exact production inference-backend/model build, retain your own evidence for:

- `/v1/models` and `/v1/chat/completions` compatibility;
- the exact chat template, reasoning parser, and tool-call parser;
- streaming chunks and terminal usage fields;
- cancellation and timeout propagation;
- context and maximum-output boundaries;
- structured output and tool calls used by Hermes;
- malformed/upstream failure sanitization;
- RTX 6000 PRO capacity, concurrency, KV-cache pressure, thermals, and soak behavior;
- rollback to the previous approved alias/build.
