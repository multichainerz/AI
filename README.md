# MPM AIHub

MPM AIHub is an on-premises control plane for internal AI chat, models, documents, memory, agents, MCP tools, policies, and operations.

## Current status

The locally implementable Phase 1 foundation is complete; target-environment acceptance gates remain. The repository currently contains:

- a responsive React administrative console for desktop and mobile;
- a Node.js/Fastify API foundation;
- shared TypeScript API contracts;
- a PostgreSQL/Prisma domain schema;
- an envelope-encryption package for the AIHub secrets vault;
- expiring, revocable administrator sessions with scoped foundation roles;
- authenticated, write-only connection credential APIs;
- a dashboard workflow for configuring LiteLLM, vLLM, Supermemory, SeaweedFS, and OCR;
- credential-aware connection diagnostics with bounded timeouts, persisted health state, and audit events;
- typed health adapters for OpenAI-compatible endpoints, SeaweedFS S3, OIDC, MCP, and HTTP services;
- service-specific operational settings for model aliases, health routes, diagnostic timeouts, and SeaweedFS S3 behavior;
- PostgreSQL-native `pg-boss` queues with retry, heartbeat, and dead-letter policies;
- a dedicated worker runtime with persisted liveness records;
- authenticated Operations APIs and dashboard controls for queue health, probes, and dead-letter recovery;
- append-only connection revision history and guarded non-secret configuration rollback;
- queue-definition degradation, confirmed recovery actions, and bounded worker-history retention;
- high-level product and phased delivery documents.

## Prerequisites

- Node.js 24 or newer
- pnpm 10 or newer
- PostgreSQL for database-backed development

## Commands

```bash
pnpm install
pnpm db:generate
pnpm typecheck
pnpm test
pnpm dev
pnpm dev:worker
```

The web application defaults to `http://localhost:5173` and the API to `http://localhost:4000`.

## Configuration model

Service endpoints and credentials are entered through AIHub. The only external bootstrap values are the PostgreSQL connection string, the master key used to unlock the encrypted configuration vault, and the initial administrator setup token. Production deployment mounts these as protected files rather than routine environment variables.

For a local container deployment, run `node scripts/generate-bootstrap.mjs` once and then `docker compose up --build`. See [`deploy/BOOTSTRAP.md`](deploy/BOOTSTRAP.md) for production handling requirements.

The initial Compose deployment applies committed Prisma and `pg-boss` migrations before starting the API and worker. The bootstrap administrator token is submitted once to create a random, server-side session and is not reused as an API credential. The browser receives only an `HttpOnly`, `SameSite=Strict` session cookie; stored service secrets are write-only and their plaintext values are never returned by the API.

Authorized administrators can run `POST /api/v1/admin/connections/:id/test` from the dashboard. AIHub resolves the encrypted credential only inside the API process, blocks redirects during HTTP checks, and returns a sanitized `HEALTHY`, `DEGRADED`, or `UNREACHABLE` result to the browser.

Non-secret connection settings are validated against a per-service allowlist before storage and are included in immutable configuration revisions. Unknown keys and settings belonging to a different service type are rejected. Rollback creates a new revision and preserves current credentials rather than reactivating historical secrets. TLS certificate verification remains strict; private CA lifecycle support is an explicit target-environment gate rather than an unsafe bypass switch.

See [`docs/AIHUB_PRD.md`](docs/AIHUB_PRD.md), [`docs/AIHUB_PHASED_PLAN.md`](docs/AIHUB_PHASED_PLAN.md), and the [`Phase 1 operations runbook`](docs/PHASE_1_RUNBOOK.md).
