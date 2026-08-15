# Contributing to OrcaSynapse

OrcaSynapse is source-available under the [Business Source License 1.1](LICENSE).
Contributions are welcome; by submitting one you agree it is licensed under the
same terms as the project.

## Development setup

Requirements: **Node.js 24+**, **pnpm 10+**, and **Docker**.

```bash
pnpm install
```

The data-layer and API tests provision an isolated database per test file
against a live stock PostgreSQL 17 server:

```bash
docker run -d --name orca-base -p 15432:5432 \
  -e POSTGRES_USER=orca -e POSTGRES_PASSWORD=orca -e POSTGRES_DB=postgres \
  postgres:17-bookworm
export ORCASYNAPSE_TEST_DATABASE_URL=postgresql://orca:orca@127.0.0.1:15432/postgres
```

Day-to-day commands:

```bash
pnpm dev            # API + operator workspace
pnpm dev:worker     # background worker
pnpm verify         # the merge gate — see below for exactly what it covers
pnpm verify:static  # just the static gates; needs no node_modules, runs in seconds
pnpm verify:postgres  # full-migration integration proof (needs ORCASYNAPSE_INTEGRATION_DATABASE_URL)
```

`pnpm verify` runs, in order: `scripts/test-static-conformance.sh` (installer
scripts parse, shell scripts are declared `eol=lf`, both generated-asset
`--check`s, Dockerfile copy closure, and the release version surfaces), the
database timeout-budget guard, `build`, `typecheck`, the whole test suite,
`db:validate`, and finally `scripts/test-csp-closure.sh` against the dashboard
it just built.

**On Windows, run it from Git Bash, not PowerShell.** Two of those gates are
shell scripts, and PowerShell has no `bash` on its PATH by default, so the
chain stops at the first one with `'bash' is not recognized`. Git Bash ships
with Git for Windows and needs no extra setup. The individual `pnpm test` and
`pnpm typecheck` targets are shell-independent and run anywhere.

What it does **not** cover, because each needs root, a systemd host or a live
Docker daemon, and making them a local requirement would only make the merge
gate unrunnable:

| CI-only gate | Needs |
| --- | --- |
| `scripts/test-hermes-corpus-reconciler.py` | root |
| `scripts/test-deployment-limits.mjs` | the `docker` CLI (daemon-less; run it in WSL on Windows) |
| `scripts/test-public-installer-recovery.sh`, `scripts/test-agentic-installer-recovery.sh` | a Linux host |
| `scripts/test-installer-host-sizing.sh` | a Linux host |
| `scripts/test-installer-public-scheme.sh`, `scripts/test-installer-secret-permissions.sh` | real `sudo` |
| `scripts/test-agentic-installer-smoke.sh`, `scripts/test-orcasynapse-installer-smoke.sh` | root, systemd and Docker |
| `scripts/test-orcasynapse-installer-backup.sh`, `scripts/test-orcasynapse-installer-upgrade.sh`, `scripts/test-orcasynapse-update-agent.sh` | root and a live Docker daemon (no image build; each contains itself to its own Compose project and asserts the host is unchanged afterwards) |
| `pnpm security:audit` | network access to the advisory database |

## Code expectations

- TypeScript is strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`). Match the surrounding code's idiom and comment
  density rather than adding boilerplate.
- The database schema's source of truth is
  `packages/database/src/drizzle/schema.ts`. Edit it, run `pnpm db:generate` to
  emit a migration, and never introspect the database back over the schema
  file or hand-author migration SQL.
- Data-layer tests use real migrated databases (`packages/database/src/testing.ts`),
  not query-builder fakes.
- Installer scripts are Bash targeting Ubuntu hosts. The terminal UI lives in
  `scripts/lib/installer-ui.sh`; the self-contained scripts embed it between
  markers — edit the library, then run `bash scripts/sync-installer-ui.sh`
  (CI runs `--check` and fails on drift).
- The canonical Orca mark lives at `apps/web/public/brand/sivali-mark.svg`.
  After changing it, run `pnpm docs:brand`; CI checks that the generated
  `docs/assets/orcasynapse-wordmark.svg` remains identical.
- Static conformance guards are part of `pnpm verify` via
  `bash scripts/test-static-conformance.sh`; run that alone as `pnpm verify:static`
  for a few seconds of feedback without a build. That script also asserts its
  own wiring — that `pnpm verify` still reaches it, the database budget guard
  and the CSP closure check, and that the workflow still runs it before install
  — because the gap it closes is exactly a gate quietly leaving the merge gate.

## Release convention

Versions are `vX.Y.Z`. **The minor digit runs 0-9 and then rolls into the
major**: `2.9.0` was followed by `3.0.0`, not `2.10.0`, and `4.9.0` by `5.0.0`.
This is not semver — the major carries no compatibility meaning here, because
database compatibility is gated by the schema epoch
(`packages/database/src/drizzle/migrate.ts`) and nothing in the product branches
on a version number. `scripts/test-release-consistency.sh` enforces the roll,
because the rule held through the whole 2.x line and was then lost for eleven
releases without anything noticing.

Early releases carried an `ai-` prefix on the tag. The prefix is fully retired —
no tag in this repository uses it — but `apps/api/src/platform-updates.ts` still
parses it, so deployments installed before the rename keep working.

Every release is one commit on `main`:

- Subject: `vX.Y.Z` (nothing else).
- Body: one summary sentence, then lowercase verb-first bullets.
- The version is bumped in the same commit across the root and every workspace
  `package.json`, `ORCASYNAPSE_VERSION` in
  `packages/contracts/src/version.ts`, and `INSTALLER_VERSION` in both
  `scripts/install-agentic-node.sh` and `scripts/remove-agentic-node.sh`.
  `scripts/test-release-consistency.sh` enforces the set.
- A matching entry is added to [CHANGELOG.md](CHANGELOG.md).
- The commit is tagged `vX.Y.Z` and the tag is pushed. Tags are lightweight, so
  `--follow-tags` pushes none of them: use `git push origin main` then
  `git push origin vX.Y.Z`.

`pnpm verify` must be green before any release commit, and running it is not a
formality: a release goes straight to `main` rather than through a pull request,
so `.github/workflows/verify.yml`'s `pull_request` trigger never fires for one
and its `push` run reports after the tag is already public. For the gates in the
CI-only table above — the installer suites and the dependency audit — that is
the only signal there is, so a release is worth waiting for that run to finish
before announcing.

## Reporting issues

Use the issue templates. For anything security-sensitive, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.
