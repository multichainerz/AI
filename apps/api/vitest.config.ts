// 18 of this package's test files provision a real PostgreSQL database, so the
// whole package runs on the database profile. See vitest.shared.ts for why the
// budget is set per package rather than per file.
//
// This said "Twenty-one of this package's fifty test files" for several
// releases against a suite that was neither, because a comment is the one claim
// about a suite that nothing runs. scripts/test-database-test-budgets.mjs reads
// the count out of this sentence and checks it against the files that call
// createTestDatabase, so the wording is load-bearing: "N of this package's test
// files".
export { databaseBackedPackage as default } from "../../vitest.shared.ts";
