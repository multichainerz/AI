# Divisions, tool sets and skill sets — simple design

Status: **plan, awaiting approval.** Nothing here is implemented.

Written at v5.5.0; **recalibrated against v6.0.1**. Every citation below was
re-checked against the tree rather than assumed: the 27 `AdminScope`s, the five
tables this extends, the nine files it touches, the seeded profile's empty
`skills`, and all three preconditions — which are all still open. What moved in
the eleven releases between is recorded inline where it matters, and none of it
changes the increments, their order, or the estimate.

The shape: a super admin saves a named **tool set** in the Tools tab and a named
**skill set** in the Skills tab. A **profile** takes one of each plus its own
system prompt. A **division** is assigned a profile. Users of that division start
sessions with it. One VM2 throughout.

Vocabulary note: a *Hermes toolset* is the runtime's own unit (what
`RuntimeToolsetAdmission` admits deployment-wide). A **tool set** here is a named
selection of those, saved for reuse. The two words are close; the schema keeps
them apart.

## What is enforced, and what is described

Stated once, because the product should not imply more than it does.

| | Mechanism |
| --- | --- |
| Which profiles a user can see and run | **Enforced in code** — a division predicate |
| Which Hermes toolsets a run may enable | **Enforced in code** — the run payload takes `admittedToolsets`, so the worker hands over the profile's set and nothing more |
| Which skills a run uses | **Described, not enforced** — the runtime reports its skills but the run payload has no skills field, so nothing selects them per session |
| How the agent behaves within that boundary | **Described** by the system prompt — its remit, tone, what to decline |
| Memory (`MEMORY.md`, `USER.md`) | **Not isolated between divisions on one node** — one home, and the `memory` toolset is always permitted. It *is* isolated between nodes; see below |

A skill set is therefore a declaration the prompt can name: *"you work from the
Finance skill set"*. That is useful and honest. It does not stop another skill
being loadable by the same runtime.

`docs/ARCHITECTURE.md:75` already records the memory position ("one trust
boundary, not per-user memory isolation"), and
`apps/web/src/connection-definitions.test.ts:31` asserts the product makes no
tenant-isolation claim. Both remain true here.

### Memory is bounded by the node, not by Hermes

Worth stating precisely, because it changes what the upgrade path is.

`HermesCorpusEntry` is unique on **`(nodeId, path)`**
(`packages/database/src/drizzle/schema.ts`), and `HERMES_HOME` is a fixed
`Environment=` line in the runtime unit — one home per node, set at install.
`memories/MEMORY.md` and `memories/USER.md` are the only two paths the reconciler
will carry, and the reconciler resolves a write to one of two targets.

So the reason divisions share memory is not that Hermes cannot separate it. It is
that they share **a node**. The corpus is already keyed by node, which means:

- **This plan's one-VM2 scope is a choice, not a constraint.** Nothing here has
  to be built differently to allow otherwise.
- **A second VM2 gives a division genuinely separate memory today**, with no
  schema or code change, because a second node is a second key.

That makes the honest sentence for the Skills and Memory screens sharper than
"shared by every division": they are shared by every division *on this node*. If
a division ever needs real memory separation, the answer is to enrol a node for
it — not to build isolation inside one.

## The precondition

Assigning a profile to a division means nothing until three holes are closed.
All are on `main` today, independent of tenancy:

1. `listProfiles(_principal, …)` ignores its principal — every signed-in user
   sees every ACTIVE profile.
2. `submitRun` performs no caller-vs-profile check — any authenticated user can
   post any active profile's UUID and get a run with that profile's prompt and
   tool set.
3. `activeProfile(undefined)` returns whichever profile was edited most recently.

Without these closed, a user names another division's profile and gets it. That
is why increment A is first: it is what makes "assigned" mean anything.

## Schema

Generated migrations only, additive, forward-only. The `hermes-native-v1` epoch
does not change.

The tree has moved from five migrations to seven since this was written —
`0005` added `PlatformUpdateAgent` and `PlatformUpdateRun`, `0006` added
`HermesRuntimeNode.units` — so this work starts at `0007`. Neither touches a
table named here and neither changes the epoch, so nothing below is affected;
the number is recorded only so the first `pnpm db:generate` is not a surprise.

```
ToolSet                          SkillSet
  id, slug, displayName            id, slug, displayName
  description, status              description, status
  toolsetNames  text[]             skills  jsonb   -- name@version+digest
  revision, createdBy              revision, createdBy
  createdAt, updatedAt             createdAt, updatedAt

Division
  id, slug, displayName, description,
  status (ACTIVE|SUSPENDED), revision, createdBy, createdAt, updatedAt
```

Columns added:

- `AgentProfileVersion.toolSetId` / `.skillSetId` — FKs, on the **version**, not
  the profile, because a version is immutable and a run must reproduce exactly
  what it was given. `ON DELETE RESTRICT`.
- `AgentProfile.divisionId` — nullable FK, `ON DELETE RESTRICT`
- `EnterpriseUser.divisionId`, `LocalAdministrator.divisionId` — nullable FKs

**Null division means deployment-wide**, which is what every existing row already
is, so the migration is a no-op and nothing is re-homed until a super admin
deliberately assigns something.

**"At least one of each" needs a seed.** The migration that seeds the default
profile sets `skills: []`, so making the sets required outright would break it.
The migration creates a `Default tool set` (every currently admitted toolset) and
a `Default skill set` (empty, marked as such) and points the seeded profile at
them. New profiles must choose both; existing ones are already valid.

**No division column on** `ChatConversation`, `ChatMessage`, `AgentRun` (already
`ownerSubject`-scoped, strictly tighter), the corpus tables, `AuditEvent`, or any
singleton control row.

**One division per user** — a single nullable FK, not a join table.

## Scope model

Division is not a scope: scopes say what kind of action, division says over which
rows. The 27 `AdminScope`s and the two-literal enterprise tuple are unchanged.
Principals gain `divisionId: string | null`, where **null on an administrator
means super administrator**. No new role.

## Increments

### A — close the profile-selection holes
*No schema. Ships alone.*

Thread the principal through `listProfiles`; add one
`assertProfileVisibleTo(principal, profileId)` used by `submitRun` and by
conversation `create`; make `activeProfile` require an explicit id. With no
divisions defined it admits everything, so behaviour is unchanged — the seam
exists.

Files: `apps/api/src/agents/{agent-manager,drizzle-agent-manager}.ts`,
`apps/api/src/chat/{chat-manager,drizzle-chat-manager}.ts`.

**Done when:** `submitRun` against an invisible profile returns 404 (not 403 —
existence is information); `activeProfile` with no id throws instead of guessing;
deleting the predicate fails a test. **1–2 days.**

### B — tool sets and skill sets
*The missing "set" concept, saved where the owner expects to save it.*

- `ToolSet` and `SkillSet` tables, contracts, and managers with the
  `expectedRevision` + audit-event pattern.
- **Tools tab** gains "Save as tool set": name a selection of admitted Hermes
  toolsets, list existing sets, edit and delete. Deleting a set a profile
  references is refused with a 409 naming the profile.
- **Skills tab** gains the same for skills.
- A set's `status` allows retiring one without deleting it.

Files: `packages/database/src/drizzle/schema.ts` + migration,
`packages/contracts/src/{toolsets,skillsets}.ts`, `apps/api/src/toolsets/*`,
`apps/web/src/{tooling-view,corpus-view}.tsx`, `apps/web/src/api.ts`.

**Done when:** a set can be created, edited, listed and retired; deleting a
referenced set is refused; the Tools tab still shows deployment-wide admission
separately from set membership, because they are different decisions.
**3–4 days.**

### C — profiles take a set, and the worker enforces the tool set
*Where the tool set stops being a label.*

- `AgentProfileVersion` gains both FKs; the profile editor requires each on
  create; changing either mints a new version, as every configuration change
  already does.
- **The worker intersects**: `deployment-admitted ∩ profile's tool set`, and
  passes the result to `hermes.start`. Computed in the worker because it is the
  last hop before the runtime.
- The skill set is carried into the profile and surfaced to the prompt author; it
  is not sent to Hermes, because there is nowhere to send it.

Files: `packages/contracts/src/agents.ts`, `packages/database/.../schema.ts` +
migration, `apps/api/src/agents/drizzle-agent-manager.ts`,
`apps/worker/src/agent-processor.ts`, `apps/web/src/agents-view.tsx`.

**Done when:** a profile whose tool set is `["memory"]` produces a `hermes.start`
call whose `admittedToolsets` is exactly `["memory"]` even with five admitted
deployment-wide; removing a toolset from the set changes the next run's payload;
the intersection is asserted on the call arguments, not on a model reply.
**3–4 days.**

### D — divisions, assignment, and the one predicate

- `Division` table, contract, manager and routes at `/api/v1/admin/divisions`,
  reads behind `agents:read`, writes behind `agents:manage`, sessions resolved
  only through `requireAdmin`.
- Principals gain `divisionId`, read in both session managers.
- **One visibility rule, one function, one place:** a profile is visible iff
  `profile.divisionId === null || profile.divisionId === principal.divisionId ||
  principal.divisionId === null && principal is an administrator`. Applied at the
  seam increment A created, and to the admin `includeAll` run reads.

**Done when:** a user in Division A cannot list, name, converse with, or submit a
run against Division B's profile — four tests, each 404. A super admin still sees
everything. A deployment-wide profile is visible from both. Every existing test
passes unchanged. **4–5 days.**

### E — the super admin's screens, and the honest statements

- New Settings tab **People**: create users, set or change a division,
  enable/disable. Divisions managed alongside. It becomes the sixth tab in that
  row — Setup, Models, Prompts, Guardrails, System — where "System" is what
  "Application" was renamed to at v5.7.0.
- Agents → Profiles: division selector plus the tool-set and skill-set pickers,
  and a division column in the list. The confirm dialog says that assigning a
  profile to a division removes it from everyone else.
- Skills and Memory screens carry a persistent note that they are shared by every
  division **on this node** — asserted by a test, so deleting it fails the build.
  The node wording is the accurate one; see the memory section above.

CSP: `style-src 'self'`, no inline styles. Any form this adds is a **centred
`Dialog`**, not the right-hand `Drawer` — the connection form moved off the edge
at v6.0.1 because a panel sliding in over the screen it serves covers the thing
it is explaining, and a new one should not reintroduce that.

**Done when:** a super admin creates a tool set, a skill set, a profile using
both, a division, and a user in it — and that user signs in and sees exactly that
profile. Driven end to end. **5–7 days**, plus the auth path below.

## Total

**16–22 days**, plus D1.

## The one open decision

**D1 — how does a super-admin-created user sign in?** `EnterpriseUser` is keyed
`(issuer, subject)` with `lastLoginAt NOT NULL`, so an administrator cannot
pre-create one.

- **Invite an OIDC identity** — make `lastLoginAt` nullable (null = invited,
  never signed in) and match the invitation in `completeLogin`. **~2–3 days**,
  reuses the complete OIDC path. Requires an identity provider.
- **Local users with passwords** — a `LocalUser` table mirroring
  `LocalAdministrator`; Argon2, lockout and forced rotation already exist.
  **~5–7 days**, works with no IdP, matches "the super admin creates the account"
  most directly. Cost: a third credential store to keep in lockstep with the
  forced-rotation gate.

No auth.js either way.

## Enforcement checklist

- [ ] `listProfiles` filters by the caller's division
- [ ] `submitRun` refuses a profile outside it — 404, not 403
- [ ] `activeProfile` requires an explicit id and checks it
- [ ] conversation `create` checks the profile before writing the row
- [ ] admin `includeAll` narrows to the admin's division when non-null
- [ ] the visibility rule exists once, in one function
- [ ] the worker intersects admitted toolsets with the profile's tool set
- [ ] a profile version's sets are immutable with the version
- [ ] deleting a referenced set is refused
- [ ] `hardenedInstructions` documents the boundary and never decides it
- [ ] scope sets unchanged
- [ ] no division column on the tables listed above
- [ ] every new route resolves its session through `requireAdmin`
- [ ] every mutation writes an audit event and takes `expectedRevision`
- [ ] Skills and Memory screens state they are deployment-wide

## Testing

Each enforcement point is a predicate whose removal is a one-line mutation; a
test surviving that deletion is vacuous. Three cautions:

1. **A leak is an absence.** Mutation only covers predicates someone remembered
   to write. Add an inventory test in the shape of `admin-session.gate.test.ts`:
   walk `apps/api/src`, find every query touching `agentProfile`, fail on one not
   in a known division-aware call site.
2. **Two identity paths double every case** — enterprise and
   `ADMINISTRATOR_PREVIEW`. A preview session with a null division walking a
   division-scoped route is where a real leak would hide.
3. **Assert the tool set at the seam** — the arguments passed to `hermes.start` —
   never against a model's reply. And do not write a test that appears to prove
   memory or skill isolation; assert the on-screen statement instead.
