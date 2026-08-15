// Two of this package's three test files provision a real PostgreSQL database,
// so the whole package runs on the database profile. See vitest.shared.ts for
// why the budget is set per package rather than per file.
export { databaseBackedPackage as default } from "../../vitest.shared.ts";
