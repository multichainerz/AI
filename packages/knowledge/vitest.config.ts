// agent-memory-store.test.ts provisions a real PostgreSQL database and runs
// pgvector queries against it, so this package runs on the database profile.
// See vitest.shared.ts for why the budget is set per package rather than per
// file.
export { databaseBackedPackage as default } from "../../vitest.shared.ts";
