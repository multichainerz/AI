ALTER TABLE "AgentRunEvent" ADD COLUMN "toolCallKey" varchar(200);--> statement-breakpoint
ALTER TABLE "AgentRunEvent" ADD COLUMN "text" text;--> statement-breakpoint
ALTER TABLE "AgentRunEvent" ADD COLUMN "contentOffset" integer;--> statement-breakpoint
CREATE INDEX "AgentRunEvent_runId_toolCallKey_idx" ON "AgentRunEvent" USING btree ("runId","toolCallKey");