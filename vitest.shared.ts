import { defineConfig } from "vitest/config";

/**
 * How long a single test in a database-backed package may run.
 *
 * Vitest's 5s default is a figure for tests that only compute. These suites
 * provision a real PostgreSQL database per file and then talk to it over a
 * socket, and `pnpm -r test` starts every package at once, so what a query
 * costs is set by how loaded the cluster and the host are rather than by how
 * much the one test asks for. Measured on a four-vCPU budget - the width of the
 * GitHub runner this has to survive, and a fifth of the workstation it was
 * written on - the slowest database test took 22.8s where the same test costs
 * a few hundred milliseconds on an idle machine. At the 5s default, eleven
 * tests in a single run failed with "Test timed out in 5000ms" while asserting
 * nothing wrong about the code they cover.
 *
 * 30s is chosen to sit above that measured tail with room, not to be generous:
 * it is still a ceiling a genuinely hung test hits and reports, and thirty of
 * them would fit inside the 30 minute cap on the `verify` job. Tests heavy on
 * their own merits keep their larger per-test annotations, which override this.
 */
export const DATABASE_SUITE_TEST_TIMEOUT_MS = 30_000;

/**
 * The same budget for every hook in those packages.
 *
 * DROP DATABASE forces an immediate checkpoint and waits for it, so teardown
 * costs what the whole cluster has dirtied: 62ms isolated, up to 10.8s across a
 * concurrent run. Each suite already passes this number to its own beforeAll
 * and afterAll. What nobody passed it to is the hook sitting between them --
 * `beforeEach(() => context.reset())`, a TRUNCATE of every table before every
 * test, left on Vitest's 10s default in 27 of the 29 database suites. Two
 * concurrent runs of `pnpm -r test` failed four of those hooks with "Hook timed
 * out in 10000ms", and a hook that fails after its database exists leaves that
 * database behind. Setting the budget here covers the hooks nobody annotated
 * and the ones nobody has written yet.
 */
export const DATABASE_SUITE_HOOK_TIMEOUT_MS = 120_000;

/**
 * The profile for a package whose tests provision real databases.
 *
 * Deliberately not applied repo-wide. Packages that only compute - contracts,
 * security, runtime-clients - and the jsdom dashboard suites are not exposed to
 * cluster contention: measured under the same four-vCPU budget their slowest
 * test was 2.3s and 1.4s respectively, so 5s remains an honest ceiling there and
 * a hang in them still surfaces in five seconds rather than thirty.
 *
 * It is applied per package rather than per file because there is no way to tell
 * Vitest which files are database-backed that a new test cannot silently fall
 * outside of. A test's budget is fixed when it is collected, so a helper called
 * from beforeAll cannot widen it, and a glob or a filename convention only moves
 * the thing somebody has to remember. Whole packages have no such hole: the
 * price is that the pure unit tests living beside the database ones in these
 * four packages report a hang in 30s instead of 5s.
 *
 * If you are here because `apps/web` tests timed out at 5000ms, check what else
 * was running first. Three separate observers hit exactly that in one session --
 * `app-dashboard-metrics`, `front-page` and `recovery-kit-dialog`, all at the
 * default -- while several full suites ran *concurrently with each other* on one
 * workstation. Every one passed alone and on rerun. CI does not reproduce that
 * condition: it runs `pnpm -r test` once, which is the four-vCPU budget the 2.3s
 * measurement above was taken under. Widening the dashboard's ceiling on that
 * evidence would triple the time a real hang takes to surface in exchange for
 * quieting an artifact of how the machine was being driven.
 *
 * Worth distinguishing from a genuine race, which looks different and is a real
 * bug: `corpus-view.test.tsx` asserted a fetch it never awaited and passed only
 * by luck -- measured inside `waitFor`, the call count was zero in 10 of 10 runs
 * on an idle machine. It failed as an AssertionError in under a second, nowhere
 * near any budget, and adding load did not change its rate. A timeout says the
 * machine was busy; an assertion failure half a second in says the test was
 * wrong.
 */
export const databaseBackedPackage = defineConfig({
  test: {
    testTimeout: DATABASE_SUITE_TEST_TIMEOUT_MS,
    hookTimeout: DATABASE_SUITE_HOOK_TIMEOUT_MS,
  },
});
