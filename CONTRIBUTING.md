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
against a live PostgreSQL server — and it must be a **pgvector** image, because
the migrator creates the `vector` extension:

```bash
docker run -d --name orca-base -p 15432:5432 \
  -e POSTGRES_USER=orca -e POSTGRES_PASSWORD=orca -e POSTGRES_DB=postgres \
  pgvector/pgvector:pg17
export ORCASYNAPSE_TEST_DATABASE_URL=postgresql://orca:orca@127.0.0.1:15432/postgres
```

Day-to-day commands:

```bash
pnpm dev            # API + operator workspace
pnpm dev:worker     # background worker
pnpm verify         # build && typecheck && test && db:validate — the merge gate
pnpm verify:postgres  # full-migration integration proof (needs ORCASYNAPSE_INTEGRATION_DATABASE_URL)
```

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
- Static conformance guards run in CI and locally:
  `bash scripts/test-release-consistency.sh` and
  `bash scripts/test-docker-build-closure.sh`.

## Release convention

Every release is one commit on `main`:

- Subject: `ai-vX.Y.Z` (nothing else).
- Body: one summary sentence, then lowercase verb-first bullets.
- The version is bumped in the same commit across **all 12 surfaces**: the
  root and 8 workspace `package.json` files, `ORCASYNAPSE_VERSION` in
  `packages/contracts/src/version.ts`, and `INSTALLER_VERSION` in both
  `scripts/install-agentic-node.sh` and `scripts/remove-agentic-node.sh`.
  `scripts/test-release-consistency.sh` enforces the set.
- A matching entry is added to [CHANGELOG.md](CHANGELOG.md).
- The commit is tagged `ai-vX.Y.Z` and the tag is pushed.

`pnpm verify` must be green before any release commit.

## Reporting issues

Use the issue templates. For anything security-sensitive, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.
