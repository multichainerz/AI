# Changelog

Every release is one commit on `main` whose subject is the version (`vX.Y.Z`),
tagged with the same name. Entries below are newest first. The `v0.x` and
`v1.x` entries each cover a phase of the early development line rather than a
single change.

## v7.4.0 — 2026-08-16

Runs the spike increment F asked for before any of it was designed further, and
the finding rewrites the increment. Documentation only; no product change.

F's hard problem was how a memory tool learns which division it is serving
**without trusting the agent to say**. The plan's answer was a scoped token in
the system prompt, with a limit stated honestly: the agent can read its own
prompt, so it holds its own token.

That is no longer necessary, because the MCP plane already solves it. Every call
requires a private run authorization — `runId` plus a capability derived from
the bootstrap key and the run id, whose digest alone is stored — which an agent
cannot forge and cannot obtain for another run. `runForTooling` already
inner-joins `AgentProfile` to resolve it, so `runId → AgentRun →
AgentProfile.divisionId` is complete today and adding `divisionId` to that
existing projection is one line.

So the scope never passes through the prompt at all. There is no token for the
agent to read, leak into a transcript, or be talked into repeating — and the
increment's own rule, *the tool filters and the prompt never does*, stops being
aspirational: the prompt could not filter even if somebody tried, because it
carries nothing to filter with.

- rewrite F's scope-injection section, keeping the superseded design on record
  because the difference is the point
- record the spike's evidence with file and line, so the claim stays checkable
- add a Done-when: a call carrying Division A's run authorization cannot read
  Division B's rows even when the request body asks for them
- note that F is now the only unbuilt increment, and that the spike changed its
  risk rather than its necessity

## v7.3.0 — 2026-08-16

Adds the **People** tab. Increment E is complete: an administrator can create a
person, put them in a division, disable them, reset their password, and that
person can sign in — all without curl.

**Every increment of `docs/DIVISIONS_PLAN.md` except F now ships.**

- add `apps/web/src/people-view.tsx` and the Settings → People tab
- move somebody between divisions from the row, the same shape the profile list
  uses for the same decision
- show a password once, on screen, because that is the only time it exists in
  readable form; the copy says so rather than leaving an administrator to find
  out
- **omit the reset control for a federated person** rather than disabling it —
  this product holds no password for them, so the action does not exist rather
  than existing and failing
- say what disabling actually does: their open sessions end, not just their next
  sign-in

The empty state explains why an empty list matters — divisions bound what a
person sees, so a deployment with no people has a boundary and nobody to apply
it to.

Verified against the running stack: a person created into Finance, signed in
with `lastLoginAt` stamped from null, and a wrong password and an unknown
username answering byte-identically. The division boundary itself is covered by
the manager tests with a real enterprise principal — an administrator session
takes precedence in the route and is deployment-wide by design, so a browser
holding one cannot exercise a user's boundary.

## v7.2.0 — 2026-08-16

A locally created person can now sign in. `POST /api/v1/auth/local/login`
verifies a username and password and mints an ordinary `EnterpriseUserSession`,
so their division and `profileVisibleTo` work through the federated path
unchanged. The accounts v7.1.0 could create are records no longer.

**A serious bug, caught by the lockout test rather than by reading the code.**
The rejection was thrown from inside the transaction — which rolled it back,
including the row recording the failed attempt. `failedLoginCount` stayed at
zero however many times a password was guessed, so the account never locked and
an attacker had unlimited attempts. The counter now commits before the caller is
told no, and the test was confirmed by reintroducing the throw and watching it
fail.

- add `signInWithPassword`, mirroring the administrator local-login path
- share `LOCAL_LOGIN_FAILURE_LIMIT` and `LOCAL_LOGIN_LOCK_MS` between both
  credential stores, which the plan's checklist requires: two stores are the
  real cost of local passwords, and one constant is what stops them drifting
  into different definitions of "locked out"
- verify against `DUMMY_PASSWORD_DIGEST` when no account matches, so an unknown
  username costs the same time as a wrong password
- answer one message for every rejection — wrong password, unknown username,
  disabled account, active lockout — so the endpoint is not a username oracle
- reset an expired lock's count to zero rather than resuming it, so somebody who
  waited out a lockout starts fresh
- refuse a disabled person, and clear the failure count on success

## v7.1.0 — 2026-08-16

An administrator can create the people a division bounds. Increment E's
foundation: `LocalUser`, the person manager and `/api/v1/admin/people`. The
People screen and the sign-in path follow.

This closes the gap the plan called D1. Until now an `EnterpriseUser` row could
only come into existence when somebody arrived through an identity provider — so
a deployment with no IdP had a division boundary and nobody to apply it to.
`lastLoginAt` is now nullable, which is exactly the state "created, never signed
in" needed to exist.

**The credential is a separate table from the identity**, deliberately. An
`EnterpriseUser` is who somebody is — their division, their name, what they may
reach. A `LocalUser` is one way of proving it. Keeping them apart means a person
can later move to an identity provider by dropping a credential rather than by
rebuilding an identity, and it keeps a password hash out of every query that
only wanted a name.

Locally created people are keyed under a reserved issuer, `orcasynapse:local`.
That puts them in the same table as federated identities, so divisions, sessions
and `profileVisibleTo` all work unchanged, while making an IdP collision
impossible.

- add `LocalUser`, mirroring `LocalAdministrator` field for field so lockout and
  forced rotation cannot diverge between the two credential stores
- reuse `hashLocalPassword` / `localPasswordIsValid`, so there is one definition
  of an acceptable password rather than two
- **revoke every live session when a person is disabled** — otherwise the
  account is disabled for the next sign-in and unchanged for the one already
  open, which is the opposite of what disabling somebody means, and the gap
  lasts as long as the session's absolute lifetime
- clear the lockout on an administrator password reset, since a reset is the
  intended way out of one; leaving it would mean a reset that visibly succeeds
  and still refuses the new password
- refuse to put a person into a suspended division
- say plainly that a federated person has no password this product holds, rather
  than failing obscurely on a missing credential

## v7.0.0 — 2026-08-16

Gives tool sets and skill sets their screens, on the tabs that own each. This
closes the last "the API exists but nothing calls it" gap in the divisions work:
every increment from A to D is now complete, enforced and operable.

One component serves both, because they are the same shape with a different
payload and two near-identical panels would drift apart.

The distinction it exists to make legible is **tracking** versus **named**. A
tracking set means "everything", resolved when it is read; a named set lists its
members. They cannot be edited into one another, so the seeded defaults are
drawn as fixed rows with no Retire or Delete rather than as something that looks
editable and then refuses.

- add the panel to Agents → Tools, below deployment admission, because a set is
  a selection *of* what is admitted — naming a toolset nobody admitted would be
  a promise the runtime never keeps
- add it to Agents → Skills, and deliberately not to Memory: a set names a
  reusable selection, and there are two memory files per node with nothing to
  select between
- offer only admitted toolsets as choices, and say so when none are
- state the tracking default as "Everything this deployment admits — nothing is
  admitted yet", keeping the promise and the present answer visible together, so
  an empty list on a fresh install reads as correct rather than broken

## v6.9.0 — 2026-08-16

Puts the pickers on Agents → Profiles. A profile can now be assigned to a
division, given a tool set and given a skill set, from the screen it belongs to.
This is what connects v6.8.0's Divisions screen to what a user actually sees.

- show which division each profile is visible to, on the row rather than behind
  a click
- add a **Visible to** control per profile, as its own control rather than a
  field in the version editor: assigning a division does not change what the
  agent is or how it behaves, only who may reach it, and minting a new immutable
  version for it would make the version history lie about what changed
- add tool-set and skill-set pickers to the version editor, both defaulting to
  "everything", which is what the server resolves to when neither is named
- carry `AgentProfile.divisionId` in the contract and the DTO

**A bug caught in the browser, not by a test.** The row label resolved the
division by lookup and fell back to "everyone". The division list loads
separately from the profiles and lands a frame later — so for that frame, and
permanently if the request ever failed, a profile restricted to one division
announced itself as visible to everybody. It showed for exactly one screenshot.
"Everyone" is now keyed off a null `divisionId` and never off a failed lookup;
an unresolvable division reads as "a division", which is vague but true.

That failure direction is the one worth spending care on: a restricted thing
that claims to be open invites exactly the mistake the boundary exists to
prevent.

## v6.8.0 — 2026-08-16

Gives divisions a screen. Settings gains a **Divisions** tab, so the boundary
enforced since v6.4.0 can be operated without curl.

Create, rename, suspend, reactivate and delete a division; see how many agent
profiles and people each one holds. The counts are the point of the list — an
administrator about to suspend or delete something needs to see what it holds
before doing it, which is why they are read from the rows rather than a stored
number that could drift.

The screen states two limits rather than leaving a reader to assume otherwise,
because both are easy to get wrong in exactly the expensive direction:

- **A division is not an isolation boundary.** Agents on the same Agentic System
  node share their memory and their Skills whichever division their profile
  belongs to.
- **Administrators are never bounded by a division.** There is no
  division-scoped administrator, so every administration screen shows the whole
  deployment.

- add `apps/web/src/divisions-view.tsx` and the four API client calls
- add the tab, the `Divisions` view token, `#settings/divisions` and `#divisions`
- update the Settings rail tooltip, which a test requires to name every tab in
  its own area

The empty state says what the absence means — every agent profile is visible to
every signed-in user until a division is created and assigned — rather than just
reporting that there is nothing here.

## v6.7.0 — 2026-08-16

Divisions become administrable. v6.4.0 made the boundary real but left divisions
creatable only by direct database access; this is the contract, manager and
routes at `/api/v1/admin/divisions`.

- create, list, rename, suspend and delete a division, with the
  `expectedRevision` and audit-event pattern the other managers use
- assign a profile to a division, or return it to deployment-wide with `null`
- count what each division holds, from the rows rather than a stored counter —
  these numbers exist so an administrator can see the blast radius of a change,
  which a count that can drift from the rows would defeat
- refuse to delete a division that still holds profiles or users, naming what is
  in the way and pointing at suspension: an administrator told only "in use" has
  no next step
- refuse to assign a profile *into* a suspended division, while always allowing
  one out — moving work into a division taken out of use would create profiles
  nobody can reach, and moving work out strands nothing
- guard the assignment with the profile's `currentVersion`, which moves on every
  configuration change, so a caller holding a stale profile cannot silently
  re-home it after somebody else edited it

Reads behind `agents:read` and writes behind `agents:manage`, adding no scope
and no role: a division decides which profiles a user reaches, which is the
decision the Agents screens already make. That separation is what lets an
administrator create a division without a release.

The end-to-end test asserts an assignment against `profileVisibleTo` itself
rather than a restatement of the rule, so administration and enforcement cannot
drift apart.

## v6.6.0 — 2026-08-16

Gives Models, Prompts and Guardrails their own rail area, **Gateway**, and
leaves Settings holding Setup and System.

Settings had become a drawer. Models, prompts and guardrails are not setup
steps — they are the running configuration of the governed inference path, and
the runbooks are explicit that the internal gateway is what enforces the active
guardrail policy and pins the model alias. Filing them under "install this" put
five unrelated tabs in one row and made Settings mean nothing in particular.

- add the `Gateway` product area, between Agents and Operations: configure the
  inference path, then watch it
- move Models, Prompts and Guardrails out of the Settings tab row
- give it the joined-waypoints glyph — a shield would have overweighted
  guardrails against the other two
- move the generated hashes to `#gateway/*`, so the address bar follows the
  navigation rather than contradicting it
- keep `#settings/*`, `#platform/*` and the short aliases resolving: two moves
  have now passed over these screens and a bookmark from either era still works
- update the rail tooltips, which a test requires to name every tab in their own
  area, so a description cannot drift from the tabs it summarises

Gateway is ungated, exactly like Settings. The rail has never filtered by scope
— each screen draws its own locked state — and all four admin roles carry
`models:read`, `prompts:read` and `guardrails:read` anyway, so no role could see
an empty section. Gating one area and not the others would have been new
machinery and an inconsistent rail.

Also corrects the navigation copy in `.cursor/rules/orcasynapse-conventions.mdc`
and `docs/CURRENT_STATE_HANDOFF.md`, which both still described five areas.

## v6.5.0 — 2026-08-16

Profiles now carry a tool set and a skill set, and a run reproduces exactly the
sets its version was given. Increment C of `docs/DIVISIONS_PLAN.md`.

A profile created without naming either gets the tracking defaults, so no API
caller has to know these exist. An edit that says nothing about the sets carries
the previous version's forward rather than re-resolving them — a version is
immutable, and a run must reproduce what it was given rather than what the
defaults happen to be today.

**The regression this increment is really about.** The plan originally had the
worker pass `deployment-admitted ∩ the profile's tool set` to `hermes.start`.
That value is not a control: it feeds `assertAdmittedToolBoundaryFor`, which
reads the runtime's *enabled* toolsets and throws when any falls outside the set
it is handed. Narrowing it per profile would not have given that profile fewer
tools — it would have failed **every** run of any profile whose set was a strict
subset, with an error reading like runtime drift rather than a design mistake.

So the worker still submits the deployment-wide set, the reason is recorded at
the seam, and a test in `agent-processor.test.ts` asserts the call arguments.
That test was verified by implementing the intersection the plan asked for and
watching it fail.

- add `toolSetId` / `skillSetId` to the create and update contracts, optional in
  and resolved to the tracking defaults when absent
- keep both out of `distributionDigest`, so the digest recomputed independently
  in `packages/database`'s seeder is untouched
- carry the sets forward across an unrelated edit
- assert the submitted toolset payload stays deployment-wide

**Also fixes a defect the new test found.** `RuntimeToolsetAdmission.admitted`
defaults to **false** — a row records that somebody considered a toolset, not
that they allowed it — and v6.3.0's `admittedToolsetNames` read every row. The
tracking default would have claimed to include toolsets the deployment had
refused. It now filters on `admitted`, the way the worker always has.

## v6.4.0 — 2026-08-16

Divisions become a real boundary. A user in one division cannot list or run
another division's agent profile.

This is the clause increment A was built to make cheap, and it landed as a
four-line change to one function because that groundwork existed. The rule:

    administrator || profile.divisionId === null || profile.divisionId === principal.divisionId

Administrators are deployment-wide, by design rather than by omission. There is
no division-scoped administrator anywhere in this product, which is what makes
every administration screen safe by construction — it matters most for Agents →
Memory and Agents → Skills, which are shared per node and *cannot* be filtered
by division even in principle. A division-scoped admin opening them would read
what every other division's agent had learned; deployment-wide removes that
possibility rather than guarding it.

- add the `Division` table, and nullable `divisionId` on `AgentProfile` and
  `EnterpriseUser` with `ON DELETE RESTRICT`
- **no column on `LocalAdministrator`** — see above
- add the division clause to `profileVisibleTo`, and only there
- carry `divisionId` on the enterprise principal, through both route surfaces
- select `divisionId` where the rule reads it; omit that and the rule sees
  `undefined`, treats it as deployment-wide, and passes every profile while
  looking exactly as it does now

Null division means deployment-wide, which every existing row already is, so the
migration re-homes nothing. A user in *no* division sees deployment-wide
profiles only — absent reads as narrowest, never as unrestricted.

Divisions are data, not an enum: any name, any number, created at runtime. That
follows from division not being a scope — modelled as one, every new division
would have meant editing `ADMIN_SCOPES`, a release, and an upgrade of every
deployment.

**Not yet included:** the Division CRUD contract, manager and routes, so
divisions are currently assignable only by direct database access. The boundary
is complete and enforced; the administration surface for it is not.

## v6.3.0 — 2026-08-16

Makes tool sets and skill sets real: contracts, a manager and admin routes at
`/api/v1/admin/configuration`. v6.2.0 added the tables; this is what can read and
write them. No dashboard yet.

The interesting half is what a *tracking* set answers. The seeded defaults mean
"everything", and everything is not a list — it is whatever the deployment
admits at the moment you ask. So `resolvedToolsetNames` is filled in from
`RuntimeToolsetAdmission` on read, and is deliberately **null** on a set that
names its own members: a caller that could not tell the two apart would print
"these toolsets" for a set that actually means "whatever is admitted", and would
be wrong the moment admission moved.

- add `packages/contracts/src/configuration-sets.ts`, one module for both
  because they are the same shape with a different payload
- add `DrizzleConfigurationSetManager` with the `expectedRevision` and
  audit-event pattern the other managers use
- resolve a tracking set against admission on read; leave `resolvedToolsetNames`
  null on a set that lists its own members
- refuse to give a tracking set a fixed member list, so "what is in this set?"
  never has two answers with nothing deciding between them
- refuse to delete a set a profile version references, **naming the profile** —
  "in use" leaves an operator with no next step, and `ON DELETE RESTRICT` is the
  backstop rather than the explanation
- allow retiring a set instead of deleting it, hidden from the list unless asked
- reuse `tools:read` / `tools:manage` and `corpus:metadata:read` / `corpus:write`
  rather than adding a scope, per the plan's scope model
- correct the api test-file budget, which the static gate caught again

`AgentToolGrant` and `GovernedTool` are untouched. A tool set names Hermes
toolsets; those name governed tools on the MCP plane. Keeping the two apart is
what stops there being two competing answers to who may use a tool.

## v6.2.0 — 2026-08-16

Adds the tool set and skill set concepts to the schema, and seeds one of each at
installation so a profile is never without them. Increment B/C groundwork from
`docs/DIVISIONS_PLAN.md`; nothing reads these yet.

Neither concept existed in any form — a profile could express Hermes toolsets not
at all, and its `skills` were a raw list retyped per profile and reusable
nowhere. `ToolSet` and `SkillSet` make a selection nameable and shareable, and
`AgentProfileVersion` gains a foreign key to each.

The seeded defaults **track** rather than snapshot, which is the whole design
and not a detail. `RuntimeToolsetAdmission` is empty at installation — it is
written only when an operator admits toolsets, and no Hermes node has enrolled
to report any — so a default set built by capturing "everything admitted right
now" would contain nothing, and would read on screen as a profile permitted no
tools at all. `tracksAdmission` and `tracksRuntime` mark the two seeded rows as
resolving to whatever exists when they are read. A set an operator names by hand
lists its members explicitly.

This is also the only safe default rather than the merely friendly one: handing
Hermes a set narrower than what the node has enabled makes the tool boundary
assertion throw and the run fail, so "everything admitted" is the one value that
cannot break a fresh install from its own seed.

- add `ToolSet` and `SkillSet` with a shared `ConfigurationSetStatus`
- add `AgentProfileVersion.toolSetId` and `.skillSetId`, `ON DELETE RESTRICT`,
  because deleting a set a shipped version depends on would silently rewrite
  what that version was
- keep both columns nullable and require them at the contract layer instead: a
  generated `NOT NULL` foreign key cannot be added ahead of the rows that would
  satisfy it, since migration SQL runs before any seeding code
- seed both defaults and backfill every set-less profile version, idempotently
- correct the database test-file budget, which the static gate caught

## v6.1.0 — 2026-08-16

Closes the three profile-selection holes, which is increment A of
`docs/DIVISIONS_PLAN.md` and the precondition for divisions.

Assigning a profile to a division means nothing while any signed-in user can
reach any profile, and three separate paths allowed exactly that. `listProfiles`
ignored its principal, so every user saw every active profile. `submitRun` took
the caller's profile UUID on trust — the row was loaded and run, with that
profile's prompt and tools. `activeProfile` was reachable with no id at all and
fell through to "whichever profile was edited most recently", so omitting a
field was enough to be handed someone else's agent.

All three now resolve a profile through one shared rule in
`apps/api/src/agents/profile-visibility.ts`. Divisions add their clause to that
one function and nothing else changes, which is what makes the increment worth
shipping before the feature it serves.

- add `profileVisibleTo`, the single visibility rule both managers consult
- thread the principal through `listProfiles`, which was `_principal`
- check visibility in `submitRun` before any runtime state is read, so a caller
  who may not see a profile cannot learn whether the runtime is up by asking
- require an explicit profile id in `activeProfile`; a caller with none is now
  a compile error rather than a silent default
- answer 404 rather than 409 for a profile the caller cannot see, so refusal is
  indistinguishable from absence — a 409 would confirm the UUID names something
  real, which is the fact a division boundary exists to withhold
- keep a visible but inactive profile a 409, so an operator is never told their
  own suspended profile has vanished

Behaviour is otherwise unchanged: with no divisions defined the rule admits
everything. The one visible change is that starting a session without naming a
profile now says so instead of guessing.

## v6.0.4 — 2026-08-16

Rewrites the connection modal's reading order. It serves all three connection
kinds, so this is not only the inference one.

Three faults, and they compounded. Its title said "Connect your AI stack" while
the card immediately beneath said "Update AI Inference" — a generic promise
arguing with the specific job, and the card existed only to correct it. Scheduled
monitoring, whose own summary calls itself optional, was the **first** thing on
the screen: above the connection it monitors and above the fields an operator
came to fill in. And the result was six bordered containers stacked vertically,
which is what made it read as noise rather than a form.

It now goes: what you are editing, its current state, the form, optional extras,
save. Four containers instead of six.

- title the modal for the job — "Update AI Inference" or "Connect AI Inference" —
  and carry the connection's role as the description
- delete the duplicate heading card that only existed to say what the title
  should have
- move scheduled monitoring to the foot, where optional things belong

## v6.0.3 — 2026-08-16

Moves the last panel off the right edge of Setup. v6.0.1 did this for step 1's
connection form; step 2's installer generator was still a drawer.

It slid in over the very step it belongs to, so the enrolment instructions and
the form could not be read together — and that copy is long: a one-time claim,
the command to run on VM2, and what happens over the following twenty minutes.
Reading it beside its own step is the entire point of it being there.

Step 3 needs no change: its action navigates to Agents, which has no drawer. No
`<Drawer>` usage remains anywhere in the dashboard.

`Drawer` is `OverlayChrome` with one flag set, so the focus trap, escape handling
and scroll lock are untouched — only where the panel appears changed.

- render the VM2 installer generator as a centred dialog, matching step 1 and the
  node-removal confirmation beside it

## v6.0.2 — 2026-08-16

Recalibrates `docs/DIVISIONS_PLAN.md` against the tree and settles the memory
question it left open. Documentation only; no product change.

The plan was written at v5.5.0 and held. Every citation in it has been re-checked
rather than assumed — the 27 `AdminScope`s, the five tables it extends, the nine
files it touches, the seeded profile's empty `skills`, and all three
preconditions, which are all still open. The increments, their order and the
estimate are unchanged.

What it did not say, and now does, is why memory cannot be divided. Verified
against the pinned Hermes commit `c015663b`: `load_on_disk_store()` takes no
arguments and `MemoryStore.__init__` takes only character limits, so the built-in
store has nothing to key a tenant on — Hermes' own docstring calls the directory
"profile-scoped", profile meaning the home. The gateway does carry a `user_id`,
and Hermes' own test says it reaches *plugins*; the arrow stops before the file
store. And `user_id` appears exactly once in `gateway/platforms/api_server.py`,
as a column in a `SELECT` list, so a caller cannot tell Hermes who is asking.

The consequence is recorded plainly: a memory provider cannot escape the home
boundary either, because the identity cannot get in. A home per division is not
merely the first answer but the only one currently available.

- record that memory is bounded by the node — `HermesCorpusEntry` is unique on
  `(nodeId, path)` — so one VM2 is a scoping choice rather than a constraint
- evaluate Hindsight (MIT, PostgreSQL with pgvector, `bank_id_template`) and
  record why it is blocked upstream, that its PostgreSQL would run on VM2 and
  never VM1's, and that providers are additive so adopting one costs the
  observability guarantee until a bank is mirrored
- add increment F: scoped memory on SQLite behind a tool that takes no division
  parameter, because the tool must filter and the prompt never can. Deliberately
  outside the A–E total
- make administrators deployment-wide, so every administration screen is
  super-admin by construction — which closes a gap the plan did not cover, since
  Memory and Skills are shared per node and cannot be filtered for a
  division-scoped admin
- drop `LocalAdministrator.divisionId` rather than leave a nullable column for a
  feature that is not being built

## v6.0.1 — 2026-08-15

Moves the connection form off the right edge of the screen.

It opened as a drawer that slid in over Setup and covered the very step it was
serving, so the form and the instructions it belongs to could not be read
together, and the screen was left split down the middle with the wizard dimmed
behind it. The architecture decision on that same screen has always been a
centred dialog; this now matches the surface it is launched from rather than
arriving from the edge.

`Drawer` is `OverlayChrome` with a single flag, so the focus trap, escape
handling and scroll lock are untouched — only where the panel appears changed.

- render the connection form as a centred dialog instead of a right-hand drawer

## v6.0.0 — 2026-08-15

Replaces the static synapse graph behind sign-in, boot and the error screen with
an animated dot lattice, and makes Operations → Health readable.

The lattice is reimplemented from a WebGL reference rather than lifted from it.
The original ran a GLSL shader through Three.js loaded from a CDN, and styled
every element inline — neither can ship here. This product installs on-premise
and is often air-gapped, and the container serves `script-src 'self'`, so the
CDN `<script>` is refused by the browser and the page renders with no background
and no error an operator can see. `scripts/test-csp-closure.sh` separately fails
the build on `style={{`. A 2D canvas draws the same thing for no dependency and
no network.

**Health stopped explaining its own data model at the reader.** Every panel
description was a sentence about how the data is stored — "live state is
distinguished from dashboard configuration", "counts retain their domain
meaning" — written to record a past confusion rather than to say what you are
looking at. The screen also called three different numbers "Hermes runs",
showing `0` in the summary and `1` a panel below, and labelled a running total
"Retained", which reads as a retention policy and is neither.

- draw the dot lattice on a 2D canvas: no Three.js, no CDN, no inline styles,
  and it stops entirely under `prefers-reduced-motion`
- keep the cell phase deterministic — `Math.random()` per frame would re-roll
  every cell and make the whole field strobe
- retire the static synapse graph from sign-in, boot and the error screen
- pin the sign-in panel's height, so it stops resizing as an operator moves
  between sign-in, offline recovery and the forced password change
- put the version and the copyright at opposite ends of the sign-in footer, with
  the year read at render so a long-running deployment does not claim the wrong
  one
- rename Health's panels to what they hold: Services, Incidents, Activity,
  Background work, Guardrails
- move Incidents directly under Services, since it is the only thing on the
  screen anyone has to act on, and it sat below three panels of steady state
- disambiguate the run counts and rename "Retained" to "All time"
- tone the snapshot age: every figure comes from that one reading, and it was
  drawn in the same muted grey at two seconds old and at two days

## v5.9.0 — 2026-08-15

Teaches the VM2 heartbeat to say which of the node's systemd units is broken.
v5.8.0 taught the control plane to accept that; this is the half that sends it.

**Upgrade VM1 to v5.8.0 or later before taking any VM2 to this release.**
`hermesNodeHeartbeatSchema` is `.strict()`, so a node sending `units` to a
control plane that does not know the key is refused on every beat, goes stale,
and is marked OFFLINE — the failure would look exactly like the one this feature
exists to explain. That is the only reason the two halves are separate releases.

`is-active` and `is-enabled` exit non-zero for anything that is not, and this
script runs under `set -e`. Each is asked inside an `if` for that reason: the
heartbeat is the one thing on the node that must not stop because something else
has, and a version of this that aborted on the first stopped timer would have
removed the signal it was added to carry, at the moment it mattered.

The heartbeat's own timer is in the list it reports. It cannot report that timer
being *inactive* — nothing would be running to say so, and the control plane's
staleness window covers that — but it can report it active and not enabled,
which is a node that will go silent at its next reboot and nothing else catches.

- report each unit's `active` and `enabled` state in the signed heartbeat payload
- pass the unit names in through the unit's environment rather than hard-coding
  them, since the runtime service name is overridable and a client that guessed
  would report on a unit that does not exist — which reads as "down"
- advertise `unit-health-v1` so the control plane can tell a node that reports
  nothing from one that has nothing to report
- assert the payload end to end in the VM2 smoke test: four units, booleans
  rather than the strings "true"/"false", and the running runtime reported active

Verified against real systemd in WSL VM2 by extracting the shipped client from
the installer rather than retyping it, across an active unit, a genuinely failed
one and one that does not exist: all three reported, none aborted the script.

## v5.8.0 — 2026-08-15

Gives VM2's four systemd units one handle, and teaches the control plane to say
which of them is broken instead of only that a node has gone quiet.

`orcasynapse-hermes-node.target` starts, stops and reports the runtime service
and the three timers together. It is additive: every unit keeps the `WantedBy=`
it had, so boot behaviour is unchanged and a node that never gains the target
goes on working.

**It is not a step toward merging them into one program.** Those four run under
four different privilege profiles — the runtime is unprivileged, the heartbeat is
root but `ReadOnlyPaths` the state root and cannot write a byte, the corpus
reconciler writes it, and the desired-state client re-installs Hermes. A single
unit would hold the union of those, which is the loosest. `PartOf=` is on the
timers and the runtime, never on the three oneshots, so stopping the target stops
*scheduling* rather than killing a reconcile midway through replacing Hermes.

The second half is the compatibility-sensitive one and ships in two parts.
`hermesNodeHeartbeatSchema` is `.strict()`, so a node sending a field the control
plane does not know is refused on every beat, goes stale and is marked OFFLINE.
This release only *accepts* an optional `units` array; the VM2 client that sends
it comes next, by which time every control plane it could reach already knows the
key. **Upgrade VM1 first** — that ordering is a requirement, not a preference.

A node that has never reported units reads "Not reported", never "all running".
The two are different facts and collapsing them is how a broken node looks fine.
The heartbeat timer's own failure is deliberately absent from that list and does
not need to be there: a node whose heartbeat stops goes stale and is reported
OFFLINE from `lastSeenAt`. Between the two, nothing on the node is unaccounted for.

- add `orcasynapse-hermes-node.target`, with `PartOf=` on the runtime and the
  three timers so a stop actually propagates — `Wants=` alone starts a set and
  never stops it
- remove the target by name in the decommissioner, whose `orcasynapse-hermes-*`
  glob matches `.service` and `.timer` only
- assert the target by behaviour in the VM2 smoke test: that it starts the set,
  that stopping it stops all four, and that every member is still independently
  enabled for boot
- accept an optional `units` array on the heartbeat and carry it on the node
  summary as nullable, so "never reported" survives to the screen
- report `active` and `enabled` separately: one failed or was stopped, the other
  will be gone after a reboot, and they need different fixes
- leave a stored unit list alone when a later heartbeat omits it

## v5.7.0 — 2026-08-15

Makes an in-dashboard update something an operator can watch and check, and
renames the tab it lives on from Application to **System**.

Approving a release already worked: the VM1 agent picks the record up, applies
it, gates it on readiness, and restores the previous release if the new one does
not serve. What none of that reached was the dashboard. The agent recorded every
phase and the installer's own log into two root-owned files the container cannot
read, so an operator's only way to find out whether their upgrade worked was a
shell on VM1 — the thing in-dashboard updates exist to remove.

The agent now also writes that record to PostgreSQL, which it already connects to
in order to read the approval, and Settings → System shows it: the outcome in
plain words, the release moved from and to, and the installer log behind a
control.

**It captures `UI_LOG_FILE`, never the installer's stdout.** `install.sh` prints
the Offline recovery key with a bare `printf` that deliberately never reaches
that log — "printed, never logged" is an invariant the installer states at the
line that prints it — so capturing terminal output would have published the key
into a database table and then onto a web page. The suite asserts the key is
absent from the stored log on both the success and the rollback path.

The screen also stopped contradicting itself. It said "Recorded, not applied —
the upgrade still runs on VM1 with the command above" one sentence before saying
the hosts read the record and apply it themselves, and `automaticUpdateSupported`
was a `z.literal(false)` whose reason — the container has no host-root or Docker
control — is still true but no longer implies the conclusion. Both dated from
before the agent shipped, and a test pinning the wrong half is what kept them.

- record every agent phase and the installer log to PostgreSQL, best-effort and
  after the durable files, so an agent can never fail an upgrade because it could
  not describe one
- capture every log the attempt produced, not the newest: a failed upgrade writes
  two, and the newest describes the recovery rather than the failure
- add `PlatformUpdateAgent` (liveness) and `PlatformUpdateRun` (attempts),
  separate so an idle tick ten minutes later cannot erase the upgrade it follows
- report the agent's absence explicitly — without it, "no agent installed" and
  "installed and idle" both look like an empty list, which is the state a VM1
  installed before v5.6.0 is in
- distinguish "the control plane is being replaced" from "the upgrade stalled",
  using the unavailability budget the agent writes down before taking the stack
  down
- compute `automaticUpdateSupported` from whether an agent has actually reported,
  and demote the shell command to a fallback when it has
- rename Settings → Application to Settings → System, keeping `#settings/system`
  as the address and both former hashes resolving
- grow the update-agent suite from 67 assertions to 83

## v5.6.2 — 2026-08-15

Unclamps the conversation rail's rows, which is why it read as cramped. The row
is a `Button`, whose default size is `h-9`; height and padding are different
properties, so no `py-*` written on that row had ever competed with it. Every
row was pinned at 36px while its title and preview needed 67px, and the two
lines were clipped rather than merely tight. The `auto` size exists for exactly
this case — its own comment says the single-line sizes "would clip a title and
caption" — and the rail had simply never used it.

The previous release's spacing work was therefore inert, so it is redone on top:
row padding, the row's internal line gap, the gap between rows and the date
heading all move together, since raising one alone changes a proportion rather
than the density.

Measured in a browser rather than read off the diff, because jsdom implements no
layout and reports a clamped row's padding as applied — the same reason the
suite was green through the whole defect.

- give the conversation rail's rows `size="auto"`, so a row's height follows its
  content instead of being clipped at 36px
- raise the rail's vertical rhythm: 12px row padding, 6px between a row's two
  lines, 6px between rows and more room around the date heading — 67px rows at
  32px apart, against 36px rows at 6px
- cover the rail with `apps/web/src/chat-rail.test.tsx`: date grouping, the
  title/time/preview split, the archived label that replaces a timestamp, and
  the agent-name fallback for a conversation with no preview — none of which any
  test reached, since the existing chat tests render a one-item list
- give that test a `RAIL_PREVIEW_OUT` dump, so a populated rail can be looked at
  without a signed-in session

## v5.6.1 — 2026-08-15

Makes the conversation rail readable. Every row spent 40px of a narrow rail on a
30px speech-bubble that was `aria-hidden` and identical on every item —
decoration priced in the one dimension the content was short of. The title
truncated at roughly two dozen characters, and the line beneath packed a
fixed-width timestamp, a separator dot and the message preview into what was
left, so the preview arrived at about twenty. Two truncated strings, stacked,
neither readable.

- drop the per-row icon and give the title the full width
- move the timestamp to the end of the title line, where it costs the title a
  known amount and costs the preview nothing, and give the preview its own line

## v5.6.0 — 2026-08-15

Increment 4, the last one in `docs/IN_DASHBOARD_UPDATE_PLAN.md`: VM1 upgrades
itself from the release an administrator approved, and an upgrade that fails is
undone rather than survived.

**An upgrade is reversible now, which it was not.** `install.sh` deleted its
source backup the instant the swap succeeded, so the restore window was the two
lines between moving the old tree aside and removing it — never the migration,
never anything after it. The tree is retained past the swap and discarded only
once the upgrade is confirmed.

- restore the source and re-run the restored tree's own installer when the
  handoff fails, so the deployment comes back up rather than merely back
- restore the database **only when the schema actually moved**, decided by an
  md5 of `information_schema.columns` taken beside the dump. The commonest
  failure is an image build that never touched the database, and restoring
  unconditionally would discard every write taken while it ran. A data-only
  migration is the case the fingerprint cannot see; `always` overrides it
- keep the rollback in `install.sh` rather than in the agent: only the installer
  knows the instant of the swap, it is also the hand-run path used during an
  incident, and the code that takes the backup is the code that restores it
- `ORCASYNAPSE_UPGRADE_ROLLBACK=off` restores the previous behaviour for an
  operator who wants the failed state to inspect

**VM1 gains its first systemd units.** `orcasynapse-update.timer` reads the
approved target from Postgres, fetches `install.sh` at the approved **commit**
rather than the tag — a tag can be re-pointed after approval — and health-gates
`/readyz` afterwards.

- run the agent from `/usr/local/lib/orcasynapse/`, replace it by rename so a
  running shell keeps its own inode, and launch the upgrade in a transient
  systemd scope so stopping the unit cannot kill it mid-upgrade
- record `apiUnavailableUntil` and rewrite `upgrading` to `failed` on abnormal
  exit, so a finished run never reads as still going while the API is down
- recover from the failure `install.sh` cannot see — an install that returns 0
  and then never serves — by performing the runbook from the backup record
- block a target that has already failed, keyed on commit and revision. Without
  it the ten-minute timer is a loop that restores the database from the dump
  every tick, and the rollback becomes the thing that destroys the data

**Testing.** 106 assertions across 8 upgrade scenarios and 67 for the agent, and
19 mutations — nine against `install.sh`, ten against the agent — every one
caught. The post-migration case asserts the discrimination from both directions:
a row written *during* the upgrade must be gone when the schema moved and must
survive when it did not, so a rollback that restored unconditionally fails.

Not proven: no application image is built anywhere in it, so nothing here says
the product boots on the new schema; and no real deployment has been upgraded by
this agent. The first genuine unattended upgrade will be the first one anyone
has watched.

## v5.5.0 — 2026-08-15

Tells an enterprise user the truth about whether a session will run, fixes a
test that only ever passed by luck, and records why the dashboard suite's
timeouts are not what they look like.

**An enterprise user was offered a session the deployment was going to refuse.**
The agent-execution boundary lives behind `agents:read`, which an enterprise
session can never hold, so the dashboard could not read it and assumed
permissively — the run was then refused at submission, after the message had
been typed.

- carry `executionEnabled` on the profile list, the one agent route both
  identity modes can read, and gate the session button on it for both
- derive it in the manager rather than the route, so no route can return a list
  without it and the enterprise route gained no admin-scoped read
- carry only that bit: why execution was switched off, by whom and when stay on
  the boundary's own record behind `agents:read`, pinned by a test comparing the
  exact key sets
- make the field optional on the wire and fail closed when it is absent. It
  shipped required and broke a live deployment on the first dashboard load: the
  API there was two majors behind, omitted it, and the whole Agents screen threw
  a Zod issue rather than degrading. Every in-place upgrade restarts web and api
  at slightly different moments, so meeting an older API is a normal state — and
  `AGENT_RUN_EVENT_TYPES` already states that principle a few lines above.
  Optional is not permissive here: the reader requires `=== true`, so silence
  withholds the session rather than granting it, which is stricter than the
  default it replaced

**A test that could not have caught its own subject.** `corpus-view.test.tsx`
asserted that a revisions fetch had happened, synchronously, in the same commit
that triggered the effect making it. Measured inside `waitFor`, the call count
was zero in 10 of 10 runs on an idle machine: the assertion had no happens-before
relationship with the fetch and passed only when the event loop happened to
oblige. It is awaited now — 40 consecutive full-suite runs green, and reverting
it brings the failure back at 2 in 20.

- move the tool-approval wire-format tests into `packages/contracts`, where the
  schemas they exercise live. An audit called the file orphaned because its name
  referenced a deleted panel; the panel is gone but the contract is still
  enforced on a live route, so deleting it would have removed real coverage

**Why the dashboard suite's 5s timeouts are not a budget problem.** Three
observers hit `app-dashboard-metrics`, `front-page` and `recovery-kit-dialog`
timing out in one session, while several full suites ran concurrently with each
other on one workstation. CI does not reproduce that: it runs `pnpm -r test`
once, the four-vCPU budget the existing 2.3s measurement was taken under.
`vitest.shared.ts` now records the distinction, because widening the ceiling on
that evidence would triple the time a real hang takes to surface.

Also adds `docs/DIVISIONS_PLAN.md` — a plan only, nothing implemented.

## v5.4.0 — 2026-08-15

Increment 3 of `docs/IN_DASHBOARD_UPDATE_PLAN.md`, the upgrade harness that
increment 4 is gated on, and two corrections to claims this changelog published
as fact.

**Two corrections, because both were stated here and both were wrong.**

v5.2.2 said `openssl pkeyutl -verify` prints "Signature Verification Failure"
and exits 0, and that the assertion resting on its exit code had therefore
verified nothing in every release that shipped it. That is false. Measured on
OpenSSL 3.0.13 with stdout inherited, redirected and captured, it exits 1 on a
corrupted message in all three and prints its verdict in each. The original
reading came from a probe that reported the calling shell's status rather than
openssl's. The assertion was sound all along; it now checks the exit code and
the verdict together, and the file records why.

v5.3.0 said `install.sh` restored the source tree on a failed upgrade and only
the database was missing. Also wrong. The source backup is deleted the moment
the swap succeeds, so the EXIT restore covers the two lines between moving the
old tree aside and removing it — not the migration, and not anything after it.
Nothing recovered a post-migration failure. The plan and the upgrade harness now
state that, and increment 4 has to build the rollback rather than trigger one.

**VM2 follows its recorded Hermes commit.**

- carry a required `hermesCommit` on the signed desired-state document, a Hermes
  commit and explicitly not the release commit that drives VM1
- resolve it from the node's enrolment pin, falling back to the commit the node
  itself reports and only then to the release default, so a node deliberately
  pinned at enrolment is never moved by a global constant
- move the runtime only after the document's signature verifies, drain rather
  than kill it, health-gate the new checkout, and write `commit-pin` only once
  the install is verified
- reinstall the previous commit when a move fails, and if that also fails record
  whatever is actually on disk, so the pin can never lie to the heartbeat
- report a failed move after applying the toolset allowlist: a runtime that will
  not move must not also stop being governed
- show commit drift on the runtime nodes panel, with no apply button — the
  operator decision stays in Settings → Application

**An A→B upgrade harness.** Eight scenarios through the real `install.sh`,
including an upgrade that fails after its migrations have committed, which is
the case nothing could exercise before. It asserts the pre-upgrade dump predates
the migration by reading the dump's own bytes rather than trusting a log line.

## v5.3.0 — 2026-08-15

The first two increments of updating the deployment from the dashboard, planned
in `docs/IN_DASHBOARD_UPDATE_PLAN.md`. Neither applies an update yet — one makes
an upgrade recoverable, the other records which release an operator approved —
and both are useful on their own, which is why they ship before anything acts on
them.

The design keeps the boundary the update check already states: the container
still has no host-root or Docker control. It records an approved target; root
agents on each host will pull it. The host pulls, the container never pushes,
which is how VM2's three polling timers have always worked.

**Back the database up before migrating.** `install.sh` restored the source tree
on a failed upgrade but never the database, and the migrations are forward-only —
so an upgrade that failed after migrating left a new schema with old code and no
way back. Survivable only because an operator was at a shell, which is exactly
what this feature removes.

- dump the database on the upgrade path before anything is staged, and abort the
  upgrade when the dump cannot be trusted: gzip readable, content non-empty, and
  pg_dump's own end marker present
- read the password inside the container from its mounted secret rather than
  passing it through `docker compose exec -e`, which would put it on the host's
  process list for the length of the dump
- keep the newest three dumps by modification time, not by filename — `v10.0.0`
  sorts below `v9.0.0`, so a lexical pruner eventually deletes the newest
- stop `exec`ing into the host installer when a dump exists: `exec` replaced the
  process holding the only pointer to the dump, so the one run that most needed
  to print a restore path could not
- add `docs/DATABASE_RESTORE_RUNBOOK.md`, and a test that proves the restore
  command in it actually brings a deleted row back

**Record an approved release.** A `PlatformReleaseTarget` singleton holds the
version an administrator approved and the commit it resolved to, so what is
applied later cannot move underneath the approval.

- approve and withdraw from Settings → Application, behind `readiness:approve`,
  with the pinned commit, the approver and the time shown on the panel
- resolve the tag to a 40-character commit at approval time, refuse anything
  that is not a release tag, and refuse a downgrade
- leave the unauthenticated update check unchanged: the target names an
  administrator, so serving it there would have made that identity readable
  without a session, and a test pins that route against it
- say plainly on the panel that a target is recorded rather than applied

## v5.2.2 — 2026-08-15

Repairs the CI gate that v5.2.0 broke, and the reason nobody noticed.

`scripts/test-agentic-installer-recovery.sh` sources the VM2 installer and signs
a real heartbeat with it, then rebuilds the expected message by hand. v5.2.0
added the method and path to the signed message on both the control plane and
all three client signers, but not to this test's hand-built copy, so the
installer signed five fields while the test verified three. It needs `jq`, which
the development workstation does not have, so the break was invisible locally.

The reason it would not have failed loudly even then is the more useful finding:
the test's `openssl pkeyutl -verify` assertion could never fail. On OpenSSL
3.0.13 that command prints "Signature Verification Failure" and **exits 0**, so
running it under `set -e` asserted nothing. It has been decorative in every
release that shipped it; only the node-based check beside it was ever real.

- pass the method and path through the recovery test's signer and both of its
  verifiers, so the shell signer and the control-plane verifier are compared on
  the bytes they actually exchange
- read the openssl verdict from its output rather than its exit code, and say in
  the file why the exit code cannot be trusted

## v5.2.1 — 2026-08-15

The residue a post-release sweep found: three user-visible strings still naming
surfaces that no longer exist, and two structural leftovers no gate could see.

- rename the locked-service messages that told operators "Governed tooling" and
  "Hermes corpus" services were unavailable, neither of which has been a tab
  since v5.1.0
- name the actual screen when Skills or Memory fails to load, rather than the
  storage mechanism behind both
- delete `packages/knowledge`, which had lost its manifest at v4.6.0 and
  survived as two orphaned tsconfigs that pnpm, the version check and the
  Docker closure check all silently skipped
- declare `*.svg` as `eol=lf`, so a generated asset cannot read as brand drift
  on a checkout with `core.autocrlf` enabled

## v5.2.0 — 2026-08-15

A twelve-lane read-only audit of the whole tree, and the repairs it found. Three
patterns account for most of it: a rule implemented more than once and drifting,
a control built and never wired to anything that reads it, and a gate that had
quietly stopped being able to fail.

**Enrollment is a breaking change for already-enrolled nodes.** The signed
message now binds the HTTP method and path as well as the body, so any VM2
enrolled before this release will be refused with 401 on every heartbeat until
its installer is re-run. Before, the runtime and corpus desired-state polls both
authenticated over an identical `null` body, so one poll's signature was
byte-valid on the other endpoint.

- refuse a session still holding the installer's temporary password on the agent
  and chat routes, which accepted one and would flip the execution kill switch,
  activate a profile and run a real turn; the gate is one shared helper now, and
  a test fails if any module resolves a session without it
- require HTTPS for Agentic System enrollment on every target rather than only
  PRODUCTION, exempting loopback, so a pilot install no longer prints a
  `curl … | sudo bash` command over a channel anyone on the path can rewrite
- bind the method and path into the node request signature across the verifier
  and all three client signers, and pin the five implementations against drift
- refuse a link-local destination in connection diagnostics; private and
  loopback endpoints stay allowed, because they are what this product connects to
- reconcile abandoned agent runs server-side, ending a conversation that used to
  hang forever and then refuse every further message for 65 minutes
- end a run whose worker restarted as `HERMES_RUN_DETACHED` rather than a generic
  failure, naming the divergence between the visible transcript and the Hermes
  session that still holds the exchange
- derive inference, Hermes and runtime-node readiness once and share it, so the
  Dashboard can no longer report a deployment ready while Setup blocks it
- ignore the disabled connection a revoked node leaves behind, which could pin
  the Dashboard on a dead runtime and make chat permanently unavailable
- fetch agent and tool metrics on every path that fetches chat metrics, instead
  of once at mount, leaving half the Dashboard blank after an in-app sign-in
- gate every Profiles write control on the scope the API requires, so roles that
  would be refused no longer see the controls
- stop Enter submitting mid-IME-composition, which sent a half-converted draft on
  every candidate confirmation in Japanese, Chinese and Korean
- keep the composer typable for the whole turn and give a submitted run a Stop
  button, and refuse a second submit dispatched in the same tick
- cancel the SSE reader on an unrecognised frame, which leaked a connection per
  retry, and bound the reconnect loop with a real error instead of retrying forever
- replace the one inline-style write with a class, and teach the CSP gate to see
  the `.style.` spelling it was blind to
- label every Dashboard figure with the window it measures, and count tool calls
  and run outcomes as their labels claim
- state what the prompt, approved-skills and readiness surfaces actually do
  today, none of which reaches the runtime
- make `pnpm verify` run the static gates and the CSP check it claimed to cover,
  and assert its own wiring
- fix gates that could not fail: the CSP check passing with no bundle to read,
  `--passWithNoTests` on two packages, the Operations tab collapse asserted
  nowhere, and a readiness test that compared a constant to itself

## v5.1.0 — 2026-08-15

Agents is four tabs and Operations is two. Runtime folds back into Profiles as
one workflow — may it run, what is defined, what each definition has done —
with the execution boundary leading because nothing below it can run while it
is off, and the run ledger scoped by the profile selected above it. Agent Tools
becomes Tools and loses the half of itself that governed a subsystem no code
path can reach: the MCP gateway, registry, grants, credentials and call ledger
are gone from the console, leaving a browsable list of what the runtime reports
and a two-click decision on each. A tripwire remains, so a release that ever
registers an MCP tool cannot revive the plane silently.

Release gates and the evaluation subsystem are removed outright — screen, API,
contracts, scopes, and the three activation-evidence constraints that made
models, prompts and guardrails demand evidence the console could no longer
produce. Two migrations drop the constraints, the columns and the table; the
half of each constraint that asserted `firstActivatedAt` survives under its own
name, because it was never about evaluations.

The Dashboard drops its dynamic masthead. A fixed title replaces a heading that
changed with readiness above a line restating the panel directly beneath it.

## v5.0.0 — 2026-08-15

Settings → Setup is a three-step wizard instead of six unrelated blocks and
nine buttons. Connect an inference server, install the agent runtime, create an
Agent Profile: one step open at a time, every blocker rendered inside the step
it blocks, and the VM2 hand-off treated as the fifteen-minute wait on another
machine that it actually is. Two enrolment traps the product never stated are
now stated — a second healthy inference connection removes the ability to
enrol, and a connection that tests healthy without a selected model cannot seed
anything.

Operations is three flat tabs rather than two tabs over four sub-tabs. Health
answers what is degraded now, Release gates answers what evidence an activation
carries, and the audit trail answers what happened. Pilot readiness is removed:
nothing in the product can create a readiness control, so the screen could never
show a row. Application updates move to their own Settings tab.

Agents becomes five tabs, one job each — Profiles, Runtime, Skills, Memory and
Agent Tools — and Agent Tools separates the two governance planes it had been
interleaving, stating each prerequisite beside the control it blocks.

The Dashboard draws the run pipeline, response outcomes and tool decisions that
every poll already carried and no surface rendered. The session composer grows
with its draft, the sidebar carries Settings as its last row, and record cards
across Operations are composed from the design system rather than left as
unstyled markup.

## v4.9.0 — 2026-08-15

The operator workspace now uses a single source-owned shadcn and Tailwind
foundation. Semantic theme tokens, cohesive semi-rounded geometry, Lucide
functional icons, and canonical controls now span authentication, dashboard,
sessions, agents, settings, and operations while preserving OrcaSynapse's
product-specific command surfaces and strict no-inline-style CSP.

Settings replaces the former Platform navigation and adds a governed platform
release panel. Administrators can check the configured upstream for newer
signed OrcaSynapse tags and initiate the existing host-controlled update path
without giving the browser arbitrary command execution.

Session presentation now uses a cleaner conversation rail, refined user
messages with an identity slot, a compact agent header and telemetry row, and
context usage at the composer. Shared dialog behavior is SSR-safe, traps focus
deterministically, and keeps the dependency-free crash boundary intact.

## v4.8.2 — 2026-08-14

Hermes-native sessions now retain the protected OrcaSynapse inference
credential after the first turn. Managed VM2 policy uses the literal `custom`
provider identity that Hermes persists during session restoration, while the
credential itself remains confined to the service environment.

Fresh-install and repair coverage now reject the obsolete named-provider form,
remove stale provider aliases, preserve unrelated providers, and execute two
consecutive native session turns through the stable `hermes-agent` route.

## v4.8.1 — 2026-08-14

Session provenance now condenses consecutive calls to the same Hermes tool into
compact expandable steps while preserving their chronological position. Each
group exposes a numbered per-call history with individual status, duration,
details, and errors, and continues to update as live SSE events arrive.

The activity trail now uses a quieter icon-led hierarchy, dotted sequencing,
and explicit step and call counts. Separate tools, later retries, failures, and
in-progress work remain distinct and visible instead of being over-grouped.

## v4.8.0 — 2026-08-14

Session now presents Hermes as a live agent workspace instead of appending an
opaque provenance panel after each answer. Agent identity remains visible,
reasoning and tool calls form a compact dotted trail at the point they occur,
legacy uncorrelated events are repaired in presentation, and terminal runs can
no longer leave historical activities marked as running. Response telemetry is
reduced to an icon-led row for copy, speed, token counts, first-token latency,
and end-to-end latency.

Inference discovery now recognizes LM Studio's HTTP-200 error payloads instead
of misclassifying them as SGLang, positively identifies vendor metadata, and
stops reading chunked JSON responses at the one-megabyte safety boundary. The
Vite development server now mirrors production routing for `/internal/v1`, so
locally enrolled VM2 nodes can reach the runtime inference gateway.

Fresh and repaired VM2 installations now bind the stable `hermes-agent` alias
to a named OrcaSynapse provider, retain inference credentials only in the
protected environment, and create the private Hermes configuration anchor that
activates the managed overlay without replacing an existing user config. The
desired-state client also keeps its runtime credential out of process arguments.

## v4.7.3 — 2026-08-14

The VM2 Corpus scanner now closes every Skill support tree over the exact
snapshot it signs. A parent `SKILL.md` may exist on disk but be intentionally
suppressed because it contains secret-like material or exceeds the mirror file
limit; its detached children are now suppressed with it instead of being
published as writable support files that VM1 must reject.

Regression coverage reproduces a redacted parent with ordinary and nested
support files, proves the entire orphaned tree is omitted, and preserves safe
read-only top-level metadata. VM1's strict topology validation remains intact.
Existing v3.17 nodes are repaired in place by rerunning the current generated
VM2 installer with `--repair`.

## v4.7.2 — 2026-08-14

The VM2 Corpus unit now activates only `CAP_SETUID` in the root coordinator's
ambient capability set. Exact production-unit probing showed that systemd kept
the capability in the bounding set but omitted it from the permitted and
effective sets, causing every native Python UID transition to fail with
`EPERM`. `CAP_DAC_OVERRIDE` and `CAP_SETGID` remain non-ambient.

The coordinator can now enter the Hermes service identity under the full
filesystem sandbox. Linux clears the child's permitted, effective, and ambient
capability sets when it leaves UID 0, preserving the unprivileged corpus scan
and mutation boundary. Existing v3.17 nodes are repaired in place by rerunning
the current generated VM2 installer with `--repair`.

## v4.7.1 — 2026-08-14

The VM2 Corpus companion now resolves the Hermes service account before
forking and uses Python's native numeric user, group, and supplementary-group
controls for scan and mutation subprocesses. This removes the opaque
`preexec_fn` failure observed under the hardened systemd unit while preserving
the root-only signing process and the unprivileged corpus filesystem boundary.

Regression coverage now exercises the complete credential contract and a real
root-to-service-user transition on POSIX. The fix was also verified under the
same capability and sandbox properties used by the production unit. Existing
v4.7.0 nodes are repaired in place by rerunning their generated VM2
installer with `--repair`.

## v4.7.0 — 2026-08-14

Agents now includes a repository-style observability plane for the native
Hermes corpus. Administrators can browse and lexically search allowlisted
memory and Skill files, inspect immutable revisions, and submit governed CRUD
changes while VM2 remains the canonical state owner and the mirror never
becomes model context.

A confined VM2 companion publishes signed, bounded snapshots and applies
signed expected-hash mutations through the pinned Hermes MemoryStore and Skill
APIs. Secret-like paths and content, native session storage, symlinks,
oversized files, stale snapshots, ambiguous Skill identities, and unsafe
idempotency replays fail closed. Destructive operations require approval from
a different administrator.

VM1 receives the stock-PostgreSQL migration, scoped API and audit surfaces,
and updated public documentation. Fresh VM2 enrollment installs the companion;
existing v4.6.0 nodes gain it through the generated `--repair` workflow.

## v4.6.0 — 2026-08-12

OrcaSynapse now has one agent-state authority: vanilla Hermes. Conversations
create and stream Hermes-native sessions, Hermes owns its transcript and
file-backed memory, and the control plane retains only the user-visible chat
projection plus sanitized lifecycle, tool, failure, evaluation, audit, and SIEM
evidence.

The duplicate retrieval, embedding, file-ingestion, control-plane memory, and
synthetic benchmark subsystems have been removed from contracts, API, worker,
web workspace, database, containers, installers, and dependencies. VM1 now uses
stock PostgreSQL 17 with a new `hermes-native-v1` schema epoch and refuses an
older populated database before mutation.

VM2 enrollment installs only the approved native Hermes runtime and validates a
real native-session turn. The public architecture, product requirements,
security guidance, installation runbooks, repository artwork, and handoff now
describe the same state ownership and clean-install boundary. The preceding
product generation remains preserved on `backup/pgvector`.

## v4.5.0 — 2026-08-12

Agent continuity is now Hermes-first. Session turns use Hermes' native session
stream without replaying the PostgreSQL chat projection, while vanilla
`MEMORY.md` and `USER.md` are the sole active agent-memory store. OrcaSynapse
continues to own document knowledge in pgvector and retains sanitized run,
metric, audit, and SIEM evidence without mirroring memory contents.

Native session lifecycle is preserved end to end: current-state forks use
Hermes' own branch API, deletion removes the authoritative transcript before
its local projection, and unsafe historical or missing-source forks fail
closed. The worker owns the upstream stream independently of the browser and
redacts native memory-tool content from operational events.

Fresh and repaired VM2 nodes now enforce built-in-only native memory alongside
the pinned runtime guardrails. Public documentation records the important
vanilla scope: transcripts are per session, but file-backed memory is shared by
sessions in the active Hermes home/profile, so this pre-production mode remains
one trust boundary. The prior pgvector-memory product state is preserved on
`backup/pgvector`.

## v4.4.0 — 2026-08-10

VM2 installation and recovery now keep the Hermes runtime inside its managed
state root instead of relying on `/home/orcasynapse-hermes`, so the hardened
service can start and execute runs without crossing its `ProtectHome` boundary.
Completed nodes can be repaired in place with `--repair`; the installer stops
an active managed runtime before reconciling its account, home, workspace,
policy, and unit, then restores service health.

Enrollment-provided heartbeat and desired-state paths are validated, persisted,
and consumed by runtime helpers, while legacy nodes retain compatible fallback
paths. VM2 smoke coverage now proves fresh installation, non-default control
plane routes, legacy-home migration, a completed real run, resume, and clean
decommission. The Session timeline also reports terminal run events as failed,
completed, or cancelled instead of leaving ended failures marked as running.

## v4.3.0 — 2026-08-10

The operator workspace now presents one cohesive, quieter interface from entry
through daily operation. Sign-in and recovery were simplified, the shared
dark/light control gained clear sun and moon states, Session received a modern
conversation rail and composer, and the authenticated Dashboard now follows the
same black-and-white surface system in either appearance.

Navigation has been refined into a steadier application rail: the white Orca
mark no longer sits inside a decorative box, expanded and collapsed states keep
the mark at one size, and the compact rail is thinner with calmer icon tiles and
more deliberate spacing. Component radii and panel boundaries are aligned
across the application, while public documentation and repository artwork now
use the current OrcaSynapse identity and agentic-intelligence description.

## v4.2.0 — 2026-08-09

Authenticated workspaces now keep the same clean surface as the Dashboard.

The shared synapse renderer and its workspace-only styling have been removed
from Knowledge, Agents, Platform, and Operations. The pattern remains reserved
for sign-in, boot, and fatal-error recovery, where it marks the boundary into
the application rather than competing with operational content.

## v4.1.0 — 2026-08-09

The route into OrcaSynapse and the Dashboard now speak one visual language.

Sign-in is reframed around a governed agentic harness and carries a persisted
dark/light switch. The shared static synapse field follows that contrast choice
across sign-in, boot, recovery, and non-Dashboard workspace views, while the
authenticated Dashboard intentionally keeps its cleaner violet control-room
surface. The Sivali orca mark is now the application favicon.

Startup now uses a branded, reduced-motion-aware entrance instead of a transient
lone spinner. The Dashboard itself is consolidated into one 1280×720
readiness-first war room: six operational metrics, the next repairable
capability, and the governed runtime path stay visible without the duplicate
lower sections, shortcut tiles, or suggested prompts. Readiness links retain
their exact destinations and signed-out states do not disclose subordinate
figures.

## v4.0.0 — 2026-08-09

Runtime activity can now meet the assistant text at the point where it happened.

The new pure CHAT-R5 interleaving primitive groups transcript activity at
content-offset-aware Markdown boundaries. It preserves the original entry order,
keeps events whose offsets are unavailable, and avoids coupling placement logic
to the rendered chat surface.

## v3.9.0 — 2026-08-09

Less text, more icons, and a rename that had only half happened.

Seven changes from a live review, all in one release because they are the same
edit repeated: say the high-level thing once, and let an icon carry what a
caption was carrying.

**Dashboard.** Three sub-texts removed — the next step under the title, the
"every answer is a governed run" line, and the paragraph explaining the governed
path. The panel states what a thing is and what it counts; the prose belonged to
a page, not a console. The blocking step is still named on screen, in the
required-capabilities list that owns it.

The four launch tiles and all six figures gained icons from the Relay set — the
same drawings the navigation rail uses for the same destinations, so a tile and
a nav row that lead to one place are not illustrated two different ways. The ask
row leads with Session's own icon instead of a generic node glyph beside the
word "ASK": the placeholder already says what the row is for, so the label was a
caption on a caption.

**Session.** The status strip under the composer is gone: a readiness chip
repeating the empty state's own heading, an identity the rail's foot already
carries, and a sentence about the architecture. The live case is not lost with
it — the pending row reports elapsed time while a run is in flight, which is
where a reader is already looking.

In its place, one standing line: *answers are generated and can be wrong or
incomplete; check the cited sources before you rely on one.* A governed run is
not a correct one, and the policy line said where the answer came from and
nothing about whether it is right.

The header's runtime cluster went from four elements across ~400px to two. Two
of the four said nothing alone — "Active default" and "—" are only legible if
you already know which is the model and which is the usage — and the token
figure is the same one the rail's foot states under a label.

The operator pane was set entirely in `text-caption`: 11px, the step for a dense
grid header and two below anything in the thread beside it. Four facts about who
you are and what you are pointed at were the tightest type on the screen, in the
corner an operator looks at to confirm exactly that.

### The Dashboard route never actually changed

`v3.5.0` renamed `#home` to `#dashboard` and the address bar kept saying
`#home`. `selectView` special-cased Overview to a literal string so it could
carry the pathname, which made it the one route the navigation table did not
own: the table was renamed, the literal was not, and the tests passed because
they exercise `pathForView` — which was right the whole time. Every view now
goes through it.

**0 contrast failures in both themes on both screens**, measured on the running
application.

Not fixed: the two stacked bars above the thread are still 98px. Slimming the
chat header from 68px to 52px bought nothing, because its content was already
about 50px tall and the minimum was never binding. Reducing it needs the two
bars merged, not tightened.

## v3.8.0 — 2026-08-09

The band joins the panel, and the field stops shouting.

**The header takes the panel's colour on the Dashboard.** A page-coloured bar
across the top of a violet field reads as a lid on it. It is opaque rather than
transparent on purpose: the band is sticky, so it has to stay legible once the
panel has scrolled out from under it. Its label, theme switch and account chip
switch to white foregrounds with it.

That rule was written and had no effect. `.workspace-header--immersive` and
`.workspace-header` are both a single class, so neither wins on specificity and
the later one takes it — and the immersive rule was above. The class sat in the
DOM, the band stayed page-coloured, and nothing anywhere disagreed. Found by
reading `backgroundColor` off the live element and getting `rgba(16,16,20,.92)`
where the token says violet.

**The square grid and the synapse network are both gone.** The field covered the
whole panel and was scaled with `slice`, which stretched a wide graph over a
tall surface: its edges became long diagonal scratches across the cards and its
nodes floated over text. It read as scaffolding drawn on the content, and a
second attempt — contained to the upper right, bowed, masked — did not earn its
place either. Both are removed rather than iterated on; a background motif
returns when there is a reference to build it against.

What remains behind the panel is the wash it always had: a violet-to-cyan
radial over the brand field, and nothing that competes with a figure.

**0 contrast failures across 129 nodes in both themes**, measured on the running
application rather than a static preview.

### The probe was wrong again, and this time it is fixed

The sweep skipped elements whose *own* `display` was `none` and measured
everything else — so the mobile brand wordmark, hidden by a `display: none` on
its parent, was scored as white-on-white and reported at 1.14. Elements with no
boxes at all are now skipped via `getClientRects()`, which is the question that
was actually being asked. Five such nodes on this screen.

That is four consecutive releases where an impossible reading turned out to be
the instrument: a stale dev build, a mid-transition colour, a markup dump older
than its stylesheet, and now an unrendered element. The tell is always the same
— a number that cannot be true — and it is worth suspecting the harness before
the product every time one appears.

## v3.7.0 — 2026-08-09

The Dashboard is one surface, and it launches sessions.

Three things merged into the command panel, and the screen lost two rows of
chrome in the process.

**The page header is gone.** Kicker, title, next step, the control-plane pill
and the primary action were a strip on the page background above the panel, so
the Dashboard opened with a band of chrome and only then reached the thing worth
looking at. They are the panel's own first line now, with the field running
behind them. The `h1` moved with them and is still the page's only level-one
heading.

**The panel meets the band.** `.workspace-header` carries 26px of bottom margin
for every other screen; at this one join it is cancelled, so the two surfaces
read as a single field rather than a header and a card beneath it.

**The ask bar is inside.** It was a card *below* the panel, which made starting a
session something you did after reading the console instead of the thing the
console is for. It is still a button drawn as a field rather than a real input —
nothing typed there could be answered there, and an input would promise
otherwise.

### The synapse field

A network at rest with signals travelling along it: eighteen edges, fourteen
junctions, five of which fire. Authored coordinates, never generated — a
background that re-rolls on every render is one nobody can review, and this is
meant to be the same picture every time. Stagger comes from `nth-child` rather
than an inline `style`, which `style-src 'self'` refuses in the container.
`prefers-reduced-motion` stops the traffic and leaves the network visible.

Measured after: **0 contrast failures across 118 nodes in both themes**, worst
4.68 dark and 4.87 light. One honest limit: the sweep composites background
*colours*, so it cannot see an SVG stroke passing behind translucent text. The
strokes are 1.6px at ~9% and 85% alpha behind cards that carry their own fill,
but that is reasoning, not measurement.

### Three times the artefact was not the product

Worth recording together, because they are the same mistake in three costumes.
`v3.6.0` was verified against `dist` while the dev server served a stale
Tailwind build. This release, the light-theme sweep first reported twelve
failures — the transitions trap again, because the preview page I rewrote had
dropped its `transition: none` block. Then it reported the ask placeholder at
1.30, which for white-on-violet is impossible: the markup dump was regenerated
*before* the fix and the stylesheet *after*, so the class no longer existed and
the colour inherited. Every one looked like a product defect and none was.

## v3.6.0 — 2026-08-09

The Dashboard opens on a command panel.

`v3.4.0` put the activity figures in a `HeroBanner` -- a card, the same shape
as every other row beneath it, so the screen an operator lands on read as the
first page of a report. This is a full-bleed field instead: the one surface in
the product meant to be looked at rather than read.

`.dashboard-hero` retakes the width `main > *` gives away (1380px, centred) and
re-applies the page's own horizontal padding inside, the arrangement
`.workspace-header` already uses to reach the edge. Deep violet, a violet-to-
cyan wash, and a faint survey grid masked toward the top.

**It does not theme.** Like the navigation rail's brand panel, this is a fixed
dark field: a command console that turns near-white in light mode stops being
one, and takes every foreground on it below AA on the way.

Left: what the deployment is and what it has done -- sessions with the window
they cover, documents with how many are indexed, then responses, profiles, tools
allowed and average response, and four tiles for the things an operator comes
here to start. Right: **the governed path**, drawn as the four hops a question
actually passes through, each with its real state and a live dot, over the verdict
("Every hop is answering" / "The path is not complete"). There is no map because
there is no geography in an on-premise control plane; the four hops are the
territory. A wall clock with seconds sits beside it, because an operations
console states the time it is describing.

Two things caught by measuring rather than looking:

- **`--node` on a field that does not theme.** The cyan shifts to a darker value
  in light mode, for light surfaces -- and on this always-dark violet it measured
  4.02:1. Exactly the trap `--accent` fell into on the hero fill last release.
  Pinned to the dark value inside `.dashboard-hero`, the way `.sidebar` pins
  `--accent-rgb` for the rail.
- Sub-captions at `text-white/45` measured 3.79. Raised to 60%.

Result: **0 contrast failures across 117 rendered nodes in both themes**, worst
4.68 dark and 4.56 light, and no horizontal overflow from the bleed (the panel
spans 0 to 1497 of a 1497px viewport).

The completed-share bar survived the rewrite deliberately. It has been lost once
before -- moving Home onto `HeroBanner` in v1.7.0 dropped the `fill` and
every test stayed green -- so it is drawn on the Responses figure, still only
when there are responses to divide.

## v3.5.0 — 2026-08-09

Home is Dashboard, Chat is Session.

The rename reaches what a reader sees and what they can bookmark: nav labels,
the strings that name the destination ("Open Session", "Finish the required
setup to start a Session"), and the routes -- `#home` -> `#dashboard`, `#chat`
-> `#session`.

It deliberately stops there. `ActiveView` still calls the screens `Overview` and
`Chat`, `chat-view.tsx` keeps its name, `.chat-page` keeps its class, and
`chatMessageTelemetry` keeps its export. Those are internal routing and module
names; renaming them would churn every view module, test fixture and stylesheet
rule for nothing a reader would notice, and would touch the eight pinned test
contracts from the thread rebuild. Two assertions now say so, so the next person
does not "finish the job".

**Old links still resolve.** `viewFromHash` already accepted several spellings
per view -- that is what makes renaming a route cheap -- so `#chat` joins
`#session` as a case. `#home` needed nothing: an unknown hash falls through to
Overview, which is where it already went. Without the alias, every existing
`#chat` bookmark would land silently on the Dashboard: no error, wrong screen.
Deleting that one line fails the new test, which is how it was checked.

## v3.4.0 — 2026-08-09

The landing banner reports what the deployment has done.

Third of three shell releases; the rename to Dashboard and Session follows.

It reported readiness -- the same fraction the callout directly above it already
carried, so the two loudest surfaces on the screen said one thing twice. It now
reports activity, from four metric sources that already existed: governed
conversations as the headline with the window it covers stated from
`windowStartedAt` ("Since 2 August"), then responses and how many completed,
documents and how many are indexed, agent profiles and how many are active,
tools allowed with their grant count, and healthy services.

The readiness fraction did not vanish with the old banner -- it moved onto the
callout that owns the subject, where it is a figure beside its own sentence
rather than the largest number on a page about something else.

Nothing here is invented. There is no user count in this product -- no user
directory, nothing counting distinct identities -- so there is no user count on
the banner, and a figure the deployment has not produced yet renders as an
em dash rather than a zero.

**The bar is drawn only when there is something to divide.** `completed /
responses` is 0/0 on a fresh install; a bar from that is either NaN or rounds to
something that reads as "everything succeeded" when the truth is "nothing has
been attempted".

### The accent block could not carry legible small text

Found by measuring the finished banner, not by looking at it. `--accent` is
`#9277F5`, tuned to read as an accent *colour* against a dark surface -- and
**pure white over it measures 3.40:1**. Not the 70% white the kicker used, or
the 80% the caption used: white itself, at full opacity, below AA. The design
system's signature hero block could not host compliant small text at any
opacity, on every screen that uses one.

New `--accent-fill` token: `#703DEF`, which is the light theme's own accent and
which white clears at 5.83. It deliberately does not theme -- like `--brand-rgb`
behind the rail, a fill that always hosts white has to always be dark enough to.
`HeroBanner` uses it for the accent block; `--accent` is untouched everywhere
else, so buttons, links and chips are unchanged.

Measured after: **0 contrast failures across 84 rendered nodes in both themes**,
worst 4.65 dark and 4.56 light.

Home can now be seen without a session -- it takes every figure through props --
so `HOME_PREVIEW_OUT` on its test writes the populated markup for a browser,
the same arrangement the chat transcript uses. That is how the accent-block
defect surfaced.

## v3.3.0 — 2026-08-09

The account moves to the top-right corner, and becomes reachable on a phone.

Second of three releases taking the shell toward the reference dashboard.

It lived at the foot of the navigation rail, inside `.operator` -- which carries
`display: none` below 760px, where the rail becomes a fixed bottom bar with no
room for it. **Sign out was therefore unreachable on a phone**: in the markup,
hidden by a rule written for a layout that cannot hold it, with no other way to
end a session. Moving it is the fix; the corner is where it belongs anyway.

It is now a chip in `WorkspaceHeader` -- initials, name, role, caret -- opening a
menu with the identity and Sign out. The menu dismisses on `pointerdown` rather
than `click`, because a click that begins outside and ends inside would leave it
open, and on Escape.

**The band renders in Chat now**, where it used to be hidden outright. That
rule existed because the page was one fixed-height block and a sticky band would
have pushed the composer off the bottom of the screen. `.chat-page` is a grid of
two rows instead: `auto` for the band, `minmax(0, 1fr)` for the thread. Not
`1fr` -- a grid row's default minimum is its content, so a long transcript would
grow past the viewport and reintroduce exactly the overflow the composer was
being pushed out of. The band's negative bleed margins, which exist to reach the
edge of a padded page, are cancelled here rather than the band being hidden.

`.operator` and `.avatar` are gone from the stylesheet entirely, along with the
two focus-mode rules that positioned the operator block in a collapsed rail.
`.mobile-brand` was sharing two of those selectors and keeps what it needs.

Verified against the built stylesheet: 8 of 8 focus rules inside the 761px
guard and 0 outside, `.chat-page` emitting `grid-template-rows: auto minmax(0,
1fr)`, the hide rule gone, and zero remaining `.operator` or `.avatar`
declarations. `measure.test.ts` pinned the old hide rule and now pins the
replacement, including why the row minimum is `0`.

Still unseen by eye, and `app.tsx` still has no test (#63) -- it now holds a
menu with the only sign-out in the product, which raises what that gap costs.

## v3.2.0 — 2026-08-09

The rail's width belongs to the operator.

First of three releases taking the shell toward the reference dashboard.

It used to be decided by the router: Chat collapsed the navigation rail and
every other screen expanded it, so it moved underneath whoever was using it on
every navigation and could not be set deliberately. Chat is still the screen
where collapsing pays most -- it brings its own conversation rail, and two
vertical lists before a word of the thread is what started this -- but that is a
reason to collapse it, not a reason to decide for someone. One preference now,
respected on every screen, persisted in `localStorage` by
`shell-preferences.ts`.

The collapse mechanism itself is unchanged and was already correct:
`.app-shell--focus` takes the rail 248px -> 76px, hides labels
*visually* rather than with `display: none` so every nav row keeps its
accessible name, and is guarded by `@media (min-width: 761px)` because below
that the rail is a fixed bottom bar with safe-area insets and has no width to
collapse. Only what drives the class changed.

**The mark became a tile.** Collapsed, the rail was 76px of icons with nothing
at the top to say whose product this is -- the wordmark is the only identity
there and it is the first thing a collapse takes away. A 44px filled tile reads
as the application at either width, so the rail keeps an anchor instead of
opening on a nav row.

The toggle lives at the foot of the rail, `aria-expanded` and with a label that
flips between "Collapse sidebar" and "Expand sidebar". It is hidden below 760px
under the same guard, where there is nothing to collapse.

Verified: 325 web tests including five new ones for the preference -- what is
written comes back, the default is never written as a second falsy spelling, a
value the module did not write is ignored, and storage being denied (private
window, hardened profile) returns the default instead of throwing during the
shell's first render, which would be a blank page rather than a wider sidebar.
The collapse rules were checked against the *built* stylesheet: 10 of 10 inside
the 761px guard, 0 outside, with the new toggle covered by both the centring and
the label-hiding rules.

Not verified by eye: `app.tsx` still has no test (task #63, deliberately
sequenced after this work), and the shell cannot be reached in the preview
harness without signing in. Typecheck, the preference tests and the built-CSS
inspection are what stand behind this release.

## v3.1.0 — 2026-08-09

A fresh install can hold a conversation.

Until now it could not. There was no agent profile anywhere in a new deployment
and nothing that created one, so Chat opened on "Setup required" and a Create
Agent Profile button: the product's central screen was unusable until an
operator wrote a system prompt into a blank box. Migration
`0028_default_agent_profile` seeds one, ACTIVE with an active version, so
`routeReady` is satisfied the moment a runtime is enrolled.

The prompt it seeds is the substance of this release. What the create form
offered before was two sentences -- "Provide concise, evidence-based answers.
Clearly distinguish retrieved facts from analysis and state uncertainty." --
enough to clear the schema's 10-character minimum and not enough to govern
anything. Nothing in it told the model to prefer retrieved material over its own
recall, which is the single thing a document-grounded deployment needs it to do;
an operator who accepted the default got an assistant that would answer from
training data about documents it was supposed to be reading.

`DEFAULT_AGENT_PROFILE` replaces it with 2,492 characters written for an
on-premise enterprise deployment, covering grounding (the corpus is the
authority, and "the indexed documents do not cover this" is a complete answer),
attribution (name the document; keep the line visible between what a document
states and what is inferred), sensitive material (respect classification, never
reproduce credentials found in a document even when asked), decisions (support
them, do not make them; refer anything with legal, regulatory or safety
consequence to the responsible human), form, and limits.

It lives in `@orcasynapse/contracts` and is used by both the migration and the
create form, so the two cannot drift -- `default-agent-profile.test.ts` reads
the SQL as text and fails if they do. `packages/database` gained
`@orcasynapse/contracts` as a devDependency for that test alone; there is no
cycle, contracts depends on nothing but zod.

Verified by applying migrations to a real database and reading the row back:
ACTIVE, activeVersion 1, 2,492 characters of instructions. Both the drift guard
and the migration snapshot chain were mutation-checked.

One detail worth recording: every literal is dollar-quoted (`$seed$`). The
prompt contains apostrophes -- "the organisation's own knowledge base" -- which
would close a single-quoted SQL string early and leave the rest as broken
syntax. That is a migration that fails on every install and is found only by
installing; a test now asserts the quoting.

## v3.0.0 — 2026-08-09

Zero WCAG AA failures on a populated transcript, in both themes.

`3.0.0` and not `2.10.0`: `v2.10.0` sorts *before* `v2.9.0` in a plain string
comparison. Same resolution as `v1.9.0 -> v2.0.0`.

v2.9.0 left 6 failures in dark and 3 in light. Chasing them found that one of
the nine was my own measurement, and fixing the measurement changed the answer:

**The contrast probe composited alpha wrongly.** Its `over()` returned `a: 1`
unconditionally, so two stacked `bg-warn/10` layers collapsed to fully opaque
warn -- and the approval badge's foreground and background came out identical, a
perfect 1.00 that read as the worst defect on the screen and was not a defect at
all. Replaced with real source-over, where alpha accumulates as
`f.a + b.a*(1-f.a)`. Validated on a known alpha stack: 10% warn over the dark
surface must resolve to `#221F1B`, not to warn.

With that corrected, and with hover-revealed metadata excluded because it is
invisible at rest, the true remainder was 1 in dark and 3 in light -- all on the
approval card, whose warn text sits on its own tint. Two tokens moved, each
solved against the surfaces actually measured in the page rather than assumed:

- `--warn` (light) `#8A6C22` -> `#70571B`. The amber that reads clearly on a
  dark surface came to 3.40 on a pale one.
- `--faint` `#85858B` -> `#86868C` (dark, a single channel step) and `#6B6C72` ->
  `#626268` (light), now including the warn card's tint in the solve.

Result across 100 rendered text nodes: **0 failures in either theme**, worst
ratio 4.51 dark and 4.56 light.

## v2.9.0 — 2026-08-09

The first release of the chat revamp that was actually looked at.

Everything from v2.6.0 onward was built blind, by agreement. This one put a
populated transcript in a browser -- via the static-preview harness, no sign-in --
and measured it. Three things that reading the source had not found:

**Nineteen uppercase nodes on one screen, not four.** The "kicker purge" in
v2.6.0 was counted by grepping for the `MicroLabel` component; fourteen of the
nineteen do not use it. The eight telemetry `<dt>`s under an answer were the
densest strip on the screen, the source classification called `.toLowerCase()` in
JavaScript and was then uppercased again by its class -- two opposite intentions
with the CSS winning -- and the footer set two sentences in capitals by reaching
for `StatusText`, which is uppercase by construction and right only for a status
chip. Now 7, and the survivors earn it: a date heading, three block labels and
two genuine failure states.

**`--faint` failed WCAG AA everywhere, in both themes.** 42 of 112 text nodes in
dark and 41 in light, and every single failure was that one token -- timestamps,
model aliases, counts, conversation previews, date headings. Raised to `#85858B`
in dark and `#6B6C72` in light, both solved for rather than guessed: worst case
4.61 and 4.52 against every surface each lands on. It is still the quietest step
in the ramp; it is no longer quieter than a reader can follow. Dark now fails 6,
light 3, and the remainder is the warn-toned approval card (warn text on a
warn/10 fill is inherently tight) plus hover-revealed metadata that is invisible
at rest anyway.

This is a whole-product change, not a chat one: every view gets more legible
secondary text.

**The measurement was wrong the first three times.** Nav rows and buttons carry
`transition-colors`, so `getComputedStyle` after flipping `data-theme` returns
interpolated values -- and it stayed wrong across separate round trips. The
unguarded sweep reported impossibilities: a plainly legible row at 1.09, a button
whose colour was correct reading as the other theme's foreground. Both numbers
were discarded. Injecting `transition:none!important` and forcing a reflow gives
stable, reproducible figures, and that is what the numbers above come from.

## v2.8.0 — 2026-08-09

Focus mode stops leaking onto phones.

v2.6.0 collapsed the navigation rail to 76px while Chat is active. Below
760px there is no rail to collapse: `.sidebar` becomes a fixed bottom bar with
`padding: 7px max(10px, env(safe-area-inset-right)) ... max(10px,
env(safe-area-inset-left))`. Every focus selector is `.app-shell--focus
.sidebar`, two classes against that layout's one, so specificity carried them
straight through the breakpoint no matter where they sat in the file. On a phone
in Chat the safe-area insets were replaced by a flat 8px, and the bottom bar's
labels were hidden -- icon-only in Chat and labelled in every other view.

All eight selectors now sit inside `@media (min-width: 761px)`, the same
breakpoint the bottom-bar layout uses.

Verified against the built stylesheet rather than the source, because the
question was whether the guard survives the build: Lightning CSS rewrites it to
`@media (width>=761px)`, and brace-matching that block finds 8 of 8 occurrences
of `app-shell--focus` inside it and 0 outside.

No test covers this and none could without a browser -- jsdom applies no
stylesheet, so a component test cannot tell a guarded rule from an unguarded
one. Same class of blind spot as the scroll metrics in `stick-to-bottom`.

## v2.7.0 — 2026-08-09

The last bordered card leaves the chat view.

The conversation rail's foot was a `Panel` wrapping a kicker, a value, a name and
two further bordered boxes carrying two more uppercase kickers -- three cards and
three kickers inside 200px, to state three facts: who you are signed in as, which
agent is bound, and what the conversation has cost. A hairline and a column state
them. `Panel` is now unused in `chat-view.tsx` entirely, which is the "eight
bordered surfaces, all the same weight" complaint closed rather than reduced.

It also carried a caption that had stopped being true. The agent row read
"Choose below" -- correct until v2.6.0 moved the profile picker up into the
header, after which it pointed at nothing. It reads "None selected" now. Copy
that instructs is copy that goes stale silently; there was nothing to catch it,
because no test asserts on it and it renders identically either way.

Filed rather than fixed: `app.tsx` still has no test of any kind (task #63, with
the mocks a first one needs). Typecheck is the gate, and it is a real one -- it
caught the JSX error that broke the shell during v2.6.0 -- but it cannot catch
a runtime render fault or a focus-mode regression. A pure-function test of
`activeView === "Chat"` would have been ceremony that cannot fail, so there isn't
one.

## v2.6.0 — 2026-08-09

Chat stops reading like an admin console.

The complaint was that it looked clunky next to Claude and Codex, and the cause
turned out to be structural rather than cosmetic. `ChatView` is one 1,614-line
function that renders the rail, header, empty state, transcript, tool cards,
approvals, sources, telemetry, composer and context panel inline; with no
component boundaries there is nowhere for hierarchy to live, so every surface is
a sibling and every surface competes. Four zones stacked to 783px of chrome
before a word of content, eight bordered cards carried the same weight, and eight
uppercase kickers named figures that needed no naming.

The worst of it was the reading itself. `.message-markdown` was **12px at
line-height 1.72** inside the 46rem measure -- about 120 characters a line. The
measure was corrected in v1.7.0 and the size was never raised with it, which
is why the answers still read as a wall. There is now a `read` step in the type
scale, 15.5px/1.65, registered in `cn.ts` (`cn.test.ts` enumerates the config, so
the drift guard covered it for free) and used by the transcript and its composer
and nothing else -- the dense tables in Operations and Knowledge keep `body` and
do not reflow. Markdown block rhythm scales with it, and tables inside an answer
lose the 9px uppercase mono headers that suit a data grid and not prose.

What else changed, in order of how much width it returned:

- **The context rail is gone, not moved.** 264px holding a read-only copy of the
  pinned sources, a button that opened the knowledge dialog, and a card of
  marketing copy -- most often showing "Open a conversation to see its knowledge
  scope". The header already carries `Knowledge · N`, which is both the count and
  the way in, and the dialog it opens is where the pins live and the only place
  scope changes.
- **Focus mode.** Chat is the one view that is itself a workspace, so the global
  nav rail collapses to 76px while it is active. 76 and not a true icon strip
  because sign-out has to stay reachable once the operator block stacks; labels
  go visually-hidden rather than `display: none`, because a rail a screen reader
  cannot name is worse than a wide one.
- **The empty state lost both configuration cards.** The agent-profile picker
  moved into the header, where it is one compact control instead of a bordered
  card with a label and a hint sitting in the middle of the greeting; it is only
  live before a conversation exists, which is exactly when the empty state was
  carrying it. What remains is the greeting, the blocking sentence, its button
  and the suggestions.
- **Agent activity folds when the turn lands.** Watching a governed run work is
  the point of the product; nine expanded rows above a finished answer, forever,
  is not. The list is a `<details>` whose `open` tracks the message's own status,
  so it unfolds as the run starts and folds when it completes -- and the new
  `summariseTimeline` names a failure while closed, because the risk of folding
  is a reader who sees one calm line and never opens it.
- **No rule between turns.** A hairline under every message made the transcript a
  table with rows; the user's bubble already says where an exchange begins.
- **The per-turn metadata header is hover-revealed.** Name, timestamp and model
  alias on every single turn was the densest thing in the transcript and the
  least read. It keeps its space so nothing shifts, and stays in the markup for
  screen readers. A status that is not `COMPLETED` keeps permanent ink.
- **The composer looks disabled when it is.** It was genuinely disabled and
  entirely normal-looking, with the reason living in placeholder text that
  vanishes the moment anyone types. The strip beneath it states the reason in
  words. The send arrow is an SVG rather than the literal character `↑`, and the
  keyboard hint and character counter appear on focus instead of permanently.

Chrome before content: 783px to roughly 350px. Four kickers of eight remain.

Found while working, and worth recording: `app.tsx` was left syntactically broken
mid-edit and **all 314 tests still passed**. Only `main.tsx` imports it, so the
shell has no test coverage at all and typecheck is the only gate on focus mode.

Not verified against a screen. The streaming behaviour in particular -- the fold
unfolding as a run starts -- has never been seen against a real Hermes turn.

## v2.5.0 — 2026-08-09

Two screens read one table and now agree on what a tool call is.

`toolCallKey`, `text` and `contentOffset` reached the event log in v1.9.0 and
only ever reached the *chat* contract. `agents.ts` described the same table
without them, so the run-detail screen listed every event separately -- four rows
for one call -- and could not have grouped them even if it wanted to, because the
fields were not on the wire. Two contracts for one table is how a fix lands on
one surface and silently misses the other.

The three fields are now on `agentRunEventSchema`, carried through the agents API
mapping, and the run-detail list renders through the same `groupRuntimeEvents`
chat uses: one entry per call, its own status, a step count when there is more
than one event, and duration from whichever event reported it.

Adding the fields immediately failed `agents/routes.test.ts` on a fixture that
did not carry them -- the type system reporting a fixture describing a run the
API can no longer return, which is the same class of drift this release exists to
close and the reason widening a shared schema is worth doing at the contract
rather than per screen.

This closes the last backend gap in the chat work. `maxTurns: z.literal(1)`
remains, blocking only CHAT-R8, which is deliberately out of scope for launch.

## v2.4.0 — 2026-08-09

A tool call is one thing in the activity list, not four.

The list rendered one row per event, so a single call that started, reported
progress twice and completed read as four unrelated entries -- and nothing told
a reader which progress belonged to which call, or that the second call had
failed rather than the first. `toolCallKey` was added to the event log in
v1.9.0 for exactly this and the interface had never used it.

`groupRuntimeEvents` collapses events sharing a key into one entry carrying the
call's own state: `failed` if a terminal failure arrived, `completed` if a
terminal success did, and `running` otherwise -- including for a call whose run
died mid-flight, where "running" is what the log records and inventing a failure
would be a claim it does not make. Entries hold first-appearance order, so a long
call stays where it began instead of walking down the list on every progress
report, which is what makes the list readable while a run is live. Duration comes
from whichever event reported it, and a tool name is taken from a later event
when the start did not carry one, which Hermes often does not.

**The fixture had no `toolCallKey` at all**, which is why every existing test
passed against an ungrouped list. It now contains a genuine two-event call, and
the assertion is `getAllByRole("listitem")` -- four events, three rows. Disabling
the grouping fails it with "expected length 3 but got 4", and fails four unit
tests besides. The neighbouring `getByText("knowledge.search")` became a grouping
assertion for free: it throws on multiple matches, so an ungrouped list now fails
there too rather than passing quietly.

This is the first piece of CHAT-R5. The interleaving of tool cards against the
answer by `contentOffset`, and the reasoning lane, are still to come.

## v2.3.0 — 2026-08-09

The chat thread layout, consolidated onto `main` with the five defects its
verification found repaired.

The layout itself: one shared reading measure across thread, composer, alert and
status, replacing four different widths (940 / 720 / 600 / 940); a scrolling
thread and a pinned composer as two zones; the four Dialogs moved to the end of
the root section so an open one can never add a grid row; delta pacing so a burst
of frames is released over several animation frames rather than in one lump; and
"Jump to latest" for a reader who has left the bottom.

Four adversarial lanes reviewed it before any of it came near `main`. They
cleared the two things that would have been serious -- no delta is ever split
(the server's resume is exclusive, so a partial delta duplicates text on
reconnect) and `flush()` drains synchronously at all three exits -- and found
five real defects, all fixed here:

- **`pinned` was written only by the scroll listener.** Content growing fires no
  scroll event, so a reader left behind by a batch taller than the 64px slack
  kept `pinned` true: the transcript correctly stopped following, but nothing
  ever offered the way back and following never resumed. Pacing made that the
  normal case rather than a rare one, since one commit can append a whole
  backlog. The follow effect now recomputes `pinned` itself.
- **`aria-live="polite"` covered the elapsed-seconds counter**, which a 250ms
  interval rewrites -- a fresh announcement four times a second for the whole
  run, which is the announcement storm moving it off the scroller was meant to
  end. It now sits on the activity text alone.
- **"Jump to latest" was anchored to the section with a guessed 92px offset**,
  which lands inside the composer as soon as the textarea grows. The thread zone
  now provides its own containing block, so the control ends where the composer
  begins at any height.
- **`usePacedStream`'s unmount cleanup cancelled the pending frame without
  draining**, so the hook did not honour its own documented contract. It only
  survived because the one caller happens to register a later cleanup that
  flushes -- an ordering nobody declared and any edit could reverse.

**A coverage gap, stated rather than papered over.** The `pinned` fix has no test.
Driving it needs `active.messages` to change, which in this harness needs a real
`sendChatMessage`; a test that triggered a re-render some other way would pass
without exercising the path. It is verified by reading the effect's dependencies,
not by a test, and that is weaker.

Branch consolidation: `worktree-wf_7bba5c8d-d93-1` is merged and deleted, and
`fix/worker-run-durability` was already an ancestor of `main` and is gone.
`backup-pre-squash-2026-08-09` and `codex/pre-ai-version-recommit` are left
alone deliberately -- `v1.8.0` is an ancestor of `main`, so the first is
pre-squash history whose content is already here, and merging either would
delete 21,200 and 271,140 lines respectively.

## v2.2.0 — 2026-08-09

The conversation rail is grouped by date.

A flat list of forty titles gives a reader nothing to navigate by; the date is
the only axis anyone actually remembers a conversation along. Rows now sit under
Today, Yesterday, Previous 7 days, Previous 30 days, then a heading per month,
with a trailing bucket for a conversation that was created but never sent to --
which has no last message and would otherwise be dated by `createdAt`, filing an
empty draft among real history.

The headings are level 3, deliberately. The rail's screen-reader-only `h1` is
what closes an open menu when clicked, and a second level-1 heading would make
that target ambiguous.

This wires up `groupConversationsByDate` from v1.9.0, which until now was the
one piece of that release nothing imported. Its buckets and boundaries were
already tested on their own; what this adds is a test of the *wiring*, because
correct buckets that no JSX consumes would have left every other test in the file
green. Removing the headings while keeping the grouping fails it.

## v2.1.0 — 2026-08-09

Scrolling up during a streaming answer no longer yanks you back down.

The transcript scrolled itself into view on every message change, which during a
streaming turn is several times a second. Scrolling up to re-read something got
you dragged back to the bottom before the sentence finished -- the single most
irritating thing about the old chat, and entirely unrelated to how fast the
stream was. It now follows only when the reader is already at the bottom.
Scrolling away is the reader saying they want to be somewhere else.

`scrollTop` on the container replaces `scrollIntoView` on a sentinel, because
scrollIntoView cannot ask the question: it moves whichever ancestor happens to
scroll and offers no way to know where the reader was first. The sentinel div is
gone with it.

The rule lives in `chat/stick-to-bottom.ts` as a pure function rather than inline
in the effect, and that is the substance of this release rather than a tidiness
preference. **jsdom reports every scroll metric as zero**, so a component test
exercises exactly one case and cannot distinguish a working rule from a missing
one -- the full suite stayed green through the entire change with nothing
covering it. As three numbers it is testable directly: at the bottom, scrolled
up, and either side of the 64px slack that absorbs fractional metrics and a nudge
of the wheel. Mutating it back to an unconditional follow fails two of them.

The zeroed-metrics case is asserted too, and pins to "follow", so the existing
render tests stay meaningful instead of accidentally green.

## v2.0.0 — 2026-08-09

**Why 2.0.0.** The minor digit runs 0-9 and then rolls into the major, so the
release after `v1.9.0` is this one rather than a tenth minor -- a rule worth
keeping because `v1.10.0` sorts *before* `v1.9.0` under any lexical sort,
including `git tag -l | sort` and the eye of anyone scanning the list. There is
a substantive claim behind the boundary too: `v1.9.0` and this release rebuilt
the chat read path end to end, and `listenForAgentRunWake` changed shape while
they did.

A streaming answer no longer re-parses itself on every token.

`MarkdownMessage` moves out of `chat-view.tsx` into `apps/web/src/chat/`, wraps
each parsed block in `memo`, and while a turn is in flight renders the settled
prefix and the live tail as two blocks instead of one. React reuses the prefix
untouched, so a delta costs the paragraph it lands in rather than the whole
document -- previously the cost of one token grew with the length of the answer,
which by the end of a long reply is the difference between text that flows and
text that stutters. It is the consumer v1.9.0's `splitStableMarkdown` was
built for.

A finished turn takes the single-block path unconditionally. That is not an
optimisation but a guarantee: completed content stays byte-identical to what one
ReactMarkdown produced before any of this existed, which is what the transcript
tests pin and what a reader is left looking at. There is one
`.message-markdown` wrapper regardless of path, because every markdown element
style is a descendant selector on that class.

The streaming path had no coverage at all -- every message the transcript tests
render is COMPLETED, so they only ever exercised a single block. Four new tests
render mid-stream content carrying a heading, a table and a fenced block, and
assert the elements survive the split, that a partially arrived table renders as
one table and never as a paragraph of pipes, that completed output is identical
across both paths, and that neither path emits an inline `style` attribute --
the CSP closure script checks built output only, so a streaming-only leak would
never reach it.

## v1.9.0 — 2026-08-09

The chat read path rebuilt end to end, so a turn can no longer end on top of its
own last events.

- **One writer at the moment it matters.** The SSE consumer writing
  `AgentRunEvent` rows ran concurrently with the poll loop that writes a run's
  terminal transition, and `cursor` is a `bigserial` claimed at INSERT and made
  visible at COMMIT — so an event still in flight landed *below* a cursor readers
  had already passed. Every terminal transition now drains the event stream
  first, and per-run cursor order is commit order.
- **The outcome is a row, not a second query.** Whoever finalises a run writes a
  `RUN_ENDED` marker inside the same transaction that flips the status, and a
  subscriber ends on that marker and on nothing else. The name is deliberately
  one Hermes cannot produce: it emits `run.completed` while the message row is
  still `PENDING`, so reusing that spelling would have closed the turn on an
  empty answer.
- **`stream_error` joins the event union.** The one frame whose job is to report
  a broken stream had bypassed the schema on both ends, typed by assertion and
  described by neither. Reconnects also drop from three seconds to one and
  resume from the cursor already held.
- **Push streaming, re-landed on a read path that can carry it.** The worker says
  "there is something now" the moment its transaction commits instead of every
  reader waiting out a 350 ms timer. The wake hub is a required constructor
  argument rather than an optional one that could ship inert behind a green
  suite; a failed first connect is no longer terminal; and there are three notify
  sites, all inside their transaction.
- **Delta coalescing tuned to 256 characters / 40 ms**, down from 1,024 / 100 ms,
  which is only affordable because a subscriber is now woken on commit. Pinned by
  a test that fails against the old bounds.
- `db:generate` works again. Migrations 0022–0026 were hand-authored and left no
  Drizzle snapshot, so generate diffed against 0021, found a dropped column
  beside an added one, and stopped to ask a human about a rename with no TTY.
  `AgentRunEvent` also gains `toolCallKey`, `text` and `contentOffset`, so a tool
  called twice in one run no longer stores unrelated events as one group.
- `splitStableMarkdown` and `groupConversationsByDate` land as pure units, built
  and pinned before the layout that depends on them.

## v1.8.0 — 2026-08-09

An audit of the design arc, and the navigation rail rebuilt against the design
reference.

- Ten agents swept the design releases across five dimensions and 71 findings
  were confirmed against the built bundle and a real browser; three more agents
  went over the repairs and found twelve problems in those.
- **A feature had disappeared and every test stayed green.** Moving Home's banner
  onto `HeroBanner` dropped `fill`, so the capability-readiness bar stopped
  rendering — `Metric`'s progress branch had no production caller left while the
  primitive's own test kept exercising it directly.
- **The light theme was broken on two surfaces previously claimed correct.** 163
  hex literals sat below the `[data-theme="light"]` block with no override, and
  `.connection-form input` put themed near-black text on a hardcoded near-black
  fill: **1.11:1**, which is to say an operator's typed connection URL was
  invisible. Every literal is now a token, measured after at 15.22:1 light and
  16.24:1 dark.
- **Six navigation icons, all wrong in the same invisible way.** The Relay set
  paints one cyan live node per glyph, so the active state had nothing left to
  tint, and five of the six were dispatched to the wrong area. The rail pins its
  own accent channels, so `text-accent` means the same violet under either theme.
- Chat was the one governed area that never checked a scope, while Knowledge and
  Agents asked for theirs; the check is symmetric now. Four locked screens are
  pinned as one table rather than four tests, because the property worth holding
  is that they agree with each other.
- Dead stylesheet rules proven against `dist/assets` rather than a source grep,
  which is how an earlier sweep kept a class that only matched a comment.

1,142 tests.

## v1.7.0 — 2026-08-08

The OrcaNeuron design system, end to end: tokens, the front page, the banner
primitive, Chat, and the dead-CSS sweep that closes the arc.

- **The token sheet is the design system's.** Dark stays the default, and a
  complete light theme arrives as `[data-theme="light"]` overrides of the same
  custom properties, so every utility and every legacy rule themes without
  knowing themes exist. New semantic tokens — `onaccent`, `soft`, `node`,
  `brand` — and themed shadows.
- **Typography changed families.** Plus Jakarta Sans sets body and kickers, Space
  Grotesk draws headings and figures, both vendored as latin variable woff2
  because `font-src 'self'` forbids the CDN the design referenced. Theme
  selection is applied from the entry module before React mounts, since
  `script-src 'self'` forbids the usual inline pre-paint snippet.
- **The front page is an entrance, not a workspace.** Signed-out users see the
  violet hero and a sign-in card carrying all four ways in, instead of the
  workspace shell with locked panels. The connection drawer sheds its sign-in,
  recovery and password-change branches; a new `AdminSignInDialog` owns elevation
  from inside the shell, because the person who meets a locked screen is an
  employee whose session opens Chat but not the governed areas. Both session
  probes are awaited, so no surface flashes the wrong page.
- **`HeroBanner`** is the banner every main screen opens with, and Chat takes the
  design's three-column shape — a conversation rail led by the one action it
  exists for, and an xl-only context rail stating what the conversation can see,
  read-only by design.
- Sixty-nine dead CSS rules left `styles.css`, each proven dead by a direct
  search before deletion, because the classifier that produced the candidate list
  cannot see a template-constructed class name.

## v1.6.0 — 2026-08-08

Three rounds of multi-agent audit, then a cohesion pass and two remediation
rounds over what it found. The theme of the second half is that the first half's
fixes were correct in code and wrong at the deployment boundary — the layer no
unit test can see.

- **No dialog in the product could be typed into.** The focus-trap effect
  depended on `onClose`, which every call site passes as an inline arrow, so it
  tore down and re-ran on every keystroke. That includes the VM2 installer
  generator, so enrollment could not be completed through the dashboard at all.
- **Ten concurrent document deletes deadlocked the API permanently** — a
  transaction holding one pooled client while the chunk delete beside it checked
  out a second, with waiters that never time out.
- **`LEARN_USER` was storing the model's own answers on the default path**, and a
  CRLF stream silently truncated an answer to its first delta while reporting
  success, after which the distiller wrote memory derived from a fragment.
- **`docker compose up` would have failed outright on any host with fewer than
  four vCPUs.** Per-service `cpus:` ceilings map to NanoCPUs and the daemon
  refuses container creation rather than clamping, so compose rolled the whole
  stack back. Replaced with `cpu_shares:` weights, which have no host bound.
- **Behind an upstream TLS terminator the session cookies carried no `Secure`
  flag**, because the bundled Nginx forwarded `X-Forwarded-Proto: $scheme` while
  listening on plain 8080. The scheme is declared by the operator now and
  recorded, so key rotation cannot silently undo it.
- Also, each with a regression test: the decommissioner destroyed Hermes
  installations it did not install; the resume path had never once been executed
  and aborted every resumed install on `set -u`; `validate_state_root` accepted
  `/var/`; the gateway key sat in `curl`'s argv every five minutes; deleting a
  document mid-ingestion resurrected it; a heartbeat consumed the operator
  concurrency token; and the desired-state timer lost its state root, reporting
  success while applying nothing.
- Not everything the audit reported was true. Two findings were refuted with
  probes and are recorded as refuted, because the verification is the point.

1,127 tests across 121 files.

## v1.5.0 — 2026-08-07 – 2026-08-08

Installer smoke tests, and VM2 running Hermes under systemd with the container
gone.

- **The VM2 installer runs in a test for the first time.** Every existing
  installer test *sourced* the script and exercised functions in isolation, so
  the sequence that installs dependencies, generates an identity, enrolls, writes
  the managed policy and preseeds the toolset allowlist had never been executed
  by anything. The decommissioner and the VM1 installer get the same treatment:
  every installer path in the repository now has an executing test.
- The recovery test **could not fail**. Sourcing the installer installed its own
  `trap cleanup EXIT` over the test's, so every assertion in the file after line
  10 had been decorative. It takes the trap back, and five mutations confirm each
  class of assertion is fatal.
- **VM2 runs Hermes as a systemd service.** The strong argument for the container
  was artifact identity, and a git commit is a cryptographic digest of the tree
  that — unlike a tag — cannot be moved to different code after review. So
  `hermesImage` becomes `hermesCommit` across the contract, the schema and the
  dashboard, and the Production gate requires 40 hex characters. Migration `0025`
  drops and re-adds rather than renaming, because every existing value names a
  runtime this release no longer installs. **Any currently enrolled VM2 must be
  revoked, decommissioned and re-enrolled.**
- The unit gives more than the container did, under an unprivileged service
  account. `SystemCallFilter=` is deliberately absent: a seccomp allowlist that
  is wrong fails the service at exec rather than degrading, and it is a follow-up
  with a test rather than a line added on faith.
- **The gateway key never enters the unit file**, which is 0644 by convention. It
  comes from a 0600 environment file whose `EnvironmentFile=` carries no leading
  `-`, so a missing file fails the unit rather than opening an unauthenticated
  gateway.
- Accepted costs, stated plainly: VM2's install-time egress widens, upstream's
  hash-verified lockfile tier fails at the pinned commit and falls back to a live
  resolve, and an air-gapped VM2 install is no longer supported on this path.
- **An LTS floor.** `require_ubuntu_host` read `VERSION_ID`, checked it was
  non-empty and never compared it. Separately, CI had been running three shell
  gates on a Node it never asked for.

1,034 tests, plus both installer lifecycles.

## v1.4.0 — 2026-08-07

A CSP gate that runs in CI, the installer terminal experience rebuilt, and the
defects only a first install exposes.

- **`scripts/test-csp-closure.sh`.** The container serves `style-src 'self'` with
  no `'unsafe-inline'` while the dev server sends no CSP header at all, so a
  violation works perfectly in `pnpm dev` and fails only in the built image. The
  gate reads the built bundle and fails on a runtime-built stylesheet, an inline
  `style` attribute, an off-origin asset URL, or a stylesheet naming a font that
  is not in the image. Each class was verified to fail the check by deliberately
  introducing it.
- **The installer TUI is rebuilt** — a braille spinner, status glyphs, step dots,
  slim meters and panels that align on a column — degrading in three independent
  steps, because an installer runs over serial consoles and inside cloud-init as
  often as in a modern terminal.
- **VM2 now arrives governed instead of converging later.** The installer wrote
  the desired-state reconcile timer and never ran it, so a freshly enrolled node
  sat on the tool-free baseline until the first tick, with no way for the
  operator watching to tell "not yet" from "not working".
- **VM2 declares the dependency its reconciler has always had.** The generated
  reconcile script uses a `python3` block that the installer never installed and
  never checked for; the required-command list now covers what the *generated*
  scripts run, not only what the installer itself calls.
- **The change-password screen signed the operator out while they were on it.**
  The 15-second session reconciler is gated on `unlocked`, which a forced
  password change makes false — so the one screen that asks someone to open a
  password vault was the only screen that never touched its session. A keepalive
  runs while the change is pending, and the route now tells an expired session
  apart from a wrong password.
- **The VM2 installer generator rendered as unstyled HTML**, the one file the
  design-system migration missed; both modals are rebuilt on `Drawer` and
  `Dialog`, which supply the focus trap and Escape handling the hand-rolled
  backdrop never had.
- **Two fixed costs removed from every chat message**: the worker is woken by a
  `NOTIFY` emitted inside the inserting transaction rather than by a one-second
  tick, and the embedding model is warmed at startup rather than inside the first
  message after a restart.
- `docs/CURRENT_STATE_HANDOFF.md` was materially wrong about the baseline, the
  test count, and whether `main` was pushed — the last of which matters, because
  an unpushed release is invisible to every install.

## v1.3.0 — 2026-08-07

Benchmarks, R1 through R5: the loop from authoring a suite to filing its result
as the evidence a promotion is gated on.

- **It does not duplicate the evaluation ledger, it feeds it.** `EvaluationRun`
  is a record an operator types in from a run they did somewhere else; a
  benchmark executes and produces those numbers, so the figure a release is
  approved on is not one anybody could have mistyped in its favour.
- **Three kinds, because the planes fail independently**: `CHAT_QUALITY`,
  `RETRIEVAL` and `MEMORY` break for different reasons, and one "is the AI good"
  number would hide which.
- **Nothing is judged by a model.** Every assertion is a plain string or latency
  comparison and each verdict is stored beside its case, which is what makes a
  deterministic score auditable rather than merely reproducible.
  `MUST_NOT_INCLUDE` is the only kind that states something an answer may never
  do, so breaking one is a critical failure whatever the pass rate says.
- **A chat case goes through the real agent path** — the same queue, profile
  version, retrieval and boundary checks a person's message goes through — and a
  benchmark **never writes to agent memory**, or the second run of a suite would
  score differently because of the first.
- Results are written after each case, so a suite that dies at case thirty still
  shows what the first twenty-nine answered; cancellation is checked between
  cases. `0023` and `0024` add the run's owner and the lease the document
  ingestor already had.
- **The screen states what a run means, not what its status enum says**: a
  completed suite that scored 0.5 against a 0.9 threshold reads *below
  threshold*. It polls only while something is running, and an auditor can read
  every result and start none of them.
- A suite can be authored, edited and deleted from the dashboard. Slug and kind
  are fixed once it exists, because past runs are filed under the slug and pinned
  to what the kind measures.

## v1.2.0 — 2026-08-07

The design system reaches every remaining view, preflight comes on, and the
fonts finally ship.

- Models, Prompts, Guardrails, Memory, Knowledge, the audit trail, Agents,
  Operations, Onboarding and Tooling all move onto the primitive set, each
  verified against a rendered preview rather than a diff, and each gaining its
  first tests in the process.
- **Two ways the system was quietly producing nothing.** The base reset wrote
  `border: 0`, which also sets `border-style: none`, and CSS then computes
  `border-width` to 0 whatever a later rule declares — so Tailwind's width-only
  `border` utility painted nothing on *every element*. And every opacity modifier
  on a theme colour emitted no rule at all, because Tailwind cannot decompose a
  hex held in a custom property: twenty-five tinted backgrounds and borders were
  missing that way, the class sitting in the markup with no declaration behind
  it. The palette is channel-first now.
- **Preflight is on**, which supersedes the hand-written universal
  `border-style: solid` that had been standing in for it, and the token test
  fails if it is ever switched back off.
- **Ship the fonts.** `--sans` had named Inter for fourteen releases with no
  `@font-face` behind it, so every screen fell through to whatever the operating
  system supplied. Inter and JetBrains Mono are now self-hosted latin variable
  cuts, because `font-src 'self'` makes a bundled file the only legal option, and
  `ui/fonts.test.ts` fails if a declared face has no file.
- The twelve-branch view ternary becomes a lookup keyed by the token the router
  already produces, with `satisfies Record<ActiveView, …>` closing the set — the
  chain had ended in a bare `else` that rendered Home, so a new view fell
  silently through to the wrong screen.
- The connection drawer stops carrying its own copy of the focus trap that
  `Drawer` was extracted from. The stylesheet ends the arc at **700 lines
  carrying 166 distinct colours**, from 2,020 lines and 754.

## v1.1.0 — 2026-08-07

A design system for the dashboard: tokens, primitives, Home, Chat, and one
locked screen instead of nine.

- `styles.css` carried **754 distinct hand-picked colours across 989 uses**, and
  there were no shared components at all — twelve views inlined every button,
  tile, card and modal, producing nine hand-written locked screens and five modal
  implementations of which one trapped focus.
- Tailwind 3 arrives with the tokens as CSS custom properties, so the stylesheet
  and the utility classes share one palette while views migrate a release at a
  time, alongside the primitive set in `apps/web/src/ui/`.
- **No Radix, and not by preference.** `style-src 'self'` refuses the inline
  positioning styles its Popper primitives write and the `<style>` element
  `react-remove-scroll` injects — and the dev server sends no CSP header, so both
  would have worked perfectly in `pnpm dev` and broken only in a built container.
  A metric's bar is a real `<progress>` for the same reason.
- **The design system had been deleting its own classes since the day it
  shipped.** tailwind-merge's colour matcher accepts any `text-` class, so every
  custom size was read as a colour and dropped by the colour beside it: the whole
  type scale was inert everywhere, with the class simply absent from the DOM and
  nothing logged. The dependency was also on the line built for Tailwind 4
  semantics, which was silently removing `focus-visible:outline` — no button in
  the dashboard had a focus ring.
- **Nine locked screens become one.** A person who lost their session saw nine
  slightly different explanations of the same thing, across three marks, five
  button labels and four layouts. Not every locked area wants an administrator,
  so the primitive states what the area actually needs.
- Chat's four dialogs were never dialogs — `role="dialog"` with no `aria-modal`,
  focus trap, Escape, scroll lock or focus restore — and the conversation menu,
  which holds Archive and Delete, had no way out at all. The transcript follows,
  with a preview harness that writes its rendered markup to a file so 200 lines
  of intricate CSS could be looked at rather than reasoned about.
- Memory's lineage reaches the screen. `records()` had **no lifecycle predicate
  at all**, so a corrected fact, a forgotten one and the current one were all
  returned together and rendered identically — an operator auditing what an agent
  knows was reading a mixture of current belief and everything it had ever been
  told.
- Back also works: navigation had written every route with `replaceState`.

## v1.0.0 — 2026-08-06 – 2026-08-07

Conversation-level distillation, forget-by-topic, a memory metric that names the
failing mechanism, and streaming inference.

- **Distil a conversation once it goes quiet, instead of after every turn.**
  Per-turn capture reads one message at a time and cannot resolve an arc — "I am
  moving to Bandung next month" and a later "the move is done" become two facts
  that contradict each other. Capture now waits ten minutes of quiet and reads
  the whole session in one call, stamping the conversation as read *before*
  distilling so a crash cannot loop on it, and rewinding that stamp when the
  model was unreachable.
- The migration that added the stamp defaulted it to null, which made every
  conversation ever held look like it owed a distillation; a follow-up marks the
  already-idle ones as read, so distillation starts from now rather than
  harvesting the archive.
- **"Forget everything about Project Titan", previewed before it happens.**
  Neither a `LIKE` nor a similarity floor answers a topic, so the owner's live
  facts are shown to the model against it. `dryRun` defaults to true, the blast
  radius is bounded, and a partial scan is reported as partial rather than
  presented as complete.
- **A memory number that says which mechanism is failing.** Six cases across five
  question types, each drawn from a failure that actually happened, scored by a
  judge that reads anything short of an unambiguous PASS as a failure. A case
  that could not be run is kept out of the score entirely, because counting it
  either way reports something untrue.
- The metric did its job on the day it shipped: "always answer me in Indonesian
  from now on" had never been captured at all, because two rules in the
  extraction instruction contradicted each other and a small model applied the
  prohibition.
- **Stream the inference calls, because some transports will not carry them
  otherwise.** A free tunnel kills any request whose origin takes longer than
  about 100 seconds; measured on the pilot, non-streaming returned 524 after 125s
  where streaming returned 200 after 400s.
- **Read the answer the model actually sends.** The same model on a different
  serving stack renames the fields — `type` for `scope`, a quoted sentence where
  an index was asked for — so on that stack every fact fell to the `EPISODIC`
  fallback and no correction was ever applied. Nothing would have looked broken.

## v0.9.0 — 2026-08-06

Agent memory becomes what it claims to be: extracted facts, in the third person,
with a profile and a version chain.

- **Stop storing whole turns.** Of 21 stored "memories" on the pilot, every one
  was a question, a command, a greeting, the model describing itself, or the
  operator's own system prompt — and recall embeds a new question, so the
  highest-scoring hits were the least useful rows in the store.
  `MemoryDistiller` extracts durable facts about the person after the answer is
  delivered, and a distiller that cannot be reached stores nothing rather than
  quietly reinstating the behaviour it replaces.
- **Keep extracted facts in the third person.** The pilot stored a first-person
  sentence, which reads later as the assistant describing itself. A fact opening
  with a first-person pronoun is dropped rather than rewritten, because a model
  that mis-attributed the speaker may have got the attribution wrong too.
- **A profile: the facts an agent is told regardless of the question.** Semantic
  search cannot retrieve a fact that resembles no question, so each fact is
  classified `STATIC`, `DYNAMIC` or `EPISODIC`, and an **ABOUT THIS PERSON** block
  is injected with no similarity search — bounded twice and trimmed a whole fact
  at a time, since half a fact is worse than one fewer.
- **Version chains: a corrected fact stops being recalled without being lost.** A
  similarity floor cannot decide this — "loves Adidas" and "prefers Puma" are not
  near-duplicates, yet one plainly retires the other — so the model decides,
  inside the distillation call already being made. Supersede and insert happen in
  one transaction, so no reader ever sees both as current, and candidates are
  shown numbered rather than by id.
- Three follow-ups the pilot forced: the distiller had no room to think, so a
  truncated answer read as "nothing learned"; supersession retired a near-
  identical episodic row while leaving the always-injected one live; and the
  chain columns were never populated at all.
- **CI goes green after 76 consecutive red runs.** `verify` typechecked before
  building, and cross-package types resolve through each package's emitted
  `dist/index.d.ts` — so on a fresh checkout, which is every CI run, the
  importing files' inferred types collapsed to `any`. It never reproduced on a
  development machine, because a leftover `dist/` satisfies the import.

## v0.8.0 — 2026-08-05 – 2026-08-06

Toolset admission, and a signed desired-state document the runtime actually
applies.

- **Toolset admission is the boundary that lets a runtime have tools at all.**
  Hermes executes its own tools server-side, so OrcaSynapse cannot scope an
  individual call — admission is the boundary available, which makes drift the
  thing to fail on. A run is refused when the runtime has a toolset enabled that
  nobody admitted, naming it. With nothing admitted this is exactly the zero-tool
  boundary it replaces.
- **The control plane gains a signing identity.** `ControlPlaneSigningKey` is an
  Ed25519 identity whose private half is sealed with the same envelope scheme as
  connection secrets. The document has to be *signed* rather than merely
  authenticated, because a node acts on it — anything able to answer the node's
  request could otherwise reconfigure it. It is carried base64-encoded and those
  exact bytes are signed, so a shell verifier on the node never has to reproduce
  a canonical JSON serialization.
- **VM2 consumes it**, which closes the loop from an operator's decision in the
  dashboard to what the runtime is running. The control plane's public key is
  pinned at enrollment, and a node that never received one applies nothing rather
  than trusting an unsigned document. An empty admission set is an instruction,
  not an omission.
- Admission becomes something an operator can see and decide, with drift raised
  as an alert rather than left to be inferred from failing chats.
- Two corrections found by watching the runtime rather than the config file:
  dropping the `no_mcp` sentinel re-enabled every globally enabled MCP server,
  and the sentinel alone does not govern a globally enabled toolset —
  `agent.disabled_toolsets`, subtracted after every other rule, is what produced
  the admitted set on the pilot.
- A cohesion pass collapses three copies of `canonicalize` into one, refuses
  signed bodies containing numbers (`JSON.stringify(1.0)` is `1` where jq emits
  `1.0`), and makes the secret-envelope version guard reachable.
- The safety argument behind consequential-call blocking is corrected: `maxTurns`
  is a boundary OrcaSynapse declares about its own profiles and never transmits.

## v0.7.0 — 2026-08-05

A readable chat transcript, administrable retrieval, and tool approvals.

- **Tell the two speakers apart.** User and assistant turns rendered as identical
  729px rows distinguished only by an avatar tint, so a transcript was a wall of
  text you could not scan. The person's turn is now a bounded card and the
  agent's is open content, the composer is aligned with the transcript, and six
  of the header's seven actions move behind one overflow menu — they had left the
  title 219px of a 912px column.
- **Surface what the runtime can actually do.** A new catalogue route reads
  Hermes's own toolset and skill endpoints — a live node reports 28 toolsets and
  67 skills, none of which the dashboard had ever shown — and states the policy
  plainly rather than leaving an empty screen to be interpreted.
- **Document retrieval becomes administrable**, closing an asymmetry: memory
  recall had a governed policy while knowledge retrieval was two constants in the
  worker. `knowledgeRecallLimit` and `knowledgeMinimumScore` join `MemoryPolicy`,
  defaulting to exactly the previous values.
- **Consequential tools can be approved instead of refused.** `invoke()` threw
  before any grant or human was consulted; it now records the call as
  `APPROVAL_PENDING` and opens a `ToolApproval`. No migration was needed — the
  table, the status and the TTL were all already in the schema, and only the code
  had been removed. Approval authorises the call and not the data, and the inline
  wait is capped at five minutes independent of the configured TTL.
- An approval nobody can see is a boundary nobody can operate, so a **Waiting on
  you** panel lists every blocked call with its exact arguments and when the
  decision lapses.
- **Stop reporting token usage the runtime never measured.** Hermes returns an
  all-zero usage block for providers that do not report it, and a completed run
  always consumes input tokens — so zeroes beside real output mean silence, not a
  measurement of zero.

## v0.6.0 — 2026-08-05

The audits taken before the next phase of work, and the shakeout a fresh
containerised install produced.

- **A coherence pass over the dashboard.** Four admin views stayed operable
  during a forced password change, so an administrator mid-change got a full
  workspace whose every request failed; one shared `adminAccess(session)` now
  derives what is usable and what it grants. Every admin view takes the same
  props, replacing two competing conventions, and 101 duplicate CSS rules across
  three copy-pasted blocks are merged.
- **Four high-severity advisories in shipped dependencies**, closed by pnpm
  overrides. `pnpm security:audit` had been a package script since the first
  release and was never wired into CI, which is why they went unnoticed; it is
  blocking now.
- **A fresh containerised install was unusable, and only building one showed
  it.** Both call sites constructed the embedder with no cache directory, so the
  library defaulted to a folder under `node_modules` that every shipped image
  makes unwritable — the first embedding failed with `EACCES` in any container,
  which left every chat turn `RUNNING` and every upload stranded in `CONVERTING`.
  It never showed up in tests, which run outside a container.
- **Three more the sandbox exposed**: uploads exceeded nginx's 60-second read
  timeout because the API loaded ~2 GB of weights and embedded inline; a crash
  mid-ingest stranded a document forever, since agent runs had lease reclamation
  and documents had nothing; and an air-gapped install could never embed
  anything, because the code had always claimed the model must be seeded at
  install time and nothing ever did the seeding.
- PDF ingestion gets its first end-to-end test, which immediately caught that
  moving extraction ahead of the insert made the recorded byte size read `0` —
  pdf.js takes ownership of the typed array it is handed and detaches it.

## v0.5.0 — 2026-08-05

Supermemory is removed, and agent memory returns on OrcaSynapse's own pgvector
plane under a governed policy.

- **VM2 now runs exactly one plane** — the Hermes runtime — and holds no durable
  data store of its own. Around 450 lines leave the VM2 installer, and the worker
  stops refusing every run on a remote memory plane's health, which had made a
  VM2 memory outage stop all agent execution.
- **`AgentMemory` mirrors `DocumentChunk`**: hybrid cosine and lexical recall
  over an HNSW index, with the (owner, agent) scope as a predicate inside every
  statement rather than a namespace handed to a service, so nothing a caller
  supplies can widen it.
- `memoryMode` on a profile version is the dashboard-facing choice of what an
  agent does — `DOCUMENTS_ONLY` by default, so an upgrade stores nothing about
  anyone until someone decides otherwise — materialized into run capabilities
  frozen onto the run, so editing a profile cannot change what an in-flight run
  may do. `LEARN_USER` stores the person's turn and never the model's output, so
  an answer the model got wrong once cannot become a durable fact.
- **`MemoryPolicy` is one installation-wide ceiling.** `maximumCaptureMode` caps
  every agent at once, and it is read at capture time rather than at submission,
  so suspending capture applies to runs already in flight. An active policy
  cannot be edited in place, because runs are being measured against it.
- **The whole policy becomes load-bearing.** `retentionDays`,
  `maximumItemsPerOwner`, `recallLimit` and `recallMinimumScore` were stored,
  documented and editable while the worker used hardcoded values and never
  stamped an expiry. `retentionUntil` is now stamped from the policy in force at
  capture, so lengthening retention later cannot retroactively extend what is
  already stored under a shorter promise.
- The person a memory is about can see and delete it: both the listing and the
  deletion take the owner from the authenticated session and never from the
  request. Remembered content stays out of the audit trail entirely — the trail
  records that memory changed, the reason and the count, never what it said.

## v0.4.0 — 2026-08-04 – 2026-08-05

Release engineering, one terminal experience for the installer family, and a
repository that tells the truth about the product it contains.

- **Fresh VM1 installability restored.** The `packages/knowledge` manifest is
  copied into the api and worker images so a frozen-lockfile install can resolve
  the workspace graph again, and compose runs postgres on a pgvector image
  matching CI, so the migrator can create the extension.
  `test-docker-build-closure.sh` and `test-release-consistency.sh` join CI as
  guards.
- **`scripts/lib/installer-ui.sh` becomes the canonical installer UI**, embedded
  verbatim in the self-contained scripts between markers, with
  `sync-installer-ui.sh --check` as the drift test. Role accents distinguish the
  scripts, VM1 becomes a six-step flow with preflight checks and a secret-free
  install log, and the remover carries its own `INSTALLER_VERSION` — a twelfth
  release surface the consistency test enforces.
- **The Business Source License 1.1** is adopted, converting to Apache-2.0 per
  release after four years, alongside SECURITY.md, CONTRIBUTING.md, this
  changelog, and issue and pull-request templates.
- The README and `docs/ARCHITECTURE.md` are rewritten for the real architecture —
  document knowledge in a local pgvector index, originals never retained — and
  the audit trail and SIEM forwarding are documented for the first time. The
  README gains a branded architecture diagram and a rendering of the installer's
  own output.
- Every install command shortens to the canonical `curl -fsSL` form, guarded in
  `test-release-consistency.sh` so the verbose spelling cannot return.

## v0.3.0 — 2026-08-04

The audit era: the trail written from every governed path became readable,
forwardable and observable.

- `GET /api/v1/admin/audit/events` behind the `audit:read` scope, keyset-paged
  with exact-match filters, and an Audit trail view under Operations.
- SIEM forwarding with a keyset cursor and at-least-once delivery, forwarding
  health reported as `HEALTHY`/`BEHIND`/`FAILING`/`NOT_CONFIGURED`, and an AI-Ops
  component that opens an incident when the destination rejects batches.
- Conversation-scoped knowledge: documents pin to a conversation
  (`ChatConversationDocument`, `AgentRun.knowledgeDocumentIds`), with a chat
  Knowledge picker and the dashboard's first jsdom interaction test.
- `SUPPORTED_DOCUMENT_TYPES` becomes the single source of truth binding the
  upload picker, the 415-rejecting upload route and the extractor.
- Onboarding becomes completable from the dashboard — architecture decision,
  component attestation and the activation control — and operations reaps stale
  executors on a timer. Dead code from the ORM and retrieval transitions is
  removed, including `ToolActionDispatch` and `DocumentMemoryPublication`.

## v0.2.0 — 2026-08-04

The Drizzle and local-knowledge era.

- Every manager, the worker and the inference gateway move from Prisma to Drizzle
  ORM against a structurally verified baseline migration, and Prisma is removed
  entirely. Data-layer tests run against real per-file migrated PostgreSQL
  databases.
- Enterprise document knowledge moves from Supermemory into a local pgvector
  index: `DocumentChunk` with 1024-dimension BGE-M3 embeddings, HNSW cosine
  retrieval, in-flight extraction, and originals never stored.
- Worker run durability is hardened: approval-state discovery, slot-based
  dispatch, honest shutdown, history-trim correctness and lease release.

## v0.1.0 — 2026-07-30 – 2026-08-04

The foundation series: the two-VM product took shape.

- VM1 control plane — Fastify API, React dashboard, worker, PostgreSQL via Docker
  Compose — with envelope-encrypted secrets, local administrator provisioning,
  the offline Installation Key and the public one-line bootstrap.
- VM2 Agentic System enrollment: Ed25519 node identity, one-time claims, signed
  replay-protected heartbeats, a digest-pinned Hermes container,
  checksum-verified Supermemory Local, a resumable recovery journal and the
  decommission flow.
- Governed Hermes-first Chat with durable Agent Runs, immutable Profile
  distributions, prompts, guardrails, model routes, the node-scoped inference
  gateway, operations/incidents/evidence, and OIDC enterprise access.
