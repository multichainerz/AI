// Asserts that every package whose tests provision a real database runs on the
// shared database timeout profile.
//
// The budget itself lives in vitest.shared.ts. This is what keeps it from
// drifting back into the state that produced the bug: before it existed there
// was no Vitest config anywhere in the repository, so every suite ran on the
// 5s default and the only remedy anyone reached for was `}, 30_000)` on the one
// test that had just failed. Its heavier siblings in the same file kept the
// default, and under `pnpm -r test` against real PostgreSQL they failed with
// "Test timed out in 5000ms" while asserting nothing wrong about the code.
//
// A per-test annotation cannot be *required* -- nothing can tell that the test
// somebody writes next week needed one. A package can: the day a
// createTestDatabase test appears in a package that has not declared the
// profile, this fails and names the file to add.
//
// An annotation BELOW the profile can be caught, though, and has to be. A
// per-test number overrides the config rather than widening it, so a leftover
// `}, 20_000)` from the era of one-test-at-a-time fixes silently keeps that
// test on a budget the package has already decided is too small -- which is how
// two tests in drizzle-tooling-manager.test.ts stayed exposed inside a file the
// profile was added for.
//
// The reverse is checked too. The profile is deliberately not repo-wide, and a
// package that carries it without a database test would be one more suite whose
// genuine hangs take thirty seconds to report instead of five.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

const { DATABASE_SUITE_TEST_TIMEOUT_MS, DATABASE_SUITE_HOOK_TIMEOUT_MS } = await import(
  pathToFileURL(join(repositoryRoot, 'vitest.shared.ts')).href
);

// The floor is the measured one: under a four-vCPU budget, the width of the
// GitHub runner, the slowest database-backed test took 22.8s. Anything below
// this is the 5s default wearing a larger number. The ceiling is what keeps a
// genuinely hung test a reported failure rather than a parked job -- the verify
// workflow caps itself at 30 minutes, and a suite cannot spend a quarter of
// that discovering one test will never finish.
if (!(DATABASE_SUITE_TEST_TIMEOUT_MS >= 30_000 && DATABASE_SUITE_TEST_TIMEOUT_MS <= 120_000)) {
  problems.push(
    `vitest.shared.ts: DATABASE_SUITE_TEST_TIMEOUT_MS is ${DATABASE_SUITE_TEST_TIMEOUT_MS}ms, outside 30000-120000ms. Below the floor it is under the 22.8s tail measured on four vCPUs; above the ceiling a hung test stops being a failure CI reports quickly.`,
  );
}
if (!(DATABASE_SUITE_HOOK_TIMEOUT_MS >= DATABASE_SUITE_TEST_TIMEOUT_MS && DATABASE_SUITE_HOOK_TIMEOUT_MS <= 300_000)) {
  problems.push(
    `vitest.shared.ts: DATABASE_SUITE_HOOK_TIMEOUT_MS is ${DATABASE_SUITE_HOOK_TIMEOUT_MS}ms. It must be at least the test budget -- provisioning and dropping a database is the slowest thing a suite does -- and no more than 300000ms.`,
  );
}

function testFilesUnder(directory) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...testFilesUnder(path));
    else if (/\.test\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found;
}

function workspacePackages() {
  const found = [];
  for (const group of ['apps', 'packages']) {
    const groupPath = join(repositoryRoot, group);
    for (const entry of readdirSync(groupPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(groupPath, entry.name);
      try {
        statSync(join(path, 'package.json'));
      } catch {
        continue;
      }
      found.push(path);
    }
  }
  return found;
}

for (const packagePath of workspacePackages()) {
  const name = relative(repositoryRoot, packagePath).replaceAll('\\', '/');

  // The single call that makes a suite database-backed. Every such file has to
  // make it -- there is nowhere else to get a migrated, isolated database from
  // -- so nothing that touches PostgreSQL can be missed by looking for it.
  const databaseBackedFiles = testFilesUnder(join(packagePath, 'src')).filter((file) =>
    readFileSync(file, 'utf8').includes('createTestDatabase'),
  );

  // Absence is the ordinary case for a package with no database tests, so it is
  // read as "no profile". A config that exists but will not load is not: that
  // is a broken harness, and reporting it as a missing budget would send the
  // reader looking for the wrong thing.
  const configurationPath = join(packagePath, 'vitest.config.ts');
  let declared = null;
  let present = true;
  try {
    statSync(configurationPath);
  } catch {
    present = false;
  }
  if (present) {
    try {
      const configuration = await import(pathToFileURL(configurationPath).href);
      declared = configuration.default?.test ?? {};
    } catch (error) {
      problems.push(`${name}/vitest.config.ts could not be loaded: ${error.message}`);
      continue;
    }
  }

  const onProfile = declared !== null
    && declared.testTimeout >= DATABASE_SUITE_TEST_TIMEOUT_MS
    && declared.hookTimeout >= DATABASE_SUITE_HOOK_TIMEOUT_MS;

  if (databaseBackedFiles.length > 0 && !onProfile) {
    const example = relative(packagePath, databaseBackedFiles[0]).replaceAll('\\', '/');
    problems.push(
      `${name}: ${databaseBackedFiles.length} test file(s) call createTestDatabase (for example ${example}) but the package is not on the database timeout profile. Add ${name}/vitest.config.ts containing: export { databaseBackedPackage as default } from "../../vitest.shared.ts";`,
    );
  }
  // Trailing timeout arguments on it/test/beforeAll/afterAll, which beat the
  // config instead of adding to it. Only checked where the profile applies:
  // elsewhere a small number is the deliberate 5s default, not an override of
  // something larger.
  if (onProfile) {
    for (const file of databaseBackedFiles) {
      const source = readFileSync(file, 'utf8');
      const where = relative(packagePath, file).replaceAll('\\', '/');
      for (const [, digits] of source.matchAll(/\}\s*,\s*(\d[\d_]*)\s*\)\s*;/g)) {
        const budget = Number(digits.replaceAll('_', ''));
        if (budget >= DATABASE_SUITE_TEST_TIMEOUT_MS) continue;
        problems.push(
          `${name}/${where}: a per-test budget of ${budget}ms sits below the package profile's ${DATABASE_SUITE_TEST_TIMEOUT_MS}ms. A trailing timeout replaces the config rather than raising it, so this test still runs on the smaller number. Delete the annotation and let it inherit the profile.`,
        );
      }
    }
  }

  if (databaseBackedFiles.length === 0 && onProfile) {
    problems.push(
      `${name}: declares the database timeout profile but no test file calls createTestDatabase. Delete ${name}/vitest.config.ts so a hang in this package still reports in five seconds.`,
    );
  }

  // The config's own header, checked against the files it describes.
  //
  // These headers are the only place the scale that justifies a whole-package
  // profile is written down, and they were the only claim about these suites
  // that nothing ran: apps/api's said "Twenty-one of this package's fifty test
  // files" against a package with 45 files of which 18 are database-backed, and
  // packages/database's named wake.test.ts alone for the entire life of
  // chat-wake.test.ts sitting beside it.
  //
  // Only the database-backed count is asserted, and only where the sentence is
  // written. Asserting a package's *total* test count would make every new test
  // file anywhere a two-file change for a number that justifies nothing, and
  // demanding the sentence would be this script inventing a house style rather
  // than checking a claim. A config that makes the claim has to be right about
  // it; one that stays silent is not lying.
  if (present) {
    const stated = /(\d+) of this package's test files/.exec(readFileSync(configurationPath, 'utf8'));
    if (stated && Number(stated[1]) !== databaseBackedFiles.length) {
      problems.push(
        `${name}/vitest.config.ts says "${stated[1]} of this package's test files" provision a database, but ${databaseBackedFiles.length} call createTestDatabase.`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('Database test budget profile check passed.');
