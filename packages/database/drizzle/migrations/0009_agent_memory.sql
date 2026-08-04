CREATE TYPE "public"."AgentMemoryMode" AS ENUM('DOCUMENTS_ONLY', 'RECALL_ONLY', 'LEARN_USER', 'LEARN_EXCHANGE');--> statement-breakpoint
CREATE TABLE "AgentMemory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ownerSubject" varchar(200) NOT NULL,
	"agentProfileId" uuid NOT NULL,
	"content" text NOT NULL,
	"characterCount" integer NOT NULL,
	"embeddingModel" varchar(120) NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"sourceRunId" uuid,
	"sourceConversationId" uuid,
	"retentionUntil" timestamp (6) with time zone,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "AgentMemory_content_check" CHECK ((char_length(btrim(content)) >= 3) AND ("characterCount" > 0))
);
--> statement-breakpoint
ALTER TABLE "AgentProfileVersion" ADD COLUMN "memoryMode" "AgentMemoryMode" DEFAULT 'DOCUMENTS_ONLY' NOT NULL;--> statement-breakpoint
ALTER TABLE "AgentMemory" ADD CONSTRAINT "AgentMemory_agentProfileId_fkey" FOREIGN KEY ("agentProfileId") REFERENCES "public"."AgentProfile"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "AgentMemory_content_fts_idx" ON "AgentMemory" USING gin (to_tsvector('simple'::regconfig, content));--> statement-breakpoint
CREATE INDEX "AgentMemory_embedding_idx" ON "AgentMemory" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "AgentMemory_owner_profile_idx" ON "AgentMemory" USING btree ("ownerSubject","agentProfileId");--> statement-breakpoint
CREATE INDEX "AgentMemory_retentionUntil_idx" ON "AgentMemory" USING btree ("retentionUntil");