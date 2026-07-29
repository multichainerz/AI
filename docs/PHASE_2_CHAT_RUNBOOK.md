# Phase 2 Controlled Chat Runbook

## Current operating mode

Controlled chat supports enterprise users through OIDC and retains the protected administrator session as a visibly labelled preview and recovery path. Enterprise authorization uses a fail-closed group allowlist and creates an opaque AIHub session; provider access and ID tokens are never stored in the browser.

The preview provides:

- PostgreSQL-backed conversations and messages;
- ownership isolation by authenticated subject;
- one approved model alias through exactly one enabled LiteLLM connection;
- encrypted, backend-only LiteLLM credential resolution;
- OpenAI-compatible server-sent token streaming;
- request cancellation and interrupted-stream persistence;
- bounded recent-message context;
- final token usage, latency, finish reason, and sanitized failure state;
- PostgreSQL-backed per-user request limits;
- updateable response feedback and rolling 24-hour operator telemetry;
- audit events for identity, conversation, feedback, and inference lifecycle changes.

It does not provide Hermes, tools, MCP access, document retrieval, or Supermemory context. Those capabilities remain default-denied until their later phases.

## Deployment

Apply the committed Prisma migration before starting the updated API:

```bash
pnpm --filter @aihub/database prisma:migrate:deploy
pnpm build
```

The Compose migration service applies the same migrations during a clean deployment. They add conversations/messages, enterprise users and sessions, single-use OIDC authorization requests, and response feedback. Pending PKCE verifiers use the existing envelope-encryption service.

## Enterprise OIDC configuration

From AIHub Settings, configure one OIDC connection with the issuer URL, client ID, write-only client secret, exact AIHub callback URI, requested scopes, claim names, token-endpoint authentication method, and at least one allowed MPM group. Enable and test the connection before exposing sign-in.

AIHub uses authorization code with PKCE S256, a browser-bound one-time state value, nonce verification, issuer/audience/signature validation against discovery JWKS, bounded no-redirect provider calls, and a local revocable session. Group membership is read only from the verified ID token and access fails closed when no configured group matches.

## LiteLLM configuration

From AIHub Settings, create or update the LiteLLM connection with:

- one enabled LiteLLM connection only;
- the internal HTTP(S) endpoint;
- the write-only API key when LiteLLM requires one;
- the primary model alias exposed through `/v1/models`;
- the chat completions path, normally `/v1/chat/completions`;
- maximum output tokens, temperature, inference timeout, and requests per user per minute;
- the shorter diagnostic timeout and health/model-discovery paths.

Run **Test connection** successfully after saving. Chat fails closed when no LiteLLM connection is enabled, more than one is enabled, its latest health state is not `HEALTHY`, or the conversation model no longer matches the configured alias.

## Runtime flow

1. An allowed enterprise user, or a scoped preview administrator, creates or opens a conversation.
2. AIHub validates conversation ownership and active state.
3. AIHub serializes and checks the PostgreSQL-backed user request limit, then claims a conversation generation to reject concurrent submissions.
4. The user message and pending assistant message are written atomically.
5. AIHub decrypts the LiteLLM credential in backend memory and sends bounded context plus the fixed pilot system instruction.
6. AIHub proxies typed server-sent events to the browser.
7. Completion, cancellation, or sanitized failure state is persisted and audited; completed assistant messages can receive ownership-scoped feedback.

The browser never receives the LiteLLM API key. The upstream receives a pseudonymous subject hash rather than the administrator subject.

## API surface

- `GET /api/v1/auth/oidc/status`
- `GET /api/v1/auth/oidc/start`
- `GET /api/v1/auth/oidc/callback`
- `GET|DELETE /api/v1/session`
- `GET|POST /api/v1/chat/conversations`
- `GET|PATCH /api/v1/chat/conversations/:conversationId`
- `POST /api/v1/chat/conversations/:conversationId/messages`
- `PUT /api/v1/chat/messages/:messageId/feedback`
- `GET /api/v1/admin/chat/metrics`

The message endpoint emits `started`, `delta`, `completed`, `failed`, and `cancelled` events. Administrative API responses and streams use `Cache-Control: no-store`.

## Failure handling

- Configuration failures are returned before streaming with an actionable `CHAT_NOT_CONFIGURED` response.
- LiteLLM authentication, rate-limit, timeout, rejection, malformed-stream, and interrupted-stream failures are mapped to sanitized codes.
- Partial assistant output is retained with `FAILED` or `CANCELLED` state for operational review.
- One pending response is allowed per conversation; simultaneous submissions fail with a conflict.
- The configured per-user rolling-minute limit is serialized with a PostgreSQL transaction advisory lock; no Redis-compatible service is required.
- A pending response abandoned for more than ten minutes is failed and audited automatically before that conversation accepts another message.
- Redirects are disabled for the LiteLLM request.
- Upstream context is capped at 40 recent messages and 120,000 characters; the model response is capped at one million characters in addition to the configured token limit.

## Phase 2 acceptance still required

- Register the production callback, groups, and pilot users in the real MPM identity provider and validate provider-specific claims.
- Approve model-access, conversation-retention, request-limit, and feedback policies.
- Validate streaming, cancellation, context behavior, and usage fields against the real LiteLLM/vLLM deployment.
- Exercise security tests for cross-user access, session revocation, prompt boundaries, and credential isolation.
- Run target-GPU concurrency, latency, load, and soak tests.
- Confirm operational ownership and support procedures before enabling pilot users.
- Approve the administrator-preview retirement or break-glass policy after enterprise acceptance.
