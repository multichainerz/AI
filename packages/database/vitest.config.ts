// 3 of this package's test files provision a real PostgreSQL database --
// drizzle/wake.test.ts, drizzle/chat-wake.test.ts and
// default-configuration-sets.test.ts -- and this package owns
// createTestDatabase itself, so the whole package runs on the database profile.
// See vitest.shared.ts for why the budget is set per package rather than per
// file.
//
// The count in that sentence is checked by
// scripts/test-database-test-budgets.mjs against the files that call
// createTestDatabase. This comment named wake.test.ts alone for the whole life
// of chat-wake.test.ts sitting beside it.
export { databaseBackedPackage as default } from "../../vitest.shared.ts";
