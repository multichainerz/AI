# Current State Handoff — v4.6.0

## Product state

This release is the greenfield Hermes-native baseline. OrcaSynapse controls identity, profiles, inference routes, prompts, guardrails, native toolset admission, evaluations, incidents, operational projections, and audit. Hermes alone owns session context and built-in memory on VM2.

The earlier product generation is preserved on the `backup/pgvector` branch. Do not merge that branch into this schema generation.

## Repository map

| Path | Responsibility |
| --- | --- |
| `apps/web` | operator workspace: Dashboard, Session, Agents, Platform, Operations |
| `apps/api` | authenticated control-plane API, enrollment, inference gateway, audit |
| `apps/worker` | run claiming, Hermes-native execution, lifecycle projection, SIEM forwarding |
| `packages/contracts` | shared API and runtime schemas |
| `packages/database` | Drizzle schema, greenfield migration, test database helpers |
| `packages/runtime-clients` | inference and Hermes-native session clients |
| `packages/security` | secret encryption and security primitives |
| `scripts/install-orcasynapse.sh` | VM1 installer |
| `scripts/install-agentic-node.sh` | VM2 Hermes installer/enroller/repair path |

## Invariants

1. A conversation UUID is the Hermes native session ID.
2. OrcaSynapse never supplies PostgreSQL transcript history as model context.
3. OrcaSynapse never reads or writes Hermes `MEMORY.md`, `USER.md`, or native session storage.
4. PostgreSQL holds sanitized execution evidence and the append-only audit trail.
5. Native toolsets are default-deny except built-in memory and explicit operator admissions.
6. The upstream inference credential remains on VM1.
7. VM2 has no database access or standing remote-administration channel.
8. Schema epoch `hermes-native-v1` is greenfield-only and rejects older populated databases.
9. Stock `postgres:17-bookworm` is the only database image required.

## Install and recovery

- Use clean VM1 and VM2 hosts for `v4.6.0`.
- Re-running an interrupted installer is supported when its protected completion or enrollment state is intact.
- Do not point this release at an older OrcaSynapse database; the migrator refuses it before mutation.
- Back up VM1 PostgreSQL for control/audit state and VM2's Hermes state root for native sessions and memory.
- A clean VM2 replacement without restored Hermes state intentionally starts with no prior native context.

## Verification

```bash
pnpm install
pnpm verify
pnpm security:audit
bash scripts/sync-installer-ui.sh --check
bash scripts/test-release-consistency.sh
bash scripts/test-docker-build-closure.sh
```

For the live migration proof, run stock PostgreSQL 17 and export the integration URL:

```bash
docker run -d --name orca-base -p 15432:5432 \
  -e POSTGRES_USER=orca -e POSTGRES_PASSWORD=orca -e POSTGRES_DB=postgres \
  postgres:17-bookworm
export ORCASYNAPSE_INTEGRATION_DATABASE_URL=postgresql://orca:orca@127.0.0.1:15432/postgres
pnpm verify:postgres
```

The integration proof applies the production migrator twice, verifies the epoch/default profile, and asserts that retired vector and state-duplication structures are absent.

## Known limitations

- Active native turns are attached to the worker process; worker loss can interrupt the control-plane projection even though Hermes retains the transcript.
- Vanilla Hermes file-backed memory is shared within its active home/profile. The current installation is one trust boundary, not per-user memory isolation.
- Native tool execution occurs inside Hermes; OrcaSynapse governs toolset admission and audits safe lifecycle metadata rather than intercepting every tool payload.
- Full dependency reproducibility for the native Hermes installer requires customer-controlled mirrors beyond the pinned Hermes commit.
