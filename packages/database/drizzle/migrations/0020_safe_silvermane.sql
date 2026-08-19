CREATE TYPE "public"."ChatArtifactStorage" AS ENUM('INLINE', 'NODE');--> statement-breakpoint
CREATE TABLE "ChatArtifact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runId" uuid NOT NULL,
	"conversationId" uuid,
	"messageId" uuid,
	"nodeId" uuid NOT NULL,
	"divisionId" uuid,
	"ownerSubject" varchar(200) NOT NULL,
	"name" varchar(160) NOT NULL,
	"path" varchar(1024) NOT NULL,
	"mediaType" varchar(160) NOT NULL,
	"sizeBytes" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"storage" "ChatArtifactStorage" NOT NULL,
	"observedAt" timestamp (6) with time zone NOT NULL,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ChatArtifactContent" (
	"artifactId" uuid PRIMARY KEY NOT NULL,
	"bytes" "bytea" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ChatArtifact" ADD CONSTRAINT "ChatArtifact_runId_fkey" FOREIGN KEY ("runId") REFERENCES "public"."AgentRun"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ChatArtifact" ADD CONSTRAINT "ChatArtifact_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "public"."ChatConversation"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ChatArtifact" ADD CONSTRAINT "ChatArtifact_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "public"."ChatMessage"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ChatArtifact" ADD CONSTRAINT "ChatArtifact_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "public"."HermesRuntimeNode"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ChatArtifact" ADD CONSTRAINT "ChatArtifact_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "public"."Division"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ChatArtifactContent" ADD CONSTRAINT "ChatArtifactContent_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "public"."ChatArtifact"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "ChatArtifact_runId_path_key" ON "ChatArtifact" USING btree ("runId","path");--> statement-breakpoint
CREATE INDEX "ChatArtifact_divisionId_createdAt_idx" ON "ChatArtifact" USING btree ("divisionId","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ChatArtifact_conversationId_idx" ON "ChatArtifact" USING btree ("conversationId");--> statement-breakpoint
CREATE INDEX "ChatArtifact_ownerSubject_createdAt_idx" ON "ChatArtifact" USING btree ("ownerSubject","createdAt" DESC NULLS LAST);