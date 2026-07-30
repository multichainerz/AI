# Phase 1 Operations Runbook

This runbook covers the locally implemented AIHub foundation. Production acceptance still requires MPM to exercise the signed installer, PostgreSQL, TLS, DNS, backup, and identity controls in the target environment.

## 1. Trust Anchors and Routine Configuration

Only three AIHub trust anchors remain outside the dashboard:

- the PostgreSQL connection string;
- the 32-byte AIHub credential-encryption key;
- the initial single-use installation claim (stored under the compatibility filename `aihub_bootstrap_token`).

Mount them as protected files as described in `deploy/BOOTSTRAP.md`. Endpoints, operational settings, model aliases, and connector credentials are entered in AIHub. Never place the credential-encryption key in the database backup that it protects.

The installation claim is short lived, consumed atomically, and never a reusable API credential. AIHub exchanges it once for a random opaque administrator session. The browser receives that session in an `HttpOnly`, `SameSite=Strict` cookie. Sessions have a 15-minute idle timeout, an eight-hour absolute timeout, server-side revocation, and no reusable identity or role information in the cookie value.

## 2. Foundation Roles

| Role | Intended foundation access |
|---|---|
| `PLATFORM_ADMIN` | All foundation connection, operations, audit, and session scopes |
| `SECURITY_ADMIN` | Non-identity connection configuration/testing, security controls, audit, and session administration |
| `OPERATIONS_ADMIN` | Read/test connections and inspect/execute job operations |
| `AUDITOR` | Read-only connections, operations, and audit access |

Enterprise OIDC creation, modification, and revision rollback require `PLATFORM_ADMIN`. This separation prevents an administrator who manages ordinary service connections from mapping their own identity-provider group into the Platform Administrator role.

The installation-claim session is a `PLATFORM_ADMIN`. Enterprise OIDC configuration maps separate platform, security, operations, and auditor groups into these roles before claim-derived administration is retired. API routes enforce scopes independently of whether a session is otherwise valid.

## 3. Deployment Order

The Compose definition encodes the required start order:

1. PostgreSQL becomes healthy.
2. Committed Prisma migrations are applied.
3. The `aihub_jobs` schema and pg-boss migrations are applied.
4. API and worker services start.
5. The web service starts after API health succeeds.

The signed installer preserves the declared dependency order and internal networks. Terminate TLS at an approved reverse proxy and forward `X-Forwarded-Proto`. AIHub marks the administrator cookie `Secure` when the original request protocol is HTTPS. Do not expose the API, worker, or PostgreSQL services directly to user networks.

## 4. Initial Verification

After deployment:

1. Confirm `/healthz` returns HTTP 200 through the approved ingress as a process-liveness check.
2. Confirm `/readyz` returns HTTP 200 after migrations and PostgreSQL are ready.
3. Confirm `/api/v1/platform` reports `bootstrapState: "READY"`.
4. Claim AIHub once with the installer-issued claim over HTTPS.
5. Configure one non-production service connection and run its sanitized health test.
6. Open Operations and confirm every required queue says it is configured.
7. Confirm at least one worker is `ONLINE`, then run a system probe.
8. Sign out and verify the prior session can no longer call an administrator endpoint.

A missing queue or absence of a current worker heartbeat puts Operations into `DEGRADED`; missing queues are not reported as empty healthy queues.

## 5. Configuration Revisions and Rollback

Every connection create, update, and rollback appends an immutable configuration revision. Rollback uses the expected active revision as an optimistic concurrency guard; a concurrent edit returns HTTP 409 instead of overwriting it.

Rollback restores only validated non-secret settings and creates a new active revision. It never reactivates an older credential. Current active credential fields are preserved and reported in the rollback response. Rotate or remove credentials through a normal connection update.

Before rollback:

1. identify why the current configuration is unsuitable;
2. review the target revision and current credential fields;
3. confirm no other administrator is editing the connection;
4. restore the revision through the two-step dashboard confirmation;
5. rerun the connection test before depending on the route.

## 6. Job Recovery and Retention

Dead-letter redrive requires a separate dashboard confirmation. Resolve the underlying cause before redriving; the action may return up to the requested bounded number of jobs to their original queues.

The API shows worker history from the last 24 hours and removes worker records older than 30 days when job operations start. pg-boss queue-stat retention is 14 days. These controls cover operational records only; audit-event retention must be set by MPM policy before production.

## 7. PostgreSQL Backup Drill

The PostgreSQL backup must include both the application tables and the `aihub_jobs` schema. Run the drill against the exact production PostgreSQL major version and approved backup destination.

Example logical backup from the local Compose stack:

```bash
docker compose exec -T postgres pg_dump -U aihub -d aihub --format=custom --no-owner --no-acl > aihub.dump
```

Store the dump encrypted in the approved backup system. Back up the credential-encryption key separately under dual control. Record the application release, migration version, PostgreSQL version, backup checksum, time, owner, and retention expiry.

Restore drill:

1. create an isolated recovery PostgreSQL instance with no production ingress;
2. restore the custom dump with `pg_restore --no-owner --no-acl` into an empty `aihub` database;
3. mount a recovery copy of the matching credential-encryption key;
4. start the same AIHub release without exposing it to users;
5. verify Prisma migrations, connection summaries, revision history, audit events, queue schema, and encrypted credential decryption through a connection test to a safe test endpoint;
6. verify expired/revoked administrator sessions do not become usable;
7. destroy the isolated recovery environment according to MPM procedure.

Do not treat a successful `pg_dump` as recovery proof. Phase 1 acceptance requires a completed restore drill with MPM-approved RPO/RTO evidence.

## 8. Security and Incident Actions

- Suspected bootstrap-token exposure: replace the mounted token, restart the API, and revoke active administrator sessions. Token rotation tooling remains an enterprise-identity transition task.
- Suspected session exposure: sign out or revoke the server-side record. The session expires after 15 minutes idle or eight hours absolute.
- Suspected connector credential exposure: rotate the credential at its source, then enter the replacement in AIHub. Old encrypted records stay retired and are never returned to the browser.
- Suspected credential-encryption-key exposure: stop administrative changes, preserve audit evidence, rotate connector credentials, and follow the credential-key recovery plan. Automated credential re-encryption is not yet implemented.
- Queue incident: preserve job/audit evidence, resolve the dependency failure, then use bounded retry or confirmed dead-letter redrive.

Until a security-administration page is added, an approved database administrator can revoke all sessions during an incident with the following narrowly scoped statement:

```sql
UPDATE "AdministratorSession"
SET "revokedAt" = CURRENT_TIMESTAMP
WHERE "revokedAt" IS NULL;
```

Record this intervention in the incident log. Administrator-session records older than 30 days past absolute expiry are removed when a new bootstrap session is issued; audit events remain independent.

## 9. External Acceptance Gates

The following cannot be proven from this workstation and remain required before Phase 1 is accepted:

- signed-installer deployment, upgrade, rollback, and restart behavior;
- TLS, internal DNS, proxy headers, network segmentation, and firewall rules;
- live PostgreSQL/Prisma and pg-boss migration execution;
- backup restore against MPM's approved destination and RPO/RTO;
- real LiteLLM, vLLM, Supermemory, OCR, MCP, and OIDC diagnostics;
- private-CA/certificate lifecycle requirements;
- enterprise OIDC group-to-role mapping and bootstrap-token retirement;
- security, dependency, and operational-owner approval.
