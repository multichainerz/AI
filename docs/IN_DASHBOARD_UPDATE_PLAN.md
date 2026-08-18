# Updating VM1 and VM2 from the dashboard

The goal: an operator updates the whole deployment without opening a shell on
either machine. Not the same as unattended — a human still approves a specific
version; what goes away is SSH, not the decision.

## The rule this design does not break

`checkForPlatformUpdate` refuses automatic updates today for a stated reason:
*"The dashboard runs inside the application container and intentionally has no
host-root or Docker control."* That boundary survives here. The container never
executes anything on a host. It records an **approved target version** in the
database, and root agents on each host pull that target and act on it.

The host pulls; the container never pushes. VM2 already works this way — three
root systemd timers polling VM1 — so this extends an existing shape rather than
inventing one.

## What already exists

| Capability | State |
| --- | --- |
| VM2 signed desired-state channel, 60s timer, pinned control-plane key | built |
| VM2 installer pins Hermes by 40-char commit, stores `commit-pin` | built |
| VM1 unattended in-place upgrade (`ORCASYNAPSE_EXISTING_INSTALL_ACTION=upgrade`) | built |
| VM1 source rollback on failed install (`.backup.$$`) | built (increment 4) |
| VM1 database rollback on failed install | built (increment 4) |
| Release tag lookup and comparison (`platform-updates.ts`) | built |
| Database backup before migrate | built (increment 1) |
| **Down migrations / schema rollback** | **absent by design (forward-only)** |
| VM1 host-side systemd units | built (increment 4) |
| Approved-target record (VM1) | built (increment 2) |
| VM2 commit reconcile, health gate, and rollback | built (increment 3) |
| VM1 update agent, run history, and activity surface | built (increment 4) |
| **Approved-target record for the *Hermes* runtime** | **absent (increment 5)** |
| **VM2 reconcile outcome readable in the dashboard** | **absent (increment 5)** |

## The failure that shaped everything

`install.sh` backed up the *source directory* before replacing it — and
`upgrade_source_tree` deleted that backup the instant the swap succeeded, so the
EXIT handler's restore covered only the few milliseconds between the two `mv`
calls. Nothing restored the source after the handoff, and the handoff is where
migrations run. The database was not backed up by the swap at all, and the
migrations are forward-only. So:

- fails **before** migrating → the database is untouched
- fails **after** migrating → new schema, new code that could not start, and the
  pre-upgrade dump as the only way back — restored by an operator at a shell

Increment 1 made the dump exist. Increment 4 made both branches recover without
that operator; both are asserted by
`scripts/test-orcasynapse-installer-upgrade.sh`.

## Where the rollback lives, and why

**In `install.sh`.** It retains the pre-upgrade tree past the swap, restores it
when the handoff fails, restores the database when — and only when — the schema
moved, and then re-runs the restored tree's own installer so the deployment
comes back up. The update agent supervises, but does not own the retention.

The alternative was to have the agent take its own copy of the tree and drive
the restore. Three things decided it:

- **Only `install.sh` knows the instant of the swap.** A copy taken outside it
  is taken at a different moment and can disagree with what was actually
  replaced. The backup already existed at exactly the right instant; the whole
  change is to stop deleting it two lines later.
- **`install.sh` is run by humans, and that path is the one used during an
  incident.** Putting the rollback in the agent would leave the hand-run path
  exactly as dangerous as it was. Putting it in `install.sh` improves both.
- **The code that takes the backup is the code that restores it** — one process,
  one run, no version skew between the two halves. Note what this does *not*
  mean: the installer that runs is always the **target** release's, fetched at
  its commit, so a future release that removed the rollback would be unprotected
  on the way in. That is a property of any bootstrap fetched at the version
  being installed, and the agent inherits it; what removes the risk is that the
  rollback is asserted in the `install` job, which is required.

Two things follow, and both are asserted:

- `ORCASYNAPSE_UPGRADE_ROLLBACK=off` restores the old behaviour exactly, for the
  operator who wants the failed state left in place to inspect.
- The database restore is gated on a **schema fingerprint** taken beside the
  dump. The commonest upgrade failure by far is an image build that never
  reached the database; restoring a dump for one of those would discard every
  write taken while the build ran. What that gate cannot see is a data-only
  migration, which is stated in the runbook and overridable with
  `ORCASYNAPSE_UPGRADE_RESTORE_DATABASE=always`.

---

## Increment 1 — back the database up before migrating

Ship alone. Useful whether or not the rest is ever built.

- `install.sh`, upgrade path only: before the `migrate` service runs, take
  `docker compose exec -T postgres pg_dump` to
  `${ORCASYNAPSE_INSTALL_DIR}/.local/state/backups/<version>-<timestamp>.sql.gz`.
- Retain the last 3; prune older. Fail the upgrade if the dump fails — an
  upgrade that cannot be undone must not start.
- Record the dump path in the install receipt so a restore does not require
  guessing.
- Document the restore in `docs/` and print the path on failure.

**Done when:** an upgrade produces a dump, a corrupt/failed dump aborts the
upgrade before any migration runs, and the documented restore actually restores.

## Increment 2 — an approved release target

Records intent. Nothing acts on it, so it is safe to ship on its own.

- **Schema:** `PlatformReleaseTarget`, singleton row (`id = 'global'`), columns:
  `desiredVersion` (tag), `desiredCommit` (40-hex, resolved at approval),
  `approvedBy`, `approvedAt`, `revision`. Generated migration only — never
  hand-edited.
- **Contract:** `platformReleaseTargetSchema`; extend `PlatformUpdate` with the
  current target so one fetch drives the screen.
- **API:** `POST /api/v1/admin/updates/target` — requires an admin scope,
  resolves the tag to a commit through the existing GitHub lookup, refuses a tag
  that is not a release, refuses a downgrade, writes the row with an audit event.
  `DELETE` clears it.
- **Dashboard:** Settings → System gains "Approve <version>" beside the
  existing check, and shows the approved target with who approved it and when.
  (`Application` is the routing token that tab still uses internally, and has
  never been a name on screen.)
  While a target is set and not yet applied, the panel says which machines have
  taken it up.

**Done when:** approving a version writes exactly one row and one audit event,
a non-release tag and a downgrade are both refused, and the panel reflects the
target after a reload.

## Increment 3 — VM2 follows the target

Cheap, and its failure mode is recoverable: VM1 is untouched and the node can be
re-enrolled.

- Extend `runtimeDesiredStateDocumentSchema` with `hermesCommit` (the target the
  node should be running). The document is already signed and already carries
  `admittedToolsets`; this is one more field on the same channel.
- `desiredState()` emits the approved commit, falling back to the node's
  enrolled pin when no target is set.
- The VM2 desired-state reconciler compares the document's commit to its local
  `commit-pin`. When they differ it re-runs the installer at the new commit,
  then reports the result on the next heartbeat.
- The node must refuse a commit it cannot verify, and must not restart Hermes
  mid-run — drain first, matching the existing runtime service handling.

**Done when:** changing the target moves a real VM2 to the new commit in the WSL
bed, a bad commit leaves the node on its previous pin, and the heartbeat reports
which commit is actually running.

### What shipped, and the one thing this increment got wrong

The **channel is built** — everything above except the second bullet.
`hermesCommit` is a required field on the signed document, and
`hermes-desired-state.sh` verifies the signature, checks the document is
addressed to this node, validates the SHA is 40 hex characters *before* handing
it to a root install script, stops the runtime, installs with `--force-commit`,
reads the commit back off disk rather than trusting what it asked for, waits
90 × 2s for `/health`, and on any failure reinstalls the previous commit and
re-pins to whatever is actually on disk.
`scripts/test-agentic-desired-state-commit.sh` runs the real extracted script
against stubbed `curl`, `systemctl`, `git` and `sleep` and covers the install,
failure and rollback paths. The heartbeat reports the running commit — it sends
`commit-pin` verbatim, and that file is written only from a commit read back off
disk.

**The second bullet is a category error, and the implementation was right to
refuse it.** "The approved commit" here means `PlatformReleaseTarget`, which is
a commit *of OrcaSynapse*. Wiring it into the desired-state document would tell
VM2 to install this repository as though it were Hermes. The contract says so at
the field itself. So `desiredState()` resolves the enrolment pin, then the
node's last reported commit, then `DEFAULT_HERMES_COMMIT` — and there is no
approved-target source at all for the Hermes runtime.

That leaves exactly one gap between here and an operator who never opens a
shell. `hermesNodeEnrollment.hermesCommit` is **write-once**: it is set on the
`INSERT` in `createInvitation` and no `UPDATE` anywhere touches it. Node actions
are `DRAIN | RESUME | SUSPEND | REVOKE`, and `createInvitation` refuses a second
claim once `identityPublicKeyPem` or `enrolledAt` is set. So moving VM2 today
means revoke → new invitation → re-run the installer on VM2 by hand. Increment 5
closes it.

## Increment 4 — VM1 updates itself

The dangerous one. Built in two halves, the rollback first.

**Part 1, in `install.sh`.** The retention and the rollback described above. It
ships independently of the agent and improves the hand-run path on its own.

**Part 2, `scripts/orcasynapse-update-agent.sh`** plus
`orcasynapse-update.service` and `.timer`, installed by
`install-orcasynapse.sh`. VM1's first host units; they follow the conventions
`install-agentic-node.sh` uses for VM2's three.

- The agent reads the approved target directly from Postgres
  (`docker compose exec -T postgres psql` against the `PlatformReleaseTarget`
  singleton) rather than through a new endpoint. The host is already the trusted
  party — it has root and Docker — so this adds no authenticated surface and no
  new listener. The database password is read inside the container from
  `/run/secrets/postgres_password`; nothing puts it on the host's process list.
- It does nothing when the target is null or already installed.
- On a difference it downloads `install.sh` **at the approved commit** — the
  commit increment 2 resolved and stored at approval time, never `main` and
  never the tag, because a tag can be re-pointed after approval — and runs it
  with `ORCASYNAPSE_EXISTING_INSTALL_ACTION=upgrade`.
- It then health-gates against `/readyz` with a bounded wait.

The three self-referential traps, and how each is answered:

1. **The agent replaces itself mid-run.** It executes from
   `/usr/local/lib/orcasynapse/`, outside the tree the upgrade renames away, and
   `install-orcasynapse.sh` replaces that file by rename rather than by writing
   through the inode a running bash is reading. The upgrade itself is launched
   in a **transient systemd scope**, so it is in its own cgroup and stopping or
   restarting `orcasynapse-update.service` cannot kill it. The installer
   enables the *timer* and never starts the service, for the same reason.
2. **The API goes down during its own update.** The record carries the phase and
   `apiUnavailableUntil`; a reader seeing `upgrading` before that moment is
   looking at a restart, not a stall. The EXIT handler rewrites `upgrading` to
   `failed` on an abnormal exit, so no finished run is ever left claiming to
   still be going.
3. **The escape hatch is the thing being removed.** Two gates, not one.
   `install.sh` rolls back the failures it can see. The agent covers the one it
   cannot — a release that installs cleanly, returns zero, and then never
   answers `/readyz` — by performing the documented recovery from the backup
   record. Whatever fails, the reason is on disk in two places:
   `.local/state/last-update-agent.json` inside the tree, and
   `/var/lib/orcasynapse-update/last-run.json` outside it, where a source swap
   or a rollback cannot take it.

**Done, and asserted:** `scripts/test-orcasynapse-installer-upgrade.sh` (105
assertions, 8 scenarios) and `scripts/test-orcasynapse-update-agent.sh` (62
assertions, 11 scenarios), both in the `install` job.

**What is still not proven.** No application image is built in either suite, so
nothing here says the product boots on the new schema. The releases are staged
fixtures, not real tarballs. Nothing has run this against a real full
installation end to end — the first real unattended upgrade will be the first
one anybody has seen.

*The last item on this list has since closed.* The agent's record is no longer
only a host file: it writes `PlatformUpdateAgent` (singleton liveness) and
`PlatformUpdateRun` (one row per attempt, with `phase`, `detail`, `targetCommit`,
`installedCommit`, `rollback`, a truncated log and `apiUnavailableUntil`).
`GET /api/v1/admin/updates/activity` reads both under `readiness:read`, and
`platform-update-activity.tsx` renders them. `updateAgentPresence` reports the
agent missing or stale after an hour, so "installed and idle" no longer looks
like "not installed at all".

## Increment 5 — an approved Hermes target, so VM2 needs no shell either

The channel from increment 3 already carries and applies a commit. All that is
missing is something an administrator can write into it, and a way to watch the
result. VM1 reached that state at increment 2 + increment 4; this is the same
two halves for VM2.

**Schema: `HermesNodeReleaseTarget`, keyed by `nodeId`.** Not a mirror of
`PlatformReleaseTarget`, which is a `'global'` singleton — a deployment has one
VM1 and may have several VM2s, and each is pinned separately. The approval
columns do carry over: `desiredCommit` (40-hex, CHECK-constrained the way the
platform table constrains its own), `approvedBy`, `approvedBySubject`,
`approvedAt`, `revision`. `approvedBySubject` sits beside `approvedBy` for the
reason the platform table states: a federated approver has no `LocalAdministrator`
row, so the uuid alone cannot be resolved back to a name afterwards.

**Resolution: extend `recordedHermesCommits`, never bypass it.** The new target
goes in front of the enrolment pin, ahead of the reported commit and
`DEFAULT_HERMES_COMMIT`. The comment on that method is the requirement —
`desiredState` tells the node what to run and `list` tells the dashboard what to
expect, and if they read the pin differently the screen reports drift the node
was never asked to close, or hides drift it was. One implementation, two callers.

**Clearing a target is not neutral, and must not be labelled as though it were.**
Clearing re-resolves to the enrolment pin, so a node that has already moved
rolls *backward* to the commit it was enrolled at. That is a useful revert and a
poor "Clear". Name the control for what it does.

**API.** `POST /api/v1/admin/runtime-nodes/:nodeId/release-target` taking
`{ desiredCommit, expectedRevision }` — the same optimistic-concurrency shape as
`approveReleaseTargetSchema` — under `readiness:approve`, which is the scope VM1
approvals use rather than the `readiness:manage` the drain/suspend actions use.
Refused while the node is `SUSPENDED` or `REVOKED`. `DELETE` reverts. Audited as
`hermes.node.release-target.approved` and `.cleared`, following the dotted
lowercase convention (`hermes.node.invitation-issued`,
`platform.release-target.approved`).

**Reporting, and why VM1's shortcut is unavailable here.** The update agent
reads and writes PostgreSQL directly, through `psql` inside the postgres
container against `/run/secrets/postgres_password`, and increment 4 chose that
precisely to avoid a new authenticated surface. VM2 cannot do this: it is a
different machine, and the enrolment runbook's network allowlist denies it
PostgreSQL outright. So the reconciler's outcome has to travel on the signed
node channel — a `HermesNodeUpdateRun` row per attempt, reusing
`platformUpdatePhaseSchema` verbatim including `unknown`, which exists so a row
written by a differently-versioned agent renders as an unrecognised phase rather
than failing to parse. This is the screen an operator opens when an upgrade has
gone wrong; it must not be the second thing that breaks. The reconciler already
computes every field it would send — `COMMIT_RECONCILE_STATUS`, and the
`moving… / is now at… / restoring…` messages — and currently discards them.

**This one ships across two releases, and the ordering is forced.**
`hermesNodeHeartbeatSchema` is `.strict()`. A node that sends a field to a
control plane too old to know it is refused on every beat, goes stale, and is
marked OFFLINE. So VM1 accepts the new field in release *N* and the installer
teaches VM2 to send it in *N+1* — the same rule `units` was added under, stated
in the contract as a requirement rather than a preference.

**The open decision, which blocks the schema rather than the polish.** VM1
approvals take a *tag* and resolve the commit server-side, so a caller cannot
name a version and pin it to a commit of its own. Hermes has no equivalent tag
service, so this endpoint must accept a raw 40-hex SHA — and whoever holds
`readiness:approve` can then name any commit in the Hermes repository, which
goes to a root install script on VM2. VM1 is structurally incapable of that.
Three ways to answer it: an operator-maintained allowlist of approved commits,
typed confirmation of the node slug (the pattern the two-stage Remove flow
already uses), or accept it as an audit-attributed act. Settle this before the
migration is generated.

**Done when:** approving a commit moves an enrolled VM2 with no shell on it, a
bad commit leaves the node on its previous pin and says so in the dashboard,
clearing the target returns it to the enrolled commit, and `desiredState` and
`list` never disagree about what the node was told to run.

## Ordering and skew

VM1 first, VM2 second. The schema epoch (`hermes-native-v1`), not the version
number, is what actually gates compatibility, so a same-epoch skew is tolerable
for the minutes between the two. When the epoch changes, the target must refuse
to apply to VM2 until VM1 reports the new version.

## Testing

The largest line item, and the one that is usually underestimated. The existing
VM1 smoke test **refuses to run when an install already exists**, so it can
never exercise an upgrade.

`scripts/test-orcasynapse-installer-upgrade.sh` is the A→B harness, and it is
the precondition for increment 4:

```sh
sudo bash scripts/test-orcasynapse-installer-upgrade.sh
```

Root and a Docker daemon; no images are built and a run takes about 35 seconds.
It installs a control plane at version A through the real `install.sh`, seeds
rows, upgrades it to B with `ORCASYNAPSE_EXISTING_INSTALL_ACTION=upgrade`, and
asserts that the rows survived, that all four version surfaces moved together,
and that the pre-upgrade dump exists and — read out of the dump's own contents
— predates the migration. It then fails an upgrade *after* its migrations have
committed and drives the recovery in
[DATABASE_RESTORE_RUNBOOK.md](DATABASE_RESTORE_RUNBOOK.md) back to A. The
documented recovery is also the reset step between scenarios, which is how the
harness gets an installation back to A without tearing the database down.

Three limits, stated in the file at more length:

- **No images are built and no application container runs.** Nothing here says
  the application boots on B's schema.
- **Version B is a staged tarball**, differing from A in its version constant,
  commit, and migration set — not a real release. This proves the mechanism, not
  that two real releases are compatible.
- **The recovery used to be driven by the harness**, because nothing in the
  product performed it. `install.sh` performs it now, and the assertion that
  read *"install.sh restored nothing by itself"* has been flipped to assert that
  it did. What is left of the manual driver is the two cases nothing automates:
  deliberately downgrading a healthy deployment, and recovering from a run
  started with `ORCASYNAPSE_UPGRADE_ROLLBACK=off`.

`scripts/test-orcasynapse-update-agent.sh` is the same round trip driven by the
agent, with the approved-target row supplying the version. It adds the two
things the upgrade harness cannot reach: a release that installs cleanly and
then fails its health gate, and a direct proof that work launched in a transient
systemd scope survives its unit being stopped — with the un-scoped control run
beside it, because a marker that appears proves nothing unless the same marker
is absent when the scope is removed.

Every gate here follows the house protocol: write the test, watch it fail for
the stated reason, fix, then mutate the fix and watch it fail again. An updater
is the one feature where a vacuous test is worse than no test, because the thing
it fails to catch is the thing that removes your way back in.

## Decisions taken

- **Operator-approved, not unattended.** One click in the dashboard, no shell.
  An unattended path would turn a compromised release tag into root on both
  machines; keeping a human on the approval keeps that a deliberate act.
- **`install.sh` is fetched at the approved tag**, never from `main`. An
  automated path must not run a script from a moving ref.
- **The agent reads the database, not a new endpoint.** Fewer moving parts and
  no new authenticated surface on either host.
