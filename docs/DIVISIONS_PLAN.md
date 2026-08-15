# Divisions, tool sets and skill sets — simple design

Status: **plan, awaiting approval.** Nothing here is implemented.

Written at v5.5.0; recalibrated at v6.0.1; **re-verified against v6.0.4**. Every
citation was re-checked against the tree rather than assumed. Most held: the 27
`AdminScope`s, the two-literal enterprise tuple, the seven migrations, the
`(nodeId, path)` unique index, `EnterpriseUser`'s `(issuer, subject)` key and
`NOT NULL lastLoginAt`, the five Settings tabs, both line-number citations, and
all three preconditions — still open, unchanged.

**Three did not hold.** The v6.0.1 pass checked that the *names* it cited
existed; it did not read what they do. Doing that found:

1. `admittedToolsets` is a drift **assertion**, not a control — so the planned
   per-profile intersection would have refused every narrowed profile rather
   than narrowing it. **Increment C is redesigned.**
2. A second node **stops every run deployment-wide** rather than giving a
   division its own memory. The node-per-division fallback is withdrawn.
3. There are **three tool words, not two**: `AgentToolGrant` already grants
   *governed* tools per profile version, with its own `allowedGroups`. Omitting
   it would have created a second, competing answer to "who may use this tool".

Each is recorded where it matters below, with the measurement. A, B, D and E
keep their scope, order and estimate; **increment F is now inside the plan and
inside the total** rather than a footnote, because the first two findings closed
every alternative route to scoped memory.

The lesson is recorded because it will recur: a citation that names a symbol
proves the symbol exists. It proves nothing about its behaviour, and this plan
had two mechanisms backwards for three releases on exactly that basis.

The shape: a super admin saves a named **tool set** in the Tools tab and a named
**skill set** in the Skills tab. A **profile** takes one of each plus its own
system prompt. A **division** is assigned a profile. Users of that division start
sessions with it. One VM2 throughout. Memory is shared across divisions until
increment F, which gives each one its own on a store we control.

## What exists today, and what this adds

Confirmed against the tree at v6.0.4, because the whole plan rests on it.

**There is no tool set and no skill set. Neither concept exists in any form** —
no `ToolSet` or `SkillSet` table, no `toolSetId` or `skillSetId` anywhere in the
schema or contracts. A profile cannot be given either, so a division cannot
inherit either. Creating them, and hanging them off the profile, is the substance
of increments B and C.

What a profile *does* carry today:

| On `AgentProfileVersion` | Today | After |
| --- | --- | --- |
| `skills jsonb` | a raw list, edited per profile, reusable nowhere | kept; a **skill set** names a reusable selection and the profile points at one |
| tools | **nothing for Hermes toolsets** — a profile cannot express them at all | `toolSetId` → a named **tool set** |
| `AgentToolGrant` rows | per-version grants of *governed* tools, with `allowedGroups`, `allowedAdminRoles`, `resourceScope` | unchanged — different plane, see below |
| division | nothing | `AgentProfile.divisionId` |

So the answer to "can a profile have a tool set and a skill set, so a division
and its members use that profile?" is: **not today, and that is exactly what this
plan builds.** A → the profile becomes reachable only by the right people;
B → the two set concepts come into existence; C → the profile points at one of
each; D → the profile is assigned to a division; E → a user in that division
signs in and gets it.

### Three tool words, not two

The earlier draft distinguished two and there are three. Missing the third would
have produced a second, competing answer to "who may use this tool".

1. **Hermes toolset** — the runtime's own native unit (`memory`, `clarify`).
   Admitted deployment-wide by `RuntimeToolsetAdmission`, enforced through the
   node's desired state. A profile has no say today.
2. **Governed tool** — an OrcaSynapse-implemented tool on the MCP plane
   (`GovernedTool`), granted **per profile version** by `AgentToolGrant`. This
   already exists and is already per-profile. `GovernedTool` has **no seeded
   rows**, so the plane is structurally complete and empty — which is why it
   reads as absent.
3. **Tool set** (new) — a named, reusable selection of *Hermes toolsets*.

**They do not compete, because they cover different planes**, and the plan keeps
it that way: a tool set names Hermes toolsets; `AgentToolGrant` continues to name
governed tools. A profile ends up with two tool surfaces, and they differ in the
way that matters — the Hermes one is declarative (see increment C), the governed
one is fully enforceable, because OrcaSynapse implements those tools itself and
therefore controls every call.

**One overlap must be settled deliberately.** `AgentToolGrant.allowedGroups` is
an existing principal restriction, and divisions are another. They compose rather
than replace: a **division decides which profiles you can reach**, a grant's
`allowedGroups` decides **which tools inside a profile you may call**. Neither is
re-expressed in terms of the other, and no division id is written into
`allowedGroups`. Recorded here because the tempting shortcut — reusing
`allowedGroups` to carry a division — would put the tenancy boundary in two
places, and the checklist forbids exactly that.

## What is enforced, and what is described

Stated once, because the product should not imply more than it does.

| | Mechanism |
| --- | --- |
| Which profiles a user can see and run | **Enforced in code** — a division predicate |
| Which Hermes toolsets a run may enable | **Enforced, but deployment-wide — not per run.** `admittedToolsets` on the run payload is a drift *assertion*, not a control. What a node may enable is its desired state, which cannot vary per profile. See increment C |
| Which skills a run uses | **Described, not enforced** — the runtime reports its skills but the run payload has no skills field, so nothing selects them per session |
| How the agent behaves within that boundary | **Described** by the system prompt — its remit, tone, what to decline |
| Memory (`MEMORY.md`, `USER.md`) | **Not isolated between divisions through A–E** — one home per node, and the `memory` toolset is always permitted (`hermes-client.ts:480` adds it unconditionally). Storage is keyed per node, but execution requires exactly one node, so that is no escape; see below |
| Memory in a store we own | **Enforced in code, at increment F** — a scoped local store whose filter lives in the tool, not the prompt. The only route to per-division memory that does not wait on upstream |

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
that they share **a node**, and the corpus is already keyed by node.

**But a second node cannot run today, and the earlier draft of this section said
it could.** Correcting it, because the whole fallback rested on it:

Two independent gates require *exactly one* enrolled node, and both count
`enrolledAt IS NOT NULL AND status <> 'REVOKED'`:

- `apps/api/src/agents/drizzle-agent-manager.ts:538` — `runtimeNodes.length !== 1`
  → *"Exactly one online, recently observed, and healthy Hermes runtime is
  required."*
- `apps/worker/src/agent-processor.ts:599` — *"Exactly one enrolled Hermes
  runtime is required."*

Enrolling a second VM2 therefore does not give a division separate memory. It
stops **every agent run deployment-wide**, for every division, until one node is
revoked. Suspending the old one does not help — `SUSPENDED` still counts.

Enrolment itself is already multi-node: desired state is per node, the corpus is
keyed by node, and the node manager is explicit that *"one node cannot read
another's desired state"*. It is **execution** that is deliberately single-node,
fail-closed. So the storage layer is ready and the run path is not.

What survives, and what does not:

- **One VM2 is a constraint on execution, not merely a choice.** True as before
  that nothing here must be built differently to *allow* a second node — the
  keys are right — but a second node needs run routing plus a decision to relax
  two intentional fail-closed gates. That is real work, not a deployment step.
- **"Enrol a node for that division" is not an available answer today.** It is
  the shape of the eventual answer.

The honest sentence for the Skills and Memory screens is unchanged and still the
accurate one: they are shared by every division *on this node*.

### Why the built-in store cannot be scoped, and where the seam actually is

Verified against the pinned commit `c015663b`, because this decides what is
possible rather than what is convenient.

`load_on_disk_store()` **takes no arguments**, and `MemoryStore.__init__` takes
only two character limits. The path is `get_hermes_home() / "memories"` with two
fixed filenames. There is no user, session, namespace or tenant parameter
anywhere in the built-in store, and Hermes' own docstring calls the directory
*"profile-scoped"* — profile meaning the home. `USER.md` is singular by design:
its header describes *"what the agent knows about **the user**"*, one human.

Hermes' gateway **does** carry a `user_id`, and its own test states the intent:
*"gateway user_id flows from AIAgent → MemoryManager → plugins, so each gateway
user gets their own memory bucket."* Note where that arrow stops. The identity
travels as far as **plugins** and is dropped before the file store.

So per-division memory has exactly two implementations **inside Hermes**:

1. **A home per division** — the boundary Hermes actually has. One home per
   node, so in practice a node per division, which the run path does not yet
   permit (see above).
2. **A memory provider that buckets per user** — real tenancy, at the cost below.

**Neither is reachable today**, for different reasons: the first waits on
multi-node execution here, the second on an upstream session identity. That is
the finding, not a preference between them — and it is what makes increment F,
which sits *outside* Hermes' own memory, the third route rather than a luxury.

The system prompt is not one of them. An agent that can call the memory tool
reads the whole file; the prompt is a request, not a control.

### The provider option, and why it does not rescue this

**Hindsight** (`vectorize-io/hindsight`, **MIT**) is the right provider for this
product if one is ever adopted: PostgreSQL with pgvector, self-hostable with no
egress, and a `bank_id` scoping key that *looks* like it maps one-to-one onto a
division. MIT is compatible with this repository's BSL 1.1. The alternative worth
knowing is Mem0 in OSS in-process mode — lighter, no service, harder to back up
or inspect.

Read the whole of this section before costing it. The scoping key is real and
the identity cannot reach it; that finding is at the end, and it reverses the
conclusion the first paragraph invites.

Two constraints on any adoption, both non-negotiable:

**Its PostgreSQL runs on VM2, never VM1's.** The control plane's database
publishes no port and sits on a `data` network marked `internal: true` — it is
unreachable from outside the compose project by design. Reaching it from VM2
would mean putting a SQL credential on the host that runs an LLM with tool
execution and loadable skills, against the database holding admin sessions,
sealed secret envelopes and the audit trail. VM2 makes signed HTTP calls and
nothing else; that is the whole reason it exists.

**It costs the observability guarantee until the mirroring is built.** Providers
are *additive* — the official documentation is explicit that "the built-in memory
continues to work exactly as before; the external provider is additive". The
corpus reconciler mirrors two allowlisted file paths and knows nothing about a
bank, so the moment a provider holds the real knowledge, Agents → Memory shows an
empty `MEMORY.md` while the agent remembers a great deal. That is a dashboard
that lies, which is worse than one that admits a limit.

**Therefore: not part of the five increments below.** Memory stays honestly
shared per node, which keeps everything this product claims. Hindsight becomes
the right call only once Hermes' session API carries an identity *and* the
number of divisions makes a node each absurd — and the project at that point is
*mirroring a bank into the corpus plane*, which is larger than everything in
this plan put together, not the install.

#### What it would actually cost to reach, verified

Three facts settle the shape, and two of them are about our code rather than
Hindsight's.

**1. Nothing new to provision for embeddings.** Hindsight's embedded daemon
"computes embeddings via `sentence_transformers`" — in-process, no endpoint. Mem0
by contrast declares embedder providers and dimensions
(`text-embedding-3-small` at 1536, `nomic-embed-text` at 768) and would need one
served. That is the second reason to prefer Hindsight here.

**2. Its LLM reuses a path that already exists.** The plugin offers an
`openai_compatible` provider, and VM2 is already handed
`inferenceGatewayBaseUrl(controlPlaneUrl)` — VM1's `/internal/v1` — with a
gateway key issued at enrolment. So the reflect step points at the same URL, key
and alias Hermes already uses. No new route, no new credential, and the calls
stay proxied through VM1 rather than a plugin opening its own channel to the
GPUs. Note the asymmetry with the paragraph above: VM1's *inference gateway* is
deliberately exposed to enrolled nodes; VM1's *database* is deliberately exposed
to nothing. "Point it at VM1" is right for one and disqualifying for the other.

**3. Hindsight's scoping is richer than a static field — and unreachable from
here.** This is the finding that decides the whole option, so it is recorded in
full.

Hindsight resolves its bank from a template, not a constant:

```
bank_id_template — "Optional template to derive bank_id dynamically.
Placeholders: {profile}, {workspace}, {platform}, {user}, {session}."
```

and populates them from provider state:

```python
self._bank_id = _resolve_bank_id_template(
    self._bank_id_template, fallback=static_bank_id,
    profile=self._agent_identity, workspace=self._agent_workspace,
    platform=self._platform, user=self._user_id, session=self._session_id,
)
```

The plumbing above it is real too. `MemoryManager.initialize_all(session_id,
**kwargs)` forwards its kwargs to every provider verbatim and injects
`hermes_home` — which is why grepping `memory_manager.py` for `user_id` finds
nothing while Hermes' own test still asserts the identity arrives. It travels
anonymously.

**But the identity cannot get in.** `user_id` appears exactly **once** in
`gateway/platforms/api_server.py`, as a column name in a `SELECT` list.
`_handle_create_session`, behind `POST /api/sessions`, does not read one from the
request body. `hermes_state.py` has the column and `create_session` takes the
parameter — the storage layer supports it; the HTTP surface does not expose it.

So at the pinned commit `c015663b`, a caller cannot tell Hermes who is asking.
Every session on a node resolves the same `{user}`, the same `{profile}`, the
same everything — and therefore the same bank.

**The consequence, stated plainly: Hindsight does not escape the home boundary.**
Adopting it on one node gives a better store with exactly the tenancy the files
have, which is none. Reaching per-division memory through a provider needs an
upstream change to Hermes' session API first — not a configuration, a change to
software we pin and do not own.

That is not a reason to avoid Hindsight forever. But note what it leaves:
a provider needs an upstream change to Hermes' session API, and a home per
division needs multi-node execution here. **Neither route to per-division memory
is open today** — one waits on software we do not own, the other on work not in
this plan. That is precisely why increment F exists, and why memory being
honestly shared per node is the position A–E ship with rather than a placeholder
for something nearly ready.

**When the API does carry an identity, send the division, not the user.**
Per-user buckets are finer than this plan wants: a division's agent should
accumulate knowledge its whole division benefits from, and per-user memory would
give each person a private agent that learns nothing from its colleagues — a
different product. `{user}` would be populated with a division id;
`ownerSubject` is the wrong key even though it is the one already to hand.

## The precondition

Assigning a profile to a division means nothing until three holes are closed.
All are on `main` today, independent of tenancy:

Re-verified at v6.0.4, with the line each is on so the claim stays checkable:

1. `listProfiles(_principal, …)` ignores its principal — every signed-in user
   sees every ACTIVE profile.
   `apps/api/src/agents/drizzle-agent-manager.ts:318`, still `_principal`.
2. `submitRun` performs no caller-vs-profile check — any authenticated user can
   post any active profile's UUID and get a run with that profile's prompt and
   tools. `apps/api/src/agents/drizzle-agent-manager.ts:499`: the principal is
   read only for `ownerSubject`, `requestedBy` and the audit event; the profile
   is selected by `eq(agentProfile.id, input.profileId)` and nothing else.
3. `activeProfile(undefined)` returns whichever profile was edited most recently.
   `apps/api/src/chat/drizzle-chat-manager.ts:1197`: with no id the `eq` is
   omitted entirely and it falls through to `orderBy(desc(updatedAt)).limit(1)`.

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
- `EnterpriseUser.divisionId` — nullable FK. **No column on `LocalAdministrator`**:
  administrators are deployment-wide, see the scope model

**Null division means deployment-wide**, which is what every existing row already
is, so the migration is a no-op and nothing is re-homed until a super admin
deliberately assigns something.

**"At least one of each" needs a seed, and the seed is not where this said.**
There is no SQL migration seeding a profile — the only `INSERT` in the seven
migrations is the schema epoch. The default profile is seeded in code by
`seedDefaultAgentProfile()` in `packages/database/src/drizzle/migrate.ts`, and
that matters three ways:

- It is `ON CONFLICT DO NOTHING` on both rows, so on any existing deployment the
  seeded profile **already exists and will never be updated**. Changing the seed
  reaches new installs only; pointing the existing row at the default sets needs
  an explicit backfill `UPDATE` in migration `0007`.
- Its version row is stamped with `defaultAgentProfileDigest()`, a SHA-256 over a
  canonical subset of `DEFAULT_AGENT_PROFILE`. Adding the two FKs to that subset
  changes the digest, and `packages/database/src/default-agent-profile.test.ts`
  asserts its shape — so that test is part of this work, not collateral.
- `DEFAULT_AGENT_PROFILE.skills` is `[]` (`packages/contracts/src/agents.ts:362`),
  which is the original point and still stands: making the sets required outright
  would break the seed.

So: migration `0007` creates a `Default tool set` (every currently admitted
toolset) and a `Default skill set` (empty, marked as such), **and backfills every
existing profile version** to reference them. New profiles must choose both;
existing ones become valid by backfill rather than by luck.

**No division column on** `ChatConversation`, `ChatMessage`, `AgentRun` (already
`ownerSubject`-scoped, strictly tighter), the corpus tables, `AuditEvent`, or any
singleton control row.

**One division per user** — a single nullable FK, not a join table.

## Scope model

Division is not a scope: scopes say what kind of action, division says over which
rows. The 27 `AdminScope`s and the two-literal enterprise tuple are unchanged.
No new role.

**Divisions are data, not an enum.** A super admin creates them at runtime with
any name — `Division` is an ordinary row with `slug`, `displayName` and
`description`, and `createdBy` records who added it. There is no fixed list
anywhere in the code, nothing to deploy per division, and no ceiling on how many.
Any examples in this document are illustrations, not a taxonomy.

That is a direct consequence of the sentence above: because a division adds no
scope and no role, adding one is a row insert rather than a code change. Had
divisions been modelled as scopes — the obvious-looking alternative — every new
division would have meant editing `ADMIN_SCOPES`, a release, and an upgrade of
every deployment. The separation is what buys the freedom.

**A note on the word "tenant."** A division bounds *which profiles a user can
reach*. Through A–E it is not an isolation boundary: agents still share memory
per node, and `apps/web/src/connection-definitions.test.ts:31` asserts the
product makes no tenant-isolation claim. Calling a division a tenant is accurate
about access and overclaims about isolation until increment F ships. The screens
should keep saying division.

**Divisions apply to users, not to administrators.** An administrator is
deployment-wide, sees everything and manages everything; a division bounds which
profiles a *user* may see and run. `EnterpriseUser.divisionId` is the field that
matters; `LocalAdministrator.divisionId` is not added at all.

This is a deliberate simplification, and it earns three things:

- **Every administration screen is super-admin by construction.** There is no
  division-scoped admin to accidentally show a cross-division page to. That
  matters most for Agents → Memory and Agents → Skills, which are shared per node
  and therefore *cannot* be filtered — a division-scoped admin opening them would
  read what every other division's agent had learned. A leak through the
  dashboard rather than through the agent, and this removes the possibility
  rather than guarding it.
- **The visibility rule loses a clause.** It becomes "the caller is an
  administrator, or the profile's division matches the caller's" — see D.
- **A whole test hazard disappears.** The testing section's second caution was
  about a preview session with a null division walking a division-scoped route.
  With administrators uniformly deployment-wide there is no such combination.

It also matches the original ask: the super admin created at install manages
everything, because this is on-premise. If a customer later needs a delegated
administrator bounded to one division, that is a real feature with its own
design — including what to do about the screens that cannot be filtered — and it
should not be half-built here by leaving a nullable column lying around.

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
- **Skills tab** gains the same for skills. Note what this replaces: today
  `AgentProfileVersion.skills` is a raw list retyped per profile and reusable
  nowhere. The column stays; the set is what makes a selection nameable and
  shareable between profiles.
- A set's `status` allows retiring one without deleting it.
- **`AgentToolGrant` and `GovernedTool` are not touched.** They are the other
  plane (see above). A tool set names Hermes toolsets only, and no migration
  here writes to a grant.

Files: `packages/database/src/drizzle/schema.ts` + migration,
`packages/contracts/src/{toolsets,skillsets}.ts`, `apps/api/src/toolsets/*`,
`apps/web/src/{tooling-view,corpus-view}.tsx`, `apps/web/src/api.ts`.

**Done when:** a set can be created, edited, listed and retired; deleting a
referenced set is refused; the Tools tab still shows deployment-wide admission
separately from set membership, because they are different decisions.
**3–4 days.**

### C — profiles take a set
*Rewritten at v6.0.4. The previous version of this increment would not have
worked, and would have failed in the worst way: by refusing runs.*

**What was wrong.** This said the worker should intersect
`deployment-admitted ∩ profile's tool set` and pass the result to `hermes.start`,
"so the worker hands over the profile's set and nothing more". Reading the call
path shows `admittedToolsets` is not a control at all:

```
start(input)
  → assertAdmittedToolBoundaryFor(connection, input.admittedToolsets ?? [])
  → startNativeSession(connection, input)   // sends sessionId + modelAlias only
```

`assertAdmittedToolBoundaryFor` (`packages/runtime-clients/src/hermes-client.ts:471`)
fetches the runtime's enabled toolsets and **throws** if any of them is outside
the set it was handed. It never disables anything. So passing a strict subset
does not narrow the agent — it aborts the run with *"Hermes has enabled toolsets
this installation has not admitted"*. Under the old Done-when — a profile set of
`["memory"]` against five admitted deployment-wide — **every run of that profile
would fail**, and it would look like runtime drift rather than a design error.

What actually decides a node's tools is its desired state:
`drizzle-runtime-node-manager.ts:914` emits `admittedToolsets` from
`RuntimeToolsetAdmission`, and the installer subtracts the rest via
`agent.disabled_toolsets`. That is **per node and deployment-wide**, reconciled
on a timer — it cannot vary per run, and nothing in the run path can make it.

**So the tool set is declarative at profile granularity.** Stated in the table at
the top, and stated in the editor where the choice is made. What remains is still
worth building:

- `AgentProfileVersion` gains both FKs; the editor requires each on create;
  changing either mints a new version, as every configuration change already
  does. This is real: the set becomes immutable with the version, reproducible on
  re-run, and auditable — which is what a governed configuration needs.
- **The worker passes the intersection as the declared set and must not narrow
  the boundary assertion below the node's enabled set.** These are the same
  value only when the profile's set is not a strict subset; where they differ,
  the assertion keeps the deployment-wide input. Get this backwards and the
  symptom is a false drift error.
- The editor flags when a profile's set is narrower than deployment admission,
  because that gap is exactly the part that does not bind.
- The skill set is carried into the profile and surfaced to the prompt author; it
  is not sent to Hermes, because there is nowhere to send it.
- **The governed-tool plane keeps its own enforcement.** `AgentToolGrant` already
  hangs off `AgentProfileVersion` and already binds — OrcaSynapse implements
  those tools, so nothing is delegated to a runtime that might ignore it. The
  asymmetry is worth stating on the screen: a profile's *governed* tools are
  enforced per profile; its *Hermes* toolsets are declared per profile and
  enforced deployment-wide. Two surfaces, two strengths, one editor.

**The two routes to making it bind**, both outside this increment: an upstream
per-session toolset field in Hermes' session API — the same missing hook as the
memory identity, which is not a coincidence; or one node per tool set, which
needs the multi-node execution work described above.

Files: `packages/contracts/src/agents.ts`, `packages/database/.../schema.ts` +
migration, `apps/api/src/agents/drizzle-agent-manager.ts`,
`apps/worker/src/agent-processor.ts`, `apps/web/src/agents-view.tsx`.

**Done when:** a profile's tool set is stored on its version and reproduced
byte-for-byte on re-run; **a profile whose set is a strict subset of deployment
admission still runs** — the regression test for the mistake above, and the one
that must be written first; a run against a node with a genuinely unadmitted
toolset enabled is still refused; the editor states the limit. **3–4 days** —
unchanged, the enforcement work is replaced by the labelling and these tests.

### D — divisions, assignment, and the one predicate

- `Division` table, contract, manager and routes at `/api/v1/admin/divisions`,
  reads behind `agents:read`, writes behind `agents:manage`, sessions resolved
  only through `requireAdmin`.
- Principals gain `divisionId`, read in both session managers.
- **One visibility rule, one function, one place:** a profile is visible iff
  `principal is an administrator || profile.divisionId === null ||
  profile.divisionId === principal.divisionId`. Applied at the seam increment A
  created. Two clauses rather than three, because administrators are
  deployment-wide — see the scope model above — so the admin `includeAll` reads
  need no narrowing at all.

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
`Dialog`**, not the right-hand `Drawer` — Setup's panels moved off the edge
across v6.0.1 (connection form) and v6.0.3 (installer generator), because a
panel sliding in over the screen it serves covers the thing it is explaining.
v6.0.4 then rewrote that dialog's reading order. A new form should inherit the
result, not reintroduce the drawer.

**Done when:** a super admin creates a tool set, a skill set, a profile using
both, a division, and a user in it — and that user signs in and sees exactly that
profile. Driven end to end. **5–7 days**, plus the auth path below.

### F — scoped memory, on a local store we own
*In the plan. Sequenced last, because A–E must land first — a division-scoped
memory is meaningless until divisions exist and bound who reaches a profile.*

**Included rather than parked, and the re-verification is why.** Both
alternatives are now known to be closed: a memory provider waits on Hermes
growing a session identity, and a home per division waits on multi-node
execution here. F waits on neither — **it is the only route to per-division
memory this repository can open by itself.** So it is the increment that can
carry a date, and it is costed in the total below rather than left as a footnote.

A–E remain shippable without it. If F is deferred, the honest position is the one
those increments already state on screen: memory is shared by every division on
this node. Deferring is a decision to keep saying that.

The rule that makes it work, and the only thing separating it from a bad idea:

> **The tool filters. The prompt never does.**

An agent given SQL access and a prompt saying "only your division's rows" has a
request, not a boundary — one injection or one broader `WHERE` reads everything.
Worse, a table with division columns *looks* like tenancy and will therefore be
trusted with things `MEMORY.md` never was. An honest shared file beats a
database that appears private and is not.

So the agent gets `remember(text)` and `recall(query)` and **no division
parameter at all**. The scope is injected by the implementation. There is
nothing for the agent to get wrong, and nothing to talk it out of.

Non-determinism about *what* to remember stays exactly as it is — that is what
memory is, and the agent already decides it for `MEMORY.md`. What stops being
non-deterministic is who can read it.

- **SQLite, one file per Hermes process**, beside the runtime and owned by the
  service account. Not PostgreSQL: this is a keyed local store for small records
  with one writer, which is SQLite's ideal profile rather than its edge, and a
  Postgres would be a service to run, patch and back up for three columns. It is
  also strictly an upgrade on the flat file it supplements — atomicity, crash
  safety, a schema and a `WHERE` clause where today there are none. **One file
  per process is a hard constraint**: two Hermes processes sharing one SQLite is
  where this goes wrong.
- **The scope arrives as a credential, not an instruction.** Hermes' session API
  carries no identity (see above), but OrcaSynapse composes the system prompt per
  profile and profiles are per division, so the prompt can carry a scoped token
  the tool exchanges for a division. That is capability-based rather than
  instruction-based, which is a real difference. State its limit plainly: the
  agent can read its own system prompt, so it holds its own token — it simply
  never holds anyone else's.
- **The MCP plane is the candidate host** for the tool. It is already built and
  currently inert. Spike it before designing further.
- **The mirror ships in this increment, not after it.** A second store the corpus
  plane cannot see is the same failure as a provider: the dashboard would show
  `MEMORY.md` while the real knowledge sat elsewhere. Unlike Hindsight, we own
  the schema and both ends, so this is ordinary work rather than an integration
  against someone else's format — but it is the bulk of the cost and it is not
  optional.
- **The restore runbook grows a line.** A SQLite file is copied or `.backup`-ed;
  simple, and untested until it is written down.

**Done when:** a run in Division A cannot recall a row written by Division B —
asserted against the tool's arguments and its SQL, never against a model reply;
the tool's signature has no division parameter, so the mutation that would break
it does not typecheck; the store's contents appear in Agents → Memory beside the
file-backed entries and are labelled as to which division they belong to; and
deleting the scope injection fails a test. **7–11 days**, most of it the mirror.

## Total

**16–22 days** for A–E (1–2 + 3–4 + 3–4 + 4–5 + 5–7), plus D1. Unchanged by the
v6.0.4 re-verification: increment C keeps its estimate because the enforcement
that turned out to be impossible is replaced by labelling and regression tests of
similar size.

What A–E deliver, stated against the corrected mechanisms: **scoped access to
profiles** — enforced; **tool sets as immutable, auditable, reproducible profile
configuration** — declarative per profile, enforced deployment-wide; **memory
honestly shared per node** — with the screens saying so. That is the product
decision already taken, and it is now described in terms that match the code.

**Increment F is in the plan rather than beside it**, because it is the only
route to per-division memory that does not wait on software we do not own. If
scoped memory is wanted at all, this is the work. Most of its cost is the corpus
mirror, not the store.

| | Days |
| --- | --- |
| A–E — divisions, tool sets, skill sets, the screens | 16–22 |
| D1 — the sign-in decision (2–3 invited OIDC, 5–7 local passwords) | 2–7 |
| F — scoped memory on a local store | 7–11 |
| **A–F, everything** | **25–40** |

The spread is wide because D1 is unanswered, not because the work is vague:
invited OIDC puts the whole plan at **25–36 days**, local passwords at
**28–40**.

Sequencing is not negotiable: **F last.** A division-scoped memory built before
divisions exist would be scoping to something that does not yet bound anything.

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
- [ ] the visibility rule exists once, in one function
- [ ] every administration screen is reachable only by an administrator, who is
      deployment-wide by construction — there is no division-scoped admin, so
      Memory and Skills cannot be shown to someone they should be filtered for
- [ ] the worker passes the profile's tool set as the *declared* set and never
      narrows the boundary assertion below the node's enabled set — the
      regression that would refuse every narrowed profile
- [ ] a profile version's sets are immutable with the version
- [ ] deleting a referenced set is refused
- [ ] a tool set names Hermes toolsets only; `AgentToolGrant` and `GovernedTool`
      are untouched by B and C
- [ ] **no division id is ever written into `AgentToolGrant.allowedGroups`** — the
      division bounds which profiles you reach, the grant bounds which tools you
      call inside one, and putting the boundary in two places is how they drift
- [ ] `hardenedInstructions` documents the boundary and never decides it
- [ ] scope sets unchanged
- [ ] no division column on the tables listed above
- [ ] every new route resolves its session through `requireAdmin`
- [ ] every mutation writes an audit event and takes `expectedRevision`
- [ ] Skills and Memory screens state they are shared per node
- [ ] *(F only)* the memory tool takes no division parameter
- [ ] *(F only)* the scoped store is mirrored into the corpus plane in the same
      increment that introduces it

## Testing

Each enforcement point is a predicate whose removal is a one-line mutation; a
test surviving that deletion is vacuous. Three cautions:

1. **A leak is an absence.** Mutation only covers predicates someone remembered
   to write. Add an inventory test in the shape of `admin-session.gate.test.ts`:
   walk `apps/api/src`, find every query touching `agentProfile`, fail on one not
   in a known division-aware call site.
2. *(Retired by the scope model: administrators are deployment-wide, so the
   combination below cannot occur. Kept because it is the shape to re-check
   the day a delegated division admin is ever added.)* **Two identity paths
   double every case** — enterprise and
   `ADMINISTRATOR_PREVIEW`. A preview session with a null division walking a
   division-scoped route is where a real leak would hide.
3. **Assert the tool set at the seam** — the arguments passed to `hermes.start` —
   never against a model's reply. But assert the *right* property: that the
   declared set reaches the payload and that a narrowed profile **still runs**.
   A test asserting `admittedToolsets === ["memory"]` would pass while the run
   it describes fails in production, because the assertion that consumes it is a
   drift check. That is the exact test the previous draft called for.
4. **Do not write a test that appears to prove memory or skill isolation**;
   assert the on-screen statement instead. Extend this to the node claim: no
   test should imply a second node is runnable while two `length !== 1` gates
   say otherwise. If anything is pinned here, pin the refusal.
