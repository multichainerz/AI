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
| VM1 source rollback on failed install (`.backup.$$`, auto-restored) | built |
| Release tag lookup and comparison (`platform-updates.ts`) | built |
| **Database backup before migrate** | **missing** |
| **Down migrations / schema rollback** | **absent by design (forward-only)** |
| VM1 host-side systemd units | none exist |
| Approved-target record | missing |

## The failure that shapes everything

`install.sh` backs up the *source directory* and restores it automatically when
an install fails. It does not back up the database, and the four migrations are
forward-only. So:

- fails **before** migrating → recovers itself today
- fails **after** migrating → new schema, old code, no way back

Today an operator at a shell absorbs that. This feature removes the shell, so it
must not ship before the database can be restored. That is why increment 1 is
first and is independently valuable.

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
- **Dashboard:** Settings → Application gains "Approve <version>" beside the
  existing check, and shows the approved target with who approved it and when.
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

## Increment 4 — VM1 updates itself

The dangerous one. Do not start before increments 1 and 2 are shipped.

- New `scripts/orcasynapse-update-agent.sh` plus a systemd timer, installed by
  `install-orcasynapse.sh`. VM1 currently has no units of its own; this is the
  first.
- The agent reads the approved target directly from Postgres
  (`docker compose exec -T postgres psql`) rather than through a new endpoint.
  The host is already the trusted party — it has root and Docker — so this adds
  no authenticated surface and no new listener.
- On a difference it: takes the increment-1 dump, downloads `install.sh` **at
  the approved tag** (not from `main`), and runs it with
  `ORCASYNAPSE_EXISTING_INSTALL_ACTION=upgrade`.

Three self-referential traps, each of which has to be handled explicitly:

1. **The agent replaces itself mid-run.** It must execute from a copy outside
   the install tree (`/usr/local/lib/orcasynapse/`) and detach from the units it
   restarts, or it is killed partway through its own upgrade.
2. **The API goes down during its own update**, so the dashboard cannot report
   progress. The panel must say it is blind rather than appear stalled.
3. **The escape hatch is the thing being removed.** A health gate after the
   upgrade is mandatory: if `/healthz` does not answer within a bounded window,
   restore the source backup and the database dump, and record why.

**Done when:** an induced failure after migration restores both source and
database automatically, and the deployment comes back on the previous version
without anyone opening a shell.

## Ordering and skew

VM1 first, VM2 second. The schema epoch (`hermes-native-v1`), not the version
number, is what actually gates compatibility, so a same-epoch skew is tolerable
for the minutes between the two. When the epoch changes, the target must refuse
to apply to VM2 until VM1 reports the new version.

## Testing

The largest line item, and the one that is usually underestimated. The existing
VM1 smoke test **refuses to run when an install already exists**, so there is no
A→B upgrade harness today.

Needed: install v_old → set a target → run the agent → assert data survived,
assert the version moved, then induce a post-migration failure and assert the
rollback. The WSL bed (`OrcaSynapse-VM1`, `OrcaSynapse-VM2`) is the place for it,
and it needs a reset step the smoke test currently lacks.

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
