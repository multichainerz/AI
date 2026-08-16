# Current State Handoff

<!--
No version in the title. It said "v5.1.0" while the body below described the tab
strips as of v8.8.3, because a version in a heading is a bump surface that
nothing bumps: scripts/test-release-consistency.sh pins every surface it knows
about and does not know this file exists, and every paragraph here already names
the release it is talking about. An unenforced surface is what produced the
wrong number in the first place, so the number is gone rather than corrected.
-->

## Product state

This release is the greenfield Hermes-native baseline. OrcaSynapse controls identity, profiles, inference routes, prompts, guardrails, native toolset admission, corpus observability, incidents, operational projections, and audit. Hermes alone owns session context and the canonical built-in memory and Skill files on VM2.

`v4.9.0` also establishes the workspace presentation baseline. Shared
controls use source-owned shadcn conventions over Tailwind and the existing
OrcaSynapse semantic theme. Session, dashboard, authentication, agents,
settings, and operations now consume the same control geometry, focus states,
theme contract, and Lucide functional icon language. Domain-specific surfaces
remain product compositions rather than being forced into generic cards.

`v5.0.0` reorganises the workspace around the question each surface
answers. Setup is a three-step wizard — inference, agent runtime, Agent Profile
— with one step open at a time and every blocker stated inside the step it
blocks. Application updates have their own Settings tab.

`v5.1.0` settles the tab strips. **Agents is four tabs — Profiles, Skills,
Memory, Tools** — after Runtime folded back into Profiles, which now owns what
an agent is, what it is doing, and whether it may run at all; `#agents/runtime`
stays alive as a redirect. **Operations is two — Health and Audit trail** —
after Release gates went with the evaluation subsystem it governed and Pilot
readiness was deleted outright (below); `#operations/releases`,
`#operations/evaluations` and `#releases` redirect to Health.

The six areas and their tabs, in menu order, are: Dashboard; Session; Agents
(Profiles, Skills, Memory, Tools); Gateway (Models, Prompts, Guardrails);
Operations (Health, Audit trail); Settings (Setup, People, System).
`apps/web/src/workspace-navigation.tsx` is the source of truth, and
`workspace-navigation.test.ts` pins every one of those strips literally —
this paragraph said "Agents is five (Profiles, Runtime, Skills, Memory, Agent
Tools)" for a release because nothing did.

It then said "Settings (Setup, System)" for four releases for the same reason,
missing the Divisions tab added at v6.8.0 and the People tab added at v7.3.0 —
`workspace-navigation.test.ts` pins the strips and nothing pins this sentence
against them. **Divisions is not a tab.** At v8.8.3 it and People became one
screen: the people list, the divisions list, and a division-create dialog
reachable from inside the person form, because the two were always one job and
the split made an administrator retype a half-finished person to go and create
the division it needed. `#settings/divisions` and `#divisions` resolve to
People. The two panels are gated separately — people read on `sessions:manage`,
divisions on `agents:read` — so a role holding one and not the other draws the
panel it may see and a refusal in place of the other.

Pilot readiness is removed from the console. `ProductionReadinessControl` has
no create route and no seed, so that screen could never display a row; the
tables remain untouched. `POST /onboarding/complete` consequently has no client
surface, which changes nothing operationally — it already required a gate that
automated validation cannot satisfy on a PRODUCTION target.

Settings includes release awareness, not unattended self-update. VM1 checks
official stable tags through its API and can present a pinned installer command
for an administrator to run on the host. The browser and application container
cannot execute host updates. VM2 remains governed by its separately approved
Hermes commit and installer/repair flow.

The earlier product generation is preserved on the `backup/pgvector` branch. Do not merge that branch into this schema generation.

## Repository map

| Path | Responsibility |
| --- | --- |
| `apps/web` | operator workspace: Dashboard, Session, Agents, Gateway, Operations, Settings |
| `apps/web/src/components/ui` | canonical shadcn-style controls consumed across routes |
| `apps/web/DESIGN_SYSTEM.md` | web token, component, CSP, and accessibility contract |
| `apps/api` | authenticated control-plane API, enrollment, inference gateway, audit |
| `apps/api/src/platform-updates.ts` | stable release-tag comparison and pinned VM1 update guidance |
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
12. The dashboard may discover releases and copy a pinned installer command, but it never receives VM1 host-root or Docker control.
13. Route-level controls come from `apps/web/src/components/ui` or an OrcaSynapse composition built from them; production UI must remain compatible with the no-inline-style CSP.

## Install and recovery

- Any VM1 installation carrying the `hermes-native-v1` schema epoch updates in place, whichever release installed it. `install.sh` reads the literal marker at `.local/state/schema-epoch` and compares it to that string — no version is parsed or compared anywhere in the decision, so "v4.6.0 and v4.7.x" was an inaccurate proxy for the real gate. Rerun the current generated VM2 installer with `--repair` to install or replace the corpus companion. A pre-v4.6.0 database carries no marker and still requires a clean host.
- **Settings → System** can check official release tags and copy the version-pinned VM1 installer command. (`Application` is the routing token behind that tab, not its label; this line said "Settings → Application" while the tab row was Setup, People, System.) Running that command remains an explicit host-administrator action; it does not update VM2.
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
bash scripts/test-csp-closure.sh
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
- Automatic host update is intentionally unsupported. The workspace reports releases and produces a pinned command, while host execution and VM2 runtime changes remain explicit administrative operations.
