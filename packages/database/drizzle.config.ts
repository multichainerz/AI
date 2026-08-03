import { defineConfig } from "drizzle-kit";

// Introspection helper only. Points at a disposable database that has had the
// committed SQL migrations applied, so the generated schema is derived from the
// real applied shape rather than transcribed by hand.
export default defineConfig({
  dialect: "postgresql",
  out: "./.introspect",
  dbCredentials: {
    url: process.env.ORCASYNAPSE_DRIZZLE_DATABASE_URL ?? "postgresql://orca:orca@127.0.0.1:55432/orca",
  },
});
