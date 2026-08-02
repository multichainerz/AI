-- pg-boss stored only superseded transport state here. Durable OrcaSynapse workflow
-- state remains in the public domain tables reconciled by the runtime executor.
DROP SCHEMA IF EXISTS "orcasynapse_jobs" CASCADE;
