// 3 of this package's test files provision a real PostgreSQL database, so the
// whole package runs on the database profile. See vitest.shared.ts for why the
// budget is set per package rather than per file.
//
// This said "Three of this package's four test files", which is a sentence
// scripts/test-database-test-budgets.mjs cannot read: it matches digits in the
// exact form "N of this package's test files" and silently skips any other
// wording. So the claim went unchecked and drifted -- there were five test
// files by then, not four. Written in the form the script reads, it is checked.
export { databaseBackedPackage as default } from "../../vitest.shared.ts";
