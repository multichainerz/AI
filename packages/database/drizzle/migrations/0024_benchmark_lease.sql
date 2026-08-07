--
-- A lease, so a worker restart mid-run does not strand the run in RUNNING.
--
-- The same pattern Document ingestion uses, and for the same reason: a suite of
-- forty cases is forty minutes of inference, so "still going" and "the process
-- that was running it is gone" are otherwise indistinguishable, and the second
-- one has no way out but hand-written SQL.
--
ALTER TABLE "BenchmarkRun" ADD COLUMN "leaseOwner" varchar(160);--> statement-breakpoint
ALTER TABLE "BenchmarkRun" ADD COLUMN "leaseExpiresAt" timestamp (6) with time zone;--> statement-breakpoint
-- The worker's claim query: queued work, then work whose lease has lapsed.
CREATE INDEX "BenchmarkRun_claim_idx" ON "BenchmarkRun" USING btree ("status","leaseExpiresAt");
