# Current State Handoff — ai-v3.17.0

## Product state

This release is the greenfield Hermes-native baseline. OrcaSynapse controls identity, profiles, inference routes, prompts, guardrails, native toolset admission, corpus observability, evaluations, incidents, operational projections, and audit. Hermes alone owns session context and the canonical built-in memory and Skill files on VM2.

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
| `scripts/hermes-corpus-reconciler.py` | Signed, allowlisted VM2 corpus observation and native mutation adapter |

## Invariants

1. A conversation UUID is the Hermes native session ID.
2. OrcaSynapse never supplies PostgreSQL transcript history as model context.
3. VM2 is canonical for `MEMORY.md`, `USER.md`, Skills, bundles, provenance, and pending changes; VM1 holds only a signed bounded mirror for observability and revisions.
4. Corpus writes use signed commands, expected hashes, Hermes-native mutation APIs, and two-person approval for destructive operations. VM1 never mounts VM2 storage or opens a remote shell.
5. Native session databases remain opaque and are never mirrored or used to reconstruct model context.
6. PostgreSQL holds sanitized execution evidence, the non-authoritative corpus mirror, and the append-only audit trail.
7. Native toolsets are default-deny except built-in memory and explicit operator admissions.
8. The upstream inference credential remains on VM1.
9. VM2 has no database access or standing remote-administration channel.
10. Schema epoch `hermes-native-v1` is greenfield-only and rejects older populated databases.
11. Stock `postgres:17-bookworm` is the only database image required; corpus search is PostgreSQL lexical search, not pgvector or embeddings.

## Install and recovery

- Existing ai-v3.16.0 VM1 installations migrate in place; rerun the generated VM2 installer with `--repair` to install the corpus companion. Pre-v3.16 databases still require clean hosts.
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
- Corpus observation is eventually consistent on the one-minute VM2 timer. Sensitive, symlinked, binary, oversized, and non-allowlisted files are metadata-only or excluded by design.
- Native tool execution occurs inside Hermes; OrcaSynapse governs toolset admission and audits safe lifecycle metadata rather than intercepting every tool payload.
- Full dependency reproducibility for the native Hermes installer requires customer-controlled mirrors beyond the pinned Hermes commit.
