# Model Control Runbook

## Purpose and boundary

The Models workspace is AIHub's approved catalogue and workload-assignment control. It does not create, download, load, or mutate models in LiteLLM, vLLM, Unlimited OCR, or Supermemory. Operators configure those serving systems separately, register their protected endpoints in AIHub connections, and then approve the aliases AIHub may use.

PostgreSQL stores catalogue state, limits, evaluation linkage, optimistic revisions, and audit events. Connector credentials remain in AIHub's encrypted credential store and are never copied into a model route or returned to the browser.

## Workload mappings

| Workload | Permitted serving connection | Current runtime enforcement |
|---|---|---|
| Chat | LiteLLM | The default active route controls new conversations and inference requests. |
| Agent | LiteLLM or vLLM | Once catalogue enforcement begins, Hermes profiles can activate only when their alias has an active agent route. |
| OCR | Unlimited OCR | Catalogue and evidence control; document execution continues through the OCR connection. |
| Embedding | LiteLLM or vLLM | Catalogue and evidence control; Supermemory remains the sole semantic-index boundary. |

The endpoint must already expose the registered alias. AIHub does not infer a route from a model filename or rewrite upstream provider configuration.

## Lifecycle

1. Create a `DRAFT` route with a stable slug, model alias, immutable version, workload, serving connection, license reference, context/output limits, and concurrency limit.
2. For material changes to the alias, connection, limits, concurrency, or model version, declare a different version. AIHub rejects material changes that reuse the old version.
3. Create and complete a model evaluation candidate in Operations with target `model:<route-slug>` and the exact route version.
4. A separately authorized operator promotes the passing candidate with a rationale.
5. Activate the route with an operator reason. The serving connection must be enabled and healthy, and AIHub retains the exact promoted evaluation ID.
6. Optionally make the route the single default for its workload. Chat requires an active default route after catalogue enforcement begins.
7. Suspend a route before editing it. Suspension clears its default assignment but retains activation history and evidence linkage.

Active routes are immutable. Updates use an expected revision and reject stale browser state. PostgreSQL also enforces one active default per workload, required activation evidence, valid limits, and unique aliases inside a workload.

## Safe adoption and fail-closed behavior

Draft routes can be staged without interrupting the existing connection-level alias. The first successful activation records a permanent enforcement marker for that workload. From that point forward, AIHub does not fall back to the legacy free-form alias when controlled routes are suspended or unavailable.

For chat, an existing conversation remains bound to the alias with which it was created. When the default alias changes, users must create a new conversation; AIHub does not silently move an existing conversation to a different model. The application-level chat output cap remains 32,768 tokens even if the catalogue records a larger serving capability.

For Hermes, agent-profile activation continues to require its own exact promoted `agent:<profile-slug>` evaluation. After model catalogue enforcement begins for agents, the profile alias must additionally match an active `AGENT` model route.

## API surface

- `GET|POST /api/v1/admin/models`
- `PATCH /api/v1/admin/models/:modelId`
- `POST /api/v1/admin/models/:modelId/activate`
- `POST /api/v1/admin/models/:modelId/suspend`

Model readers require `models:read`; changes require `models:manage`. Every create, update, activation, and suspension writes an audit event.

## Deployment and acceptance

Apply migration `20260730001300_model_catalogue` before using the Models workspace. The migration does not import or activate the connection-level aliases automatically, so operators can prepare evidence before beginning enforcement.

Target-environment acceptance still requires:

- verifying every registered alias through the deployed LiteLLM, vLLM, or OCR endpoint;
- completing representative quality, safety, permission, latency, concurrency, and saturation evaluation evidence;
- proving default-route changes, conversation stickiness, suspension, rollback procedure, and fail-closed behavior;
- reconciling model license and deployment artifacts with MPM's approved inventory;
- validating RTX PRO 6000 capacity, GPU telemetry, and LiteLLM/vLLM request accounting;
- exercising backup and isolated restore of catalogue, evaluation, connection, and audit records.
