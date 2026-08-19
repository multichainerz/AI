CREATE TYPE "public"."ChatArtifactOrigin" AS ENUM('AGENT', 'UPLOADED');--> statement-breakpoint
ALTER TABLE "ChatArtifact" ALTER COLUMN "runId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ChatArtifact" ALTER COLUMN "nodeId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ChatArtifact" ADD COLUMN "origin" "ChatArtifactOrigin" DEFAULT 'AGENT' NOT NULL;