-- pg-boss stored only superseded transport state here. Durable AIHub workflow
-- state remains in the public domain tables reconciled by the runtime executor.
DROP SCHEMA IF EXISTS "aihub_jobs" CASCADE;
