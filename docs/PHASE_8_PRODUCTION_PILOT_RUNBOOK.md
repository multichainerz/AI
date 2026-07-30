# Phase 8 Production Pilot Runbook

## Purpose and truth boundary

This runbook turns production-pilot preparation into retained, reviewable evidence. It does not declare the system production-ready. Security testing, recovery demonstrations, infrastructure validation, training, pilot results, risk acceptance, and approvals must be performed by MPM in the target on-premises environment.

AIHub distinguishes two actors in every sign-off:

- **Approving authority**: the external MPM body that issued the decision.
- **Recorder**: the authenticated AIHub administrator who appended the authority, evidence reference, and rationale.

AIHub never treats the recorder as the approving authority. Approval records are append-only. Each record contains a server-generated snapshot of every readiness-control revision. Changing any control makes older approvals stale and removes them from the derived gate.

## Derived readiness gate

The seeded checklist covers security, infrastructure, recovery, operations, training, and business acceptance. A control may be:

- `NOT_STARTED`
- `IN_PROGRESS`
- `BLOCKED`
- `VERIFIED`
- `WAIVED`

Work in progress requires an owner. Blocked controls require an owner and note. Verified and waived controls require an owner, decision note, at least one immutable evidence reference, and a retained verification timestamp. A waiver is an explicit risk decision, not a successful test.

The overall result is:

- `NOT_READY` while a control is incomplete, an approval is missing, or an approval is stale;
- `REJECTED` when a latest external authority decision rejects the pilot;
- `READY` only when all controls are verified or waived and the latest Security, Infrastructure, Product, and Business decisions approve the exact current revision snapshot.

## Access model

| Role | Read | Update controls | Record external decision |
|---|---:|---:|---:|
| Platform administrator | Yes | Yes | Yes |
| Security administrator | Yes | Yes | Yes |
| Operations administrator | Yes | Yes | No |
| Auditor | Yes | No | No |

Every change writes an audit event. Control updates use an expected revision and reject stale browser submissions instead of silently overwriting a concurrent operator decision.

## Health and orchestration

- `GET /healthz` proves only that the API process can respond. It is suitable for liveness and restart decisions.
- `GET /readyz` requires the bootstrap state to be `READY` and executes a live PostgreSQL query. It returns HTTP 503 when traffic should not be routed to the API.
- The API container health check uses `/readyz`.
- The web container uses `/web-healthz`, which verifies Nginx independently.
- API responses include `X-Request-Id`; use it to correlate reverse-proxy, API, job, and incident evidence.
- API and worker processes handle `SIGTERM`/`SIGINT` and close database or queue resources before termination.

Do not configure the ingress liveness probe to use `/readyz`; a database outage should remove traffic and raise an incident, not create an uncontrolled restart loop. Use `/healthz` for liveness and `/readyz` for readiness.

## Local quality and dependency gates

Before producing a release candidate, run:

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm security:audit
```

`pnpm verify` executes type checking, all automated tests, production builds, and Prisma validation. `pnpm security:audit` rejects high or critical advisories in production JavaScript dependencies. MPM must additionally scan the built API, worker, web, PostgreSQL, Nginx, and document-conversion images with its approved image scanner and policy database. Record reports by immutable artifact or ticket reference rather than pasting sensitive reports into notes.

## Backup and recovery evidence

Define RPO, RTO, retention, encryption, custody, and recovery owners before the exercise. Perform restoration into an isolated recovery environment; never restore over the active pilot during a test.

### PostgreSQL

1. Capture a transactionally consistent custom-format backup using an approved credential source and encrypted destination.
2. Record database version, migration version, start/end time, size, checksum, and backup job identifier.
3. Restore into a newly created isolated database.
4. Run Prisma migration status, `pnpm db:validate`, representative record counts, and application smoke tests.
5. Confirm sessions, encrypted connection records, incidents, evaluation evidence, readiness evidence, tool ledgers, and audit events are present.
6. Measure achieved RPO/RTO and retain the report reference under `recovery-postgresql-restore`.

### SeaweedFS

Use the backup/snapshot method approved for the deployed SeaweedFS topology. Capture filer metadata and volume data as a coordinated set. After restoring to an isolated namespace, reconcile document artifact keys, sizes, and checksums against PostgreSQL. Missing objects, orphan objects, or generation mismatches fail the exercise. Retain the inventory and reconciliation report under `recovery-seaweedfs-restore`.

### Configuration vault and master key

PostgreSQL contains encrypted service configuration but cannot decrypt it without the separately held AIHub master key. Back up the database and key through distinct approved custody paths. The exercise must prove that an authorized recovery team can mount the recovered key as a protected file, start AIHub, decrypt configurations, and run sanitized credential-aware connection tests. Never copy the key into AIHub notes, logs, tickets, or evidence references.

## Failure, load, and capacity exercises

Test the representative pilot workload and record percentiles, error rates, saturation, queue delay, recovery time, and data integrity for:

- concurrent chat and Hermes requests at the approved RTX PRO 6000 capacity;
- LiteLLM/vLLM saturation and unavailable-model behavior;
- worker loss, heartbeat expiry, retry, and dead-letter recovery;
- OCR, SeaweedFS, Supermemory, Hermes, and identity-provider outages;
- PostgreSQL connection exhaustion, restart, and recovery;
- network partition, DNS failure, TLS expiry, and blocked egress;
- approval expiry, revocation, global kill switches, and stale evaluation evidence;
- large and adversarial document inputs within configured limits.

Do not mark `operations-capacity-failure-tests` verified from synthetic local unit tests. It needs reports from the deployed topology and approved pilot workload.

## Deployment validation

Before pilot traffic:

1. Apply all committed Prisma migrations through `20260730001500_prompt_templates` using the one-shot migration services.
2. Confirm Coolify health checks, restart policies, persistent volumes, internal-only data network, and service ordering.
3. Verify approved internal DNS names, TLS chain and expiry monitoring, proxy timeouts, streaming behavior, upload limits, and request-ID propagation.
4. Prove that PostgreSQL and infrastructure administration are unreachable from Hermes and untrusted user networks.
5. Verify outbound destinations against the MPM allowlist and confirm denied egress is logged.
6. Forward security, incident, evaluation, tool, approval, readiness, and authentication events to the SIEM and test retry/escalation.
7. Confirm backup jobs complete and a recent isolated restore exercise meets the declared RPO/RTO.

## Training and limited pilot

Train administrators, security reviewers, operations/support staff, document reviewers, and pilot users for their actual roles. Include safe use, data classification, document quarantine, agent/tool boundaries, incident escalation, kill switches, recovery, and evidence recording.

Define pilot population, duration, use cases, prohibited uses, success measures, stop conditions, data handling, support hours, and decision owners before launch. Retain findings and remediation owners under `business-pilot-measures`. Retain every waiver with risk, owner, mitigation, expiry, and authority under `business-residual-risk`.

## API surface

- `GET /api/v1/admin/operations/readiness`
- `PATCH /api/v1/admin/operations/readiness/controls/:controlKey`
- `POST /api/v1/admin/operations/readiness/approvals`

## Exit checklist

- All twelve controls are verified or formally waived with target-environment evidence.
- No current Security, Infrastructure, Product, or Business decision is missing, rejected, or stale.
- Backup and restoration are demonstrated, not merely configured.
- Load, soak, failure, and recovery results meet approved limits.
- Security and penetration findings are remediated or explicitly accepted.
- Monitoring, notifications, SIEM, support, maintenance, and escalation are operational.
- Training and limited-pilot measures are complete.
- Residual risks have owners, mitigations, expiry, and authorities.
- The AIHub derived gate reports `READY` only after the above evidence and decisions are recorded.
