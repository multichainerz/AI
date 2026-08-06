DROP INDEX "AgentMemory_latest_idx";--> statement-breakpoint
ALTER TABLE "AgentMemory" ADD COLUMN "forgottenAt" timestamp (6) with time zone;--> statement-breakpoint
ALTER TABLE "AgentMemory" ADD COLUMN "forgetReason" varchar(300);--> statement-breakpoint
ALTER TABLE "AgentMemory" ADD COLUMN "forgetBatchId" uuid;--> statement-breakpoint
CREATE INDEX "AgentMemory_forgetBatchId_idx" ON "AgentMemory" USING btree ("forgetBatchId");--> statement-breakpoint
CREATE INDEX "AgentMemory_latest_idx" ON "AgentMemory" USING btree ("ownerSubject","agentProfileId") WHERE "isLatest" AND "forgottenAt" IS NULL;