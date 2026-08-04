## What

<!-- One or two sentences: what does this change do, and why. -->

## Verification

- [ ] `pnpm verify` is green (typecheck, tests, build, schema check)
- [ ] Installer or deployment changes: `bash -n` passes and `bash scripts/sync-installer-ui.sh --check`, `bash scripts/test-release-consistency.sh`, `bash scripts/test-docker-build-closure.sh` all pass
- [ ] Schema changes: migration generated with `pnpm db:generate`, never hand-written
- [ ] Docs updated where behavior changed (README, docs/, deploy/BOOTSTRAP.md)

## Notes for the reviewer

<!-- Anything non-obvious: trade-offs, follow-ups, verification evidence. -->
