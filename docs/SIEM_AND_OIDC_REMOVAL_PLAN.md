# Removing SIEM forwarding and OIDC federation

The goal is a smaller codebase, not a smaller product: both of these are
integrations with systems this deployment does not have, and each one costs a
reader of `apps/api` a module to understand before they can be sure it is not on
the path they are following.

Roughly **1,800–2,300 lines** come out across the two, plus two database tables.
The service kinds themselves stay — see hazard 2, which is the single most
important constraint in this document.

**Scope, stated plainly, because the two halves sound alike and are not.**
"SIEM" here means the *outbound forwarding integration* — the background job
that ships audit events to an external SIEM endpoint. **The audit trail is not
being touched.** Every event the product records, the Audit trail screen, its
filters and its export all stay exactly as they are. Increment 1 removes the
exporter, not the record.

## The distinction that decides the whole plan

**OIDC is not the same thing as enterprise identity, and only one of them is
being removed.** `enterprise-session.ts` is one 1,224-line file holding two
unrelated sign-in paths:

| Path | Functions | Fate |
| --- | --- | --- |
| Federated OIDC | `status`, `startLogin`, `completeLogin`, `oidcErrorCode`, `tokenExchangeFailure` (≈ lines 299–652) | removed |
| Local person sign-in | `signInWithPassword`, `changeLocalPassword`, `authenticate`, `revoke` (lines 653+) | **kept** |

That split is what makes this safe. `EnterpriseUser` is referenced by the
division manager, the person manager, the tooling manager, `relations.ts` and —
since scheduled turns — `schedule-runtime.ts`. Removing the *concept* would
cascade through Access, Divisions, division-scoped memory and scheduled turns.
Removing the *federated login path* touches none of them: an administrator
creates people under Settings → Access and they sign in with a password, exactly
as they can today.

## Two hazards, both of which change what the plan does

### 1. OIDC can mint administrator sessions

`admin-session.ts:662` issues a session with `authenticationMethod: "OIDC"`,
and the OIDC connection carries a `platformAdminGroups` list whose members
"receive the complete OrcaSynapse administrator scope set". So federated login
is not only a route for ordinary people — it is a route to **administrator**.

Removing it therefore removes an administrator access path. For a deployment
that signs in with a local password this is nothing; for one whose only
administrators arrive through Entra ID group mapping, it is a lockout. The plan
must state this in the changelog and the runbook, and the removal must not ship
in a release that a deployment could apply unattended without reading it.

### 2. `ServiceKind` is a PostgreSQL enum, and values cannot be dropped

`ServiceKind` is `pgEnum('ServiceKind', ['INFERENCE','HERMES','MCP','OIDC','SIEM','NOTIFICATION','OTHER'])`.
PostgreSQL has no `DROP VALUE`; removing one means recreating the type, which
fails outright if any row still uses it — and a deployment that configured a
SIEM or OIDC connection has exactly such a row.

**So the enum keeps all seven values.** This is the one place where "leaner" is
not worth it: the saving is one line of a generated migration, and the cost is
an upgrade that aborts on precisely the deployments that used the feature. The
values become unreachable rather than absent — nothing constructs them, nothing
reads them, and `REQUIRED_SERVICE_KINDS` never contained them.

The same reasoning applies to the tables. Dropping `OidcAuthorizationRequest`
and `AuditForwardingState` is safe (nothing outside the removed code reads
them); dropping `ServiceConnection` **rows** is not, and the plan does not — an
operator's stored OIDC connection stays where it is, inert. It cannot be deleted
from the connections screen, because there is none to delete it with: the
connections API registers no DELETE route at all. An inert row is harmless — the
kind is read by nothing, and the ai-ops workflow mapping that once let it degrade
the Operations overview has been zeroed — but this plan said otherwise twice and
was wrong both times.

### 3. The diagnostic adapter registry is exhaustive by type

`adapter-registry.ts` declares
`const adapters: Record<ServiceKind, ConnectionDiagnosticAdapter>`. Because
hazard 2 keeps all seven `ServiceKind` values, **both the `SIEM` and `OIDC`
entries have to stay** — deleting either fails `tsc` on the record type, and
deleting the type annotation instead would make `adapterFor` return `undefined`
for a stored connection of that kind and crash its next test.

So `oidc-adapter.ts` (64 lines) survives the OIDC removal. It is the one piece
of OIDC code that does: it tests a connection's discovery document and knows
nothing about sessions. Swapping it for `GenericHttpAdapter` to save those lines
would change what a connection test does for a kind nobody uses and cost its
test file; not worth it.

### 4. `AuditEvent.cursor` is the forwarder's column, and stays anyway

The audit trail's own listing pages on a keyset over `(occurredAt, id)`
(`audit-manager.ts:56`). `cursor` is read in exactly two places, both being
removed: the forwarder's batch query and `forwarding()`'s backlog count. After
this it is written by the sequence and read by nothing.

It stays regardless. Dropping a `bigserial` with a unique index is a migration
that buys nothing at runtime, and the column is the natural position marker if
forwarding is ever reintroduced.

---

## Increment 1 — SIEM forwarding — **done**

Isolated, and worth shipping alone. Nothing outside the audit plane reads it.

**Removed — the outbound integration and nothing else**

| File | What goes |
| --- | --- |
| `audit/siem-forwarder.ts` + test | whole files, 858 lines |
| `audit/audit-manager.ts` | `forwarding()` only (lines 90–144); `list()` untouched |
| `audit/routes.ts` | `GET .../audit/forwarding` only |
| `contracts/src/audit.ts` | `auditForwardingStateSchema` |
| `ai-ops/drizzle-ai-ops-manager.ts` | the `audit-forwarding` component and the `audit` dependency |
| `web/src/api.ts` | `getAuditForwarding` |
| `web/src/audit-view.tsx` | the forwarding status strip, ≈ lines 139–170 of 324 |
| `web/src/connection-definitions.ts` | the SIEM connection form |
| `runtime.ts` / `app.ts` | `siemForwarder` and its `start()`/`stop()` |
| schema | `AuditForwardingState` table |

**Kept — the audit trail, completely intact.** This is the point of the change,
so it is worth being exact about it. Every `auditEvent` write across the product
is untouched; `AuditManager.list()` and its keyset paging are untouched; the
Audit trail screen keeps its filters, its event list and its export. What
disappears from that screen is the one status strip at the top that reports
delivery to an external SIEM — a strip whose only states are "Retained
locally", "Forwarding to SIEM", "Forwarding is behind" and "Forwarding is
failing". With the integration gone, three of those four cannot occur and the
fourth is the permanent truth.

Also kept, deliberately: the `SIEM` entry in `adapter-registry.ts` (hazard 3)
and `AuditEvent.cursor` (hazard 4).

**Check before shipping**

- `aiOpsOverviewSchema` reaches forwarding through `AiOpsDependencies.audit`,
  and `drizzle-ai-ops-manager.test.ts` builds that dependency with a
  `forwarding()` stub. Both change in the same commit or the overview reports a
  component with no source.
- `audit-manager.test.ts` inserts `auditForwardingState` in three cases; those
  cases go with the method, and the `list()` cases in the same file stay.

## Increment 2 — OIDC federation — **done**

Larger and the one with the real caveat. Ship it after increment 1 has settled.

**Removed**

- The OIDC half of `enterprise-session.ts` (≈ 380–450 lines) and its
  OIDC-specific helpers: `isSecureOidcUrl`, `normalizeIssuer`, `claimAtPath`,
  `formEncodedComponent`, `OIDC_STATE_COOKIE`, the three `OIDC_*` limits.
- `OidcAuthorizationRequest`, the table backing the PKCE state exchange.
- The federated administrator path in `admin-session.ts`, including the
  `platformAdminGroups` → role mapping.
- Three of the six routes in `identity/routes.ts` — `GET /auth/oidc/status`,
  `/auth/oidc/start`, `/auth/oidc/callback` (lines 72–143). The other three
  stay: `POST /auth/local/login`, `PUT /auth/local/password`, and the `GET` and
  `DELETE` on `/session`, which serve local people and are the reason
  enterprise identity survives this.
- The OIDC entry in `connection-definitions.ts`, and the SSO button and
  `oidcConfigured` prop in `front-page.tsx`.
- `OidcStatus` / `OidcLoginStart` contracts.

`oidc-adapter.ts` is **not** removed — see hazard 3.

**Kept**

- `EnterpriseUser`, `EnterpriseUserSession`, `LocalUser`, and every path that
  reads them — Access, Divisions, division memory, scheduled turns.
- `signInWithPassword`, `changeLocalPassword`, `authenticate`, `revoke`.
- `AdministratorAuthenticationMethod.OIDC` as an enum value, for the same
  reason as `ServiceKind` above: existing `AdministratorSession` rows carry it.

**Check before shipping**

- `requireChatPrincipal` has an enterprise branch that must keep working —
  a local person with `chat:use` is the case that proves it.
- `front-page.test.tsx`, `app-local-login.test.tsx` and
  `enterprise-session.database.test.ts` all exercise both paths; the local half
  of each has to survive rather than be deleted alongside the federated half.
- `docs/` mentions OIDC in ARCHITECTURE, the PRD, the handoff and the enrollment
  runbook's identity prerequisites.

## What is deliberately not removed

- **The `ServiceKind` and `AdministratorAuthenticationMethod` enum values.** See
  hazard 2.
- **Anyone's configured connections.** A stored SIEM or OIDC connection row
  becomes an inert row; the upgrade does not delete it, and neither can an
  operator — see the correction above.
- **`NOTIFICATION` and `MCP` service kinds.** Out of scope here, and each
  deserves its own look — `MCP` in particular is referenced by the toolset
  boundary (`no_mcp`).

## Verification

`pnpm verify` is the gate, and two of its checks matter especially here:
`scripts/test-csp-closure.sh` walks the built bundle, so a dangling import from
`front-page.tsx` fails there rather than in a browser; and the API suite's
database tests will refuse a schema whose dropped tables are still referenced by
`relations.ts`.

Beyond the gate, the acceptance is negative and has to be checked by hand: sign
in as a local administrator, sign in as a locally created person, confirm the
audit trail still records both, and confirm Operations no longer shows an
`audit-forwarding` component rather than showing a broken one.


---

## What actually happened

Both increments shipped at v9.0.0 — a major, because the minor rolls at nine
and because removing federated sign-in removes an administrator access path.
`pnpm verify` green: API **708 → 653**, web
unchanged at 598.

**Three plan claims were wrong, and executing found them.**

- **There was no SIEM form in `connection-definitions.ts`.** SIEM connections
  were only ever reachable through the generic connection path.
- **`CURRENT_STATE_HANDOFF.md` claimed `apps/worker` did SIEM forwarding.** It
  never did — the forwarder ran in the API. The line was corrected rather than
  deleted.
- **`issueFederatedSession` survives, and this is the one piece of genuinely
  dead production code the removal leaves.** It is ~30 lines in
  `admin-session.ts` with no caller now that the identity manager cannot reach
  it. It stays because eight cases in `admin-session.test.ts` use it as a
  *session factory* while testing idle expiry, absolute expiry, revocation and
  retention — none of which are about federation. Rewriting them to seed an
  administrator and sign in locally is real churn against tests that would then
  assert the same thing more slowly. Worth revisiting; not worth bundling into
  this change.

**Two test cases changed meaning rather than being deleted**, because the state
they distinguished no longer exists:

- `front-page.test.tsx` asserted the SSO button appears only when OIDC is
  configured. Inverted to assert it never appears — the front page is where a
  reintroduced button would show up by accident.
- `chat-shell.interaction.test.tsx` asserted the locked screen offers sign-in
  only when enterprise access works. There is no longer a deployment where Chat
  is locked *and* signing in is impossible, so it now pins that the screen
  offers both doors.

**Still outstanding:** `docs/assets/orcasynapse-architecture.svg` still draws a
SIEM box. It is hand-maintained, no script generates it, and the brand gate does
not own it. The alt text was updated; the drawing was not.
