# Database Restore Runbook

The migrations under `packages/database/drizzle/migrations/` are forward-only
and have no down step, so once they have run there is no code path anywhere in
the product that returns the schema to the release it came from. The dump
described here is the only way back, which is why `install.sh` refuses to start
an upgrade it cannot take one for.

**VM1 now performs this recovery itself.** An upgrade that fails after the
source swap restores the previous release without an operator: read
[Automatic rollback](#automatic-rollback) first, because the most likely reason
you are on this page is to understand what already happened rather than to do
it by hand. The manual procedure below is still here, still correct, and is
what you need for the two cases nothing automates — deliberately going back to
an earlier release from a healthy deployment, and finishing a rollback that
could not finish itself.

## Automatic rollback

When `install.sh` is running the upgrade path and the handoff to
`scripts/install-orcasynapse.sh` fails, the installer:

1. **keeps the pre-upgrade source tree** it moved aside, instead of deleting it
   the moment the swap succeeded;
2. **compares the database schema** with the fingerprint it took beside the
   dump. If the schema moved, the forward-only migrations ran, and the dump is
   restored over them. If it did not move, the database is left exactly as it
   is — nothing that happened while the images built is discarded;
3. **puts the previous source tree back**, carrying the failed run's installer
   log into `.local/state/failed-upgrade-<timestamp>/` first;
4. **restarts the deployment** by running the restored tree's own installer, so
   the images match the source again;
5. **writes `.local/state/last-upgrade-rollback.json`** — outcome, reason,
   whether the database was restored, and the commits it moved between.

Read that file first:

```sh
sudo cat /opt/orcasynapse/.local/state/last-upgrade-rollback.json
```

`"outcome"` is one of `rolled-back` (done, deployment serving the previous
release), `restored-but-not-running` (files are back, the stack did not start),
`database-restore-failed` or `source-restore-failed`. The last three are where
the manual procedure below takes over.

### The one thing the schema comparison does not see

A migration that changes only **data** and no column moves nothing the
fingerprint looks at, so a failure after one of those restores the source and
leaves the data migrated. That is the deliberate trade: the alternative is
restoring the dump after every failed image build, which would throw away every
write taken during the minutes that build was running, on a deployment whose
data was never in danger. For a release known to carry a data-only migration,
force it:

```sh
ORCASYNAPSE_UPGRADE_RESTORE_DATABASE=always
```

### Turning it off

An operator who wants the failed state left in place to look at:

```sh
curl -fsSL https://raw.githubusercontent.com/multichainerz/AI/<tag>/install.sh \
  | sudo ORCASYNAPSE_UPGRADE_ROLLBACK=off \
      ORCASYNAPSE_EXISTING_INSTALL_ACTION=upgrade bash
```

That restores the pre-rollback behaviour exactly: the new source stays, the new
schema stays, the dump is on disk, and the panel names it. Everything from
"Finding the dump" onwards then applies.

### When the update agent drove the upgrade

`orcasynapse-update.timer` runs `/usr/local/lib/orcasynapse/orcasynapse-update-agent.sh`,
which records what it did in two places — one inside the installation and one
outside it, because a source swap or a rollback can take the tree with it:

```sh
sudo cat /var/lib/orcasynapse-update/last-run.json
sudo journalctl -u orcasynapse-update.service --no-pager -n 200
```

`"phase"` is `idle`, `upgrading`, `verifying`, `recovering`, `healthy`,
`rolled-back` or `failed`. A record reading `upgrading` is not a stalled
machine until `"apiUnavailableUntil"` has passed — the API is expected to be
unreachable while it is replacing itself.

The agent has one recovery `install.sh` cannot perform: a release that installs
cleanly, returns zero, and then fails to answer `/readyz`. By then `install.sh`
has discarded its retained tree, so the agent performs sections 2 and 3 below
itself, using `fromCommit` out of the backup record.

## What the installer takes, and when

On the upgrade path only — `ORCASYNAPSE_EXISTING_INSTALL_ACTION=upgrade`, or
option 1 at the interactive prompt — and before a single file has been staged,
`install.sh`:

1. runs `pg_dump` inside the running `postgres` container and gzips the result
   to `${ORCASYNAPSE_INSTALL_DIR}/.local/state/backups/<version>-<timestamp>.sql.gz`,
   where `<version>` is the release being replaced;
2. proves the dump is complete — a readable gzip, not empty, ending in
   pg_dump's own end marker — and **fails the upgrade** if any of that does not
   hold, before anything has changed;
3. records the dump in `.local/state/last-database-backup.json`;
4. keeps the three most recent dumps and removes older ones.

The dump directory is `0700` and each dump is `0600`, because a plain-SQL dump
is the entire application database, including every credential it holds. Keep
that true for any copy you make of one.

A dump is *not* taken when the installation has no database URL secret, or when
Docker is not installed on the host — in both cases nothing exists that a
migration could damage. Both are stated out loud during the run. A dump is also
not taken when the same commit is reinstalled over itself, because that run
applies no new migrations.

## Finding the dump

```sh
sudo cat /opt/orcasynapse/.local/state/last-database-backup.json
```

```json
{"path":"/opt/orcasynapse/.local/state/backups/v5.2.2-20260815T101500Z.sql.gz",
 "version":"v5.2.2","bytes":184320,"createdAt":"2026-08-15T10:15:04Z",
 "fromCommit":"<40-hex>","toCommit":"<40-hex>"}
```

`fromCommit` is the source the dump matches; `toCommit` is what the failed
upgrade was installing. If the record is missing, list the directory — the
newest file is the newest dump:

```sh
sudo ls -lt /opt/orcasynapse/.local/state/backups/
```

## Restoring

Restoring the data alone is rarely enough. Where the automatic rollback did not
run — it was turned off, it reported `source-restore-failed`, or you are
deliberately going back from a healthy deployment — the *new* source tree is
still in place, so restoring a dump under new code gives you old data under a
schema the code no longer expects. Do both, in this order.

### 1. Stop everything except the database

```sh
sudo docker compose --project-directory /opt/orcasynapse stop api worker web
sudo docker compose --project-directory /opt/orcasynapse up -d postgres
```

Leaving `api` and `worker` running would let them write during the restore.

Every command on this page names the project directory rather than changing
into it, and that is not a style preference. The installation tree is `0750
root:root`, so `cd /opt/orcasynapse` from the shell these `sudo` prefixes imply
fails with *Permission denied* — and a `cd` that fails leaves you in the
directory you were already in, where `docker compose` finds no project and
stops nothing. This step in particular is the one that keeps `api` and `worker`
off the database, so a silent no-op here means the restore below runs with
writers live.

### 2. Restore the dump

The dump is taken with `--clean --if-exists`, so it drops and recreates what it
restores; it does not need an empty database.

```sh
sudo sh -c 'gzip -cd /opt/orcasynapse/.local/state/backups/<dump>.sql.gz \
  | docker compose --project-directory /opt/orcasynapse exec -T postgres \
      psql -U orcasynapse -d orcasynapse -v ON_ERROR_STOP=1'
```

`ON_ERROR_STOP=1` matters: without it psql reports success after skipping every
statement it could not apply.

Check that the restore landed before going further:

```sh
sudo docker compose --project-directory /opt/orcasynapse exec -T postgres \
  psql -U orcasynapse -d orcasynapse -tAc \
  'select "epoch" from "SchemaMetadata" where "id" = '"'"'current'"'"''
```

### 3. Put the matching source back

Reinstall the commit the dump was taken from — `fromCommit` in the record above.
`install.sh` at that commit will take a dump of its own first, which is correct:
it is now the *current* database being replaced.

```sh
curl -fsSL https://raw.githubusercontent.com/multichainerz/AI/<fromCommit>/install.sh \
  | sudo ORCASYNAPSE_REF=<fromCommit> ORCASYNAPSE_EXISTING_INSTALL_ACTION=upgrade bash
```

Use the same `--public-scheme https` flag the deployment was installed with, if
it was.

### 4. Confirm the control plane is back

```sh
curl -fsS http://127.0.0.1:8080/readyz
sudo docker compose --project-directory /opt/orcasynapse ps
```

## Inspecting a dump without committing to it

Restore into a scratch database on the same server. The dump is taken with
`--no-owner`, so it does not need the original role names.

```sh
sudo docker compose --project-directory /opt/orcasynapse exec -T postgres \
  createdb -U orcasynapse orcasynapse_inspect
sudo sh -c 'gzip -cd /opt/orcasynapse/.local/state/backups/<dump>.sql.gz \
  | docker compose --project-directory /opt/orcasynapse exec -T postgres \
      psql -U orcasynapse -d orcasynapse_inspect -v ON_ERROR_STOP=1'
sudo docker compose --project-directory /opt/orcasynapse exec -T postgres \
  dropdb -U orcasynapse orcasynapse_inspect
```

## Before you need it

Two failure modes this design does not cover, both worth an operator's
attention:

- **The dumps live inside the installation directory.** A clean reinstall
  (`erase`) removes them along with everything else, and so does losing the
  disk. Copy them somewhere else if the deployment matters — `0600`, and to
  somewhere that treats them as the credential store they are.
- **Three dumps is a shallow history.** Retention is by count, not by age. Four
  upgrades in a day leave nothing from yesterday.

## What is verified, and where

`scripts/test-orcasynapse-installer-backup.sh` runs `install.sh`'s upgrade path
against a live PostgreSQL container and asserts the behaviour this runbook
depends on: that an upgrade produces a dump containing the data, that a failed,
truncated or empty dump aborts the upgrade before the handoff that would run the
migrations, that retention keeps three, that the dump is not world-readable, and
that the restore command in section 2 above actually brings a deleted row back.
It needs root and a Docker daemon.

`scripts/test-orcasynapse-installer-upgrade.sh` verifies the other half: that a
deployment really does come back. It installs a control plane at one version,
seeds rows, upgrades it to another whose migration adds a column and backfills
it, then fails an upgrade *after* that migration has committed and asserts that
`install.sh` put the source, the schema and the rows back on its own. It asserts
the discrimination in both directions — a failure *before* the migrations leaves
a row written during the upgrade alive, a failure *after* them does not — and it
asserts that `ORCASYNAPSE_UPGRADE_ROLLBACK=off` still leaves the failed state in
place and that sections 2 and 3 above still recover it. It also asserts, from
the dump's own contents rather than from the installer's log, that the dump
predates the migration it is meant to undo.

`scripts/test-orcasynapse-update-agent.sh` drives the same round trip from the
approved-target row instead of from a harness: the agent reads the target out of
PostgreSQL, downloads `install.sh` at that commit, upgrades, health-gates
against `/readyz`, and recovers — both when `install.sh` fails and when a
release installs cleanly and then never serves. All three suites need root and a
Docker daemon and run in the `install` job.

None of them builds an application image, so none of them says the product boots
on the new schema. What they prove is the mechanism.
