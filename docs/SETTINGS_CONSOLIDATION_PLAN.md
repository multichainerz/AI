# Settings: one screen for people and their divisions

Status: **plan, not started.** Written at v8.8.1, against the navigation model as
it stands on `main`.

The ask, in the user's words: *"Settings, division and people should be under 1
management menu not a separate menu."*

Every claim below was checked against the tree rather than carried over from the
brief that requested this. Four things in that brief did not survive the check
and are recorded at the end, because they change what the work is.

## What is on screen today, measured

`apps/web/src/workspace-navigation.tsx` is the only source of truth for the
navigation model, and Settings is four tabs (`:166-171`):

| Tab | `ActiveView` token | Generated hash | View module |
| --- | --- | --- | --- |
| Setup | `Deployment` | `#settings/setup` | `onboarding-view.tsx` |
| Divisions | `Divisions` | `#settings/divisions` | `divisions-view.tsx` |
| People | `People` | `#settings/people` | `people-view.tsx` |
| System | `Application` | `#settings/system` | `application-view.tsx` |

The history is as the brief describes and holds: Settings was reduced to Setup
and System at v6.6.0 when Models, Prompts and Guardrails left for the new
Gateway area (`CHANGELOG.md:839`); Divisions was added at v6.8.0 (`:778`) and
People at v7.3.0 (`:626`).

*Superseded, kept because it explains the tab order.* `docs/DIVISIONS_PLAN.md:629`
predicted the row would read **Setup, System, People**. It shipped as **Setup,
Divisions, People, System**, which is a better order — the two access-control
tabs are adjacent — and nothing recorded the change. That is the whole problem
this plan addresses in miniature: the two tabs already belong together, and the
implementation knew it before the plan did.

Four tabs, but only two of them are one job. Setup is the bring-up sequence.
System is the deployment's own lifecycle. Divisions and People are a single
question — who is in the organisation and how they are grouped — split across
two screens that already read each other's data: `people-view.tsx:56` fetches
`getPeople()` and `getDivisions(false)` together, because the person form cannot
be drawn without the division list.

## The cost, measured

It is not tidiness. It is a round trip that discards work.

An administrator with "Ana starts Monday, she is in Finance" does this:

1. Settings → People → **Add person** (`people-view.tsx:161-166`) → types a name,
   a username and a temporary password → opens the Division select
   (`:202-209`) → Finance is not there.
2. Leaves for Settings → Divisions → **New division** → creates Finance.
3. Returns to People — and retypes everything.

Step 3 is the measurable part. `app.tsx:1414` renders through a closed lookup
(`satisfies Record<ActiveView, () => ReactNode>)[activeView]()`), so changing
tab swaps the rendered element and unmounts `PeopleView` entirely. The draft is
four `useState` values on that component (`people-view.tsx:41-44`), including
the temporary password. Nothing persists it, and nothing warns.

The reverse direction is signposted but no cheaper: creating a division answers
with *"Assign it a profile from Agents"* (`divisions-view.tsx:88`), which is a
different area again.

**Uncertain:** how often this actually bites. On a fresh install, divisions do
not exist and the first person is created before any of them, so it bites at
least once per deployment; after that it bites only when a new division appears.
Nobody has usage data for an on-premise product, so this plan does not claim a
frequency — the cost is stated as "the first person on every deployment", which
is verifiable, rather than "constantly", which is not.

## The shape — decided: one tab, one page, two sections

**Divisions and People become one screen with two panels, people first,
divisions second — and the division-create step moves inside the person form as
a dialog, so the round trip does not exist rather than being made shorter.**

Ordered that way because of what the administrator arrives holding. They arrive
holding a *person*; the division is an attribute that person needs. So the
screen leads with the people list and keeps divisions beneath it as the
vocabulary the form above draws on. It is also the shorter list — a deployment
has tens of people and a handful of divisions.

The two alternatives, and why they lost:

**A tab with its own sub-navigation — rejected.** It answers the letter of the
ask and none of it. Divisions would still be one click away from the half-typed
person form, and the click would still unmount it, so the retyping stays. It
also revives the exact pattern this repository deleted at v5.1.0:
`workspace-navigation.tsx:130-137` records Operations being collapsed out of a
tab holding four sub-tabs, *"the only three-level navigation left in the product
besides Setup"*. Rebuilding it two releases later needs a better reason than
tidiness, and there is not one.

**Master–detail, divisions as a rail with people filtered beside it —
rejected.** A person may have no division at all, and that is the normal state:
`people-view.tsx:202` offers *"Leave empty and they see only deployment-wide
agents"*, and every person is in none until somebody assigns one. A
division-first layout puts the majority of a fresh deployment's people inside a
"No division" pseudo-bucket, which makes the common case read as an exception.
It is also more layout than the ask needs.

What the merged screen holds, concretely:

- **One `MetricRow`, four metrics**, not the eight the two screens carry today
  (`people-view.tsx:171-176`, `divisions-view.tsx:146-151`): People able to sign
  in, Disabled, Divisions active, In a division. The three dropped — Local
  accounts, Suspended divisions, Assigned profiles — are all still readable
  where they matter: the per-division profile and people counts already sit on
  each division row (`divisions-view.tsx:213-216`), which is where an
  administrator about to suspend something looks. **Uncertain, and cheap to
  reverse:** if a fifth metric is wanted, "Assigned profiles" is the one to
  restore.
- **The people list**, unchanged in behaviour, including the per-row division
  select (`people-view.tsx:272-282`) and the deliberate absence of the reset
  control for a federated person (`:283-289`).
- **The divisions list**, unchanged, with its status and delete controls.
- **The closing note**, extended — see the copy section below.
- **A "New division" affordance inside the person form**, opening a centred
  `Dialog`. On save it creates the division, refreshes the list, and selects it
  in the form the administrator was already filling in.

The dialog is a `Dialog` and not a `Drawer` because `docs/DIVISIONS_PLAN.md`
(increment E) says so: a panel sliding in over the screen it serves covers the
thing it is explaining, which is why Setup's panels moved off the edge across
v6.0.1 and v6.0.3. *Recorded because it looks inconsistent:* both shipped
screens use inline `Panel` editors toggled by `showEditor`
(`divisions-view.tsx:153-194`, `people-view.tsx:178-218`), not dialogs. That is
not a violation — the prohibition was on the right-hand drawer, and a panel is
not one — but it means this plan introduces the first `Dialog` on these screens,
and it does so because the new form is *nested inside another form*, which an
inline panel cannot express without pushing the person form down the page mid-
edit.

## The name — decided: **People**

Three tabs: **Setup, People, System**.

Not "Management". It names the verb rather than the noun, and every
administration screen in this product manages something — Setup, System, Gateway
and Agents would all answer to it, so it distinguishes nothing. Worse, it reads
as covering administrators, agent profiles and models, and this screen manages
none of the three.

The alternatives considered:

- **"People and divisions"** — the most honest label, and it loses on a
  mechanical constraint worth stating: `workspace-navigation.test.ts:107-110`
  requires the rail's description to contain each tab label as a literal
  substring, so the tooltip would have to become *"Setup, people and divisions,
  and system updates"*. That is a worse sentence than the one that exists.
- **"Access" / "Access control"** — has precedent (it is already the `kicker` on
  both screens: `people-view.tsx:158`, `divisions-view.tsx:133`), but it reads
  as covering scopes, admin roles and sign-in, none of which live here.
- **"Organisation"** — implies deployment identity, branding, or tenancy
  settings that do not exist.
- **"Directory"** — implies a mirror of an external identity source. This
  product federates through OIDC and holds local passwords; "directory" would
  promise a sync that is not there.

**"People" under-claims rather than over-claims**, which is the safe direction,
and its one weakness is real: an administrator *is* a person, and this screen
does not list administrators. That is closed by copy below — and it is a gap the
tab already has today under the same name, so the rename does not create it.

**The rail description does not change.** `workspace-navigation.tsx:83` reads
*"Setup, divisions, people and system updates"*, which already contains all
three remaining tab labels and still names divisions, which the area still
holds. The existing assertion (`workspace-navigation.test.ts:93-100`) passes
unchanged. That is a property, not a coincidence: the area kept every capability
it had.

## Deep links — nothing breaks, and one thing is honestly lost

Addresses are owned by three tables in `workspace-navigation.tsx`: `areaByView`
(`:179-195`), `pathByView` (`:197-213`) and the `viewFromHash` switch
(`:257-393`). All three are `Record<ActiveView, …>` or exhaustive over it, so
removing the `Divisions` token is a compile error everywhere it is still
referenced — including the render lookup at `app.tsx:1414`. TypeScript, not
review, is what makes the removal complete.

What happens to each address:

| Address | Today | After |
| --- | --- | --- |
| `#settings/people`, `#people` | People | People — generated, unchanged |
| `#settings/divisions`, `#divisions` | Divisions | **People**, as a kept alias |
| `#settings/setup`, `#settings/setup/<step>` | Setup | unchanged |
| `#settings/system`, `#settings/application`, `#system`, `#application` | System | unchanged |

The alias is the pattern this file already uses four times over — `#agents/corpus`
lands on Skills (`:290-294`), `#agents/runtime` on Profiles (`:278-282`),
`#operations/releases` on Health (`:386-389`), `#platform/memory` on Memory
(`:304-307`) — each with a comment saying why the destination is the right one.
Here it is the strongest case of the four: the divisions screen is not
*absorbed*, it is on the page the link now opens.

**What is honestly lost:** `#settings/divisions` lands at the top of the
consolidated screen, not at the divisions panel. There is no fragment mechanism
— `viewFromHash` matches the whole hash, and the only sub-addressing in the
product is Setup's three steps (`setupStepFromHash`, `:252-255`), which exists
because a VM2 install takes twenty minutes and a reload must return to it. A
scroll position does not earn the same machinery. The plan's position is that
landing at the top of a screen that visibly contains divisions is a correct
destination, not a degraded one.

**No documented link is affected.** The only hash addresses written down outside
the code are `#settings/setup/runtime` (`deploy/BOOTSTRAP.md:69`,
`docs/AGENTIC_SYSTEM_ENROLLMENT_RUNBOOK.md:30`) and `#operations/audit`
(`docs/AUDIT_TRAIL_RUNBOOK.md:10`). Neither Divisions nor People is named in any
runbook, README or installer output. The exposure is operator bookmarks only,
and the alias covers those.

## The copy gap: administrators are deployment-wide

Nothing on screen says an administrator belongs to no division, and the reason
is a decision rather than an omission. Verified rather than assumed:

- `LocalAdministrator` (`packages/database/src/drizzle/schema.ts:1365-1381`) has
  **no `divisionId` column**, while `EnterpriseUser` (`:96`), `AgentProfile`
  (`:250`) and `ScopedMemoryEntry` (`:1442`) all have one.
- `profileVisibleTo` returns `true` for `ADMINISTRATOR_PREVIEW` before reading
  any division at all (`apps/api/src/agents/profile-visibility.ts:80`), and the
  comment above it says why: Agents → Memory and Agents → Skills are shared per
  node and *cannot* be filtered, so a division-scoped administrator would read
  what every other division's agent had learned.
- Administrators are not created from the dashboard in any case. The only writer
  of `localAdministrator` outside tests is
  `apps/api/src/auth/provision-local-admin.ts`, a CLI the installer runs.

The Divisions screen carries one sentence of this today
(`divisions-view.tsx:268-271`): *"Administrators are never bounded by a
division…"*. It answers "can I scope an admin?" and not "why is my admin account
missing from this list?", which is the question a screen named People invites.

**Proposed wording**, replacing that paragraph in the merged screen's closing
panel:

> **Administrators are not on this list.**
> An administrator is deployment-wide by design: they see every division and
> every screen, so there is no division to put one in and no administrator
> account on this page. Administrators are created by the installer on the
> OrcaSynapse host, not from here.
>
> A division bounds one thing — which agent profiles a person can see and run
> when they sign in. It is not an isolation boundary: agents on the same Agentic
> System node share their memory and their Skills, whichever division their
> profile belongs to.

Two properties that matter. It says what is *absent* and why, in that order,
because the reader is looking for something and not finding it. And it keeps the
existing non-isolation sentence verbatim rather than rewriting it — that
sentence is load-bearing (`docs/DIVISIONS_PLAN.md`, the "word tenant" note) and
`apps/web/src/connection-definitions.test.ts:31` asserts the product makes no
tenant-isolation claim.

## The two panels are gated differently, and one loader cannot fail for both

*This was an open question in the first draft — "check whether any role splits
these two scopes". It is now measured, and the answer changes increment A.*

The two screens are not behind the same permission, and the difference is not
symmetric:

| | Read | Write |
| --- | --- | --- |
| People | `sessions:manage` (`apps/api/src/people/routes.ts:47`) | `sessions:manage` (`:52`, `:65`, `:81`) |
| Divisions | `agents:read` (`apps/api/src/divisions/routes.ts:56`) | `agents:manage` (`:61`, `:74`, `:90`, `:107`) |

Against `ROLE_SCOPES` (`apps/api/src/auth/admin-session.ts:43-88`):

- **PLATFORM_ADMIN** — every scope. Sees and manages both.
- **SECURITY_ADMIN** — holds `sessions:manage` (`:51`) *and* `agents:manage`
  (`:59`). Sees and manages both.
- **OPERATIONS_ADMIN** and **AUDITOR** — hold `agents:read` and **not**
  `sessions:manage`. They can read divisions and cannot read people at all.

So no role holds one write scope without the other, which is the good half. The
half that matters: **two of the four roles can read divisions and are refused
people outright.**

Today that is survivable, because the two screens fail independently — an
OPERATIONS_ADMIN opening People gets an error and the Divisions tab still works.
After a merge it is a regression, because `people-view.tsx:56` loads both with
one `Promise.all`: a single 403 on `getPeople()` rejects the pair, and the catch
at `:60-67` renders *"People could not be loaded"* over a screen whose divisions
panel would have been fine.

**So increment A's loader is `Promise.allSettled`, and each panel renders from
its own outcome.** A refused people panel says so in its own words — the
operator is not permitted to see people, which is a true and stable fact, not a
load failure they might retry. The divisions panel beside it draws normally.

This is worth the extra care because it is invisible to whoever builds the
merge: a PLATFORM_ADMIN session — the one every developer signs in with — never
sees it.

## Increments

### A — merge the two views into one screen
*No API change, no contract change.*

`apps/web/src/people-view.tsx` absorbs `divisions-view.tsx`: one component, one
loader (it already fetches both, `:56`), one `MetricRow`, the people panel, the
divisions panel, the closing note. `divisions-view.tsx` is deleted rather than
left importable, so there is no second copy to drift.

Keep both screens' careful behaviours rather than re-deriving them: the
once-only password display and the copy that says so (`people-view.tsx:96-99`),
the absent-not-disabled reset for a federated person (`:283-289`), the delete
refusal that names what is in the way (`divisions-view.tsx:243-256`), and the
`expectedRevision` on every division mutation.

Files: `apps/web/src/people-view.tsx` (rewritten), `apps/web/src/divisions-view.tsx`
(deleted), `apps/web/src/app.tsx` (the lazy import at `:99` and the `Divisions`
entry at `:1352-1358` go).

**Done when:** every control both screens had exists on one screen and does the
same thing; the merged screen makes exactly the two GETs it made before, not
four; **a 403 on `getPeople()` still draws the divisions panel** — the
`allSettled` requirement above, and the one an administrator session cannot
reveal by hand; deleting `divisions-view.tsx` leaves no import. **1 day.**

### B — the nested division create
*The piece that removes the round trip, and the only genuinely new interaction.*

A **New division** control inside the person form opens a centred `Dialog` with
the same three fields the divisions panel uses (name, identifier, description,
`divisions-view.tsx:159-192`) and the same slug-follows-name behaviour
(`:167-173`). On success it refreshes the division list and selects the new
division in the person form beneath it.

The failure path is the part to get right: a division that fails to create must
leave the person form exactly as it was, with its password field intact. That is
the entire point of the increment.

**Done when:** an administrator with no divisions can create a person into a new
division without the person form losing a character — driven, not reasoned about;
a failed division create leaves the person draft untouched; the dialog is a
`Dialog`, not a `Drawer`. **1 day.**

### C — the navigation change and the aliases

- `ActiveView` loses `Divisions` (`workspace-navigation.tsx:17`).
- The Settings tab list becomes Setup, People, System (`:166-171`).
- `areaByView` and `pathByView` lose their `Divisions` rows (`:181-195`,
  `:197-213`).
- `viewFromHash` keeps `#settings/divisions` and `#divisions` as cases, now
  returning `People` (`:342-344`), with the comment saying why — matching the
  four aliases already above it.
- The rail description at `:83` is **not** touched; see the name section.

**Done when:** `viewFromHash("#settings/divisions") === "People"`;
`pathForView` has no `Divisions` case to call; `tsc` passes with no `Divisions`
token anywhere in `apps/web/src`. **Half a day.**

### D — the copy

The closing panel's wording, as proposed above. Sequenced after A because it
lands on the merged screen, and worth its own line because it is the piece most
likely to be dropped as "just copy" — it is the answer to a question the product
will otherwise be asked repeatedly, and the answer is a design decision nobody
can reconstruct from the screen.

**Done when:** the merged screen states that administrators are absent, why, and
where they come from; a test asserts it, so deleting it fails the build.
**Half a day**, including the test.

### E — the stale documents

Two places describe the tab set and both are already wrong, independently of
this work:

- `.cursor/rules/orcasynapse-conventions.mdc:24` — *"**Settings** (Setup,
  System)"*
- `docs/CURRENT_STATE_HANDOFF.md:27-29` — *"Settings (Setup, System)"*

Both were corrected at v6.6.0 for exactly this failure (`CHANGELOG.md:839`, last
bullet) and drifted again within two releases, missing Divisions and People
entirely. After this change they become correct by accident, which is not the
same as correct: they should be edited to say **Settings (Setup, People,
System)** and to record that divisions live inside People.

**Done when:** both files name the three tabs, and neither names a tab that does
not exist. **Half a day** — it is small, and it is listed separately because it
is the piece that gets skipped.

## Tests that will need to change

`apps/web/src/workspace-navigation.test.ts` is **the only file in the repository
that asserts the tab set** — verified by searching every `.ts`/`.tsx` for
`sectionNavigationFor` and for the literal `"Divisions"`. There is no e2e suite,
and `sidebar-layout.test.ts` asserts the rail's geometry and grouping, never its
contents.

| Test | Line | What changes |
| --- | --- | --- |
| *"gives the update check its own tab rather than a slot inside setup"* | `:262-285` | The literal Settings tab array loses its `Divisions` entry |
| *"says on the rail what each area actually contains"* | `:75-125` | Nothing. The description already contains setup, people and system |
| *"falls retired and unknown deep links back to the dashboard"* | `:127-131` | Add `#settings/divisions` → `People`, in a new test beside the other alias tests |

Two tests that do not exist and should, because a navigation change is exactly
when their absence bites:

1. **A divisions alias test**, in the shape of *"keeps a bookmarked corpus link
   pointing at a real screen"* (`:356-367`). Without it, deleting the two
   `#…divisions` cases leaves the suite green while every saved link silently
   redirects to the Dashboard — the failure mode that comment was written about.
2. **`people-view.test.tsx`, which does not exist at all.** Neither
   `divisions-view.tsx` nor `people-view.tsx` has ever had a test file. That is
   the real gap here: this plan proposes merging two untested screens, and the
   merge is precisely the operation that silently drops a control. At minimum
   the merged screen needs the assertions the copy and the shape depend on — the
   administrators note (increment D), the once-only password sentence, the
   reset control absent for a federated person, the division select populated
   from the loaded list, and **the divisions panel still drawing when
   `getPeople()` rejects with a 403** — the one failure a PLATFORM_ADMIN
   session can never produce by hand.

**And one that already should have existed.**
`apps/web/src/locked-screen-contract.test.tsx:44-96` pairs four screens' locked
promise with the button that fulfils it, and its own comment (`:79-84`) says a
screen added later *"joins the table on the day it arrives rather than after
someone notices it says something different"*. Divisions and People arrived at
v6.8.0 and v7.3.0 with the identical `LockedScreen` promise and the identical
*"Open platform settings"* button (`divisions-view.tsx:114-124`,
`people-view.tsx:139-149`) and neither joined. The merged screen should — one
row, and it makes the table five.

## What this does not do

- **It does not touch Setup or System.** Both are separate jobs from "who is in
  the organisation", and merging further would recreate the drawer that v6.6.0
  took Settings out of.
- **It does not add or change a permission.** The merged screen keeps both gates
  per panel rather than picking one. See the gating section above, which was an
  open question in the first draft of this plan and is now measured.
- **It does not fix the same problem in Agents.** `agents-view.tsx:616` hides a
  profile's division selector entirely when no division exists, with no pointer
  to where one is created — the same "leave to create the prerequisite" trap in
  a different area. It is a one-line copy fix and it belongs with whoever next
  edits that screen, not here.
- **It does not change any API, contract, route or table.** Every increment is
  in `apps/web/src`.

## Total

| | Days |
| --- | --- |
| A — merge the two views | 1 |
| B — the nested division create | 1 |
| C — navigation and aliases | 0.5 |
| D — the copy, with its test | 0.5 |
| E — the two stale documents | 0.5 |
| **Everything** | **3.5** |

Order: **A, C, B, D, E.** A and C together are the ask satisfied and are
shippable alone — one tab, no broken links. B is what makes the consolidation
worth doing rather than merely tidy, and it is easier to build against a merged
screen than a merging one. D and E are small and are the two that get dropped,
which is why they are named separately with their own Done-when.

## What contradicted the brief that requested this

1. **The Settings row is four tabs, not three.** The brief describes Divisions
   and People as *"sibling tabs under Settings"*, which is right, but the plan
   that predicted them (`docs/DIVISIONS_PLAN.md:629`) called for **Setup,
   System, People** and never mentioned a Divisions tab in the row at all. What
   shipped puts Divisions second and System last. The document was never
   updated, so the tab order has no recorded rationale anywhere — this plan is
   the first place it is written down.
2. **No documented deep link points at either tab.** The brief warns that
   *"existing links must not silently break"*, citing `#settings/setup/runtime`
   in `deploy/BOOTSTRAP.md`. That link is real and this plan does not touch
   Setup. Divisions and People are named in no runbook, README, installer output
   or CHANGELOG instruction — the entire exposure is operator bookmarks, which
   the alias covers. The risk is smaller than the brief assumes.
3. **The copy gap is wider than "nothing explains it".** The brief says nothing
   on screen explains that administrators are deployment-wide.
   `divisions-view.tsx:268-271` does say it — but on the Divisions screen, which
   is not where somebody looking for their own administrator account goes, and
   it answers a different question ("can an admin be scoped?" rather than "where
   is my admin account?"). The gap is the framing, not the absence.
4. **The two screens are not behind the same permission**, which the brief's
   framing of them as one job quietly assumes. People is `sessions:manage` end
   to end; Divisions reads on `agents:read` and writes on `agents:manage`. Two
   of the four admin roles can read divisions and cannot read people at all
   (`apps/api/src/auth/admin-session.ts:43-88`). They are still one job for the
   administrator who does it — PLATFORM_ADMIN and SECURITY_ADMIN both hold
   everything — but the merge has to survive a session that holds half of it.
   See the gating section above; it is the single highest-risk detail in this
   plan and it is invisible to whoever builds it.

And one thing the brief did not mention that changes the estimate: **neither
screen has a test file.** `divisions-view.tsx` and `people-view.tsx` have no
`.test.tsx` beside them and appear in no other suite. Half of increment D's cost
and all of the second test recommendation above exist because of that, and a
merge of two untested screens is exactly where a control disappears without
anything going red.
