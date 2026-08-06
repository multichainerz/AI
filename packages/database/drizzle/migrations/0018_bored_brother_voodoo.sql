ALTER TABLE "AgentMemory" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "AgentMemory" ADD COLUMN "parentMemoryId" uuid;--> statement-breakpoint
ALTER TABLE "AgentMemory" ADD COLUMN "rootMemoryId" uuid;--> statement-breakpoint
ALTER TABLE "AgentMemory" ADD COLUMN "isLatest" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "AgentMemory" ADD COLUMN "supersededAt" timestamp (6) with time zone;--> statement-breakpoint
ALTER TABLE "AgentMemory" ADD COLUMN "supersededReason" varchar(300);--> statement-breakpoint
CREATE INDEX "AgentMemory_latest_idx" ON "AgentMemory" USING btree ("ownerSubject","agentProfileId") WHERE "isLatest";