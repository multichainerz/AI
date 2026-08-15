# Database Restore Runbook

For the one situation VM1 cannot recover from by itself: an upgrade that failed
*after* the migrations ran.

The installer already restores the source tree when an upgrade fails early. The
database is different. The migrations under
`packages/database/drizzle/migrations/` are forward-only and have no down step,
so once they have run there is no code path anywhere in the product that returns
the schema to the release it came from. The dump described here is the only way
back, which is why `install.sh` refuses to start an upgrade it cannot take one
for.

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

Restoring the data alone is rarely enough. A failed upgrade leaves the *new*
source tree in place — the installer removes its source backup as soon as the
swap succeeds — so restoring a dump under new code gives you old data under a
schema the code no longer expects. Do both, in this order.

### 1. Stop everything except the database

```sh
cd /opt/orcasynapse
sudo docker compose stop api worker web
sudo docker compose up -d postgres
```

Leaving `api` and `worker` running would let them write during the restore.

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
cd /opt/orcasynapse
sudo docker compose exec -T postgres createdb -U orcasynapse orcasynapse_inspect
sudo sh -c 'gzip -cd .local/state/backups/<dump>.sql.gz \
  | docker compose exec -T postgres psql -U orcasynapse -d orcasynapse_inspect -v ON_ERROR_STOP=1'
sudo docker compose exec -T postgres dropdb -U orcasynapse orcasynapse_inspect
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
