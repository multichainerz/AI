CREATE TYPE "public"."MemoryProfileScope" AS ENUM('STATIC', 'DYNAMIC', 'EPISODIC');--> statement-breakpoint
ALTER TABLE "AgentMemory" ADD COLUMN "profileScope" "MemoryProfileScope" DEFAULT 'EPISODIC' NOT NULL;--> statement-breakpoint
CREATE INDEX "AgentMemory_profile_idx" ON "AgentMemory" USING btree ("ownerSubject","agentProfileId","profileScope");