CREATE TYPE "public"."HermesCorpusEntryKind" AS ENUM('MEMORY', 'SKILL', 'SKILL_FILE', 'SKILL_BUNDLE', 'PROVENANCE', 'PENDING_CHANGE');--> statement-breakpoint
CREATE TYPE "public"."HermesCorpusMutationOperation" AS ENUM('MEMORY_ADD', 'MEMORY_REPLACE', 'MEMORY_REMOVE', 'SKILL_CREATE', 'SKILL_EDIT', 'SKILL_DELETE', 'SKILL_WRITE_FILE', 'SKILL_REMOVE_FILE');--> statement-breakpoint
CREATE TYPE "public"."HermesCorpusMutationStatus" AS ENUM('PENDING_APPROVAL', 'QUEUED', 'DISPATCHED', 'APPLIED', 'REJECTED', 'CONFLICT', 'FAILED', 'EXPIRED');--> statement-breakpoint
CREATE TABLE "HermesCorpusEntry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nodeId" uuid NOT NULL,
	"path" text NOT NULL,
	"kind" "HermesCorpusEntryKind" NOT NULL,
	"mediaType" varchar(160) NOT NULL,
	"sizeBytes" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"content" text,
	"structuredEntries" jsonb,
	"readOnly" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"lastSnapshotId" uuid,
	"observedAt" timestamp (6) with time zone NOT NULL,
	"firstSeenAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL,
	"deletedAt" timestamp (6) with time zone
);
--> statement-breakpoint
CREATE TABLE "HermesCorpusMutation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nodeId" uuid NOT NULL,
	"operation" "HermesCorpusMutationOperation" NOT NULL,
	"path" text NOT NULL,
	"expectedHash" varchar(64),
	"content" text,
	"oldText" text,
	"reason" varchar(1000) NOT NULL,
	"status" "HermesCorpusMutationStatus" NOT NULL,
	"requestedBy" uuid NOT NULL,
	"requestedBySubject" varchar(320) NOT NULL,
	"approvedBy" uuid,
	"approvedBySubject" varchar(320),
	"beforeHash" varchar(64),
	"afterHash" varchar(64),
	"error" text,
	"idempotencyKey" uuid NOT NULL,
	"requestedAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"approvedAt" timestamp (6) with time zone,
	"dispatchedAt" timestamp (6) with time zone,
	"completedAt" timestamp (6) with time zone
);
--> statement-breakpoint
CREATE TABLE "HermesCorpusRevision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entryId" uuid,
	"nodeId" uuid NOT NULL,
	"path" text NOT NULL,
	"revision" integer NOT NULL,
	"changeKind" varchar(32) NOT NULL,
	"beforeHash" varchar(64),
	"afterHash" varchar(64),
	"beforeContent" text,
	"afterContent" text,
	"mutationId" uuid,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "HermesCorpusSnapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nodeId" uuid NOT NULL,
	"rootHash" varchar(64) NOT NULL,
	"observedAt" timestamp (6) with time zone NOT NULL,
	"entryCount" integer NOT NULL,
	"totalBytes" bigint NOT NULL,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "HermesCorpusEntry" ADD CONSTRAINT "HermesCorpusEntry_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "public"."HermesRuntimeNode"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "HermesCorpusEntry" ADD CONSTRAINT "HermesCorpusEntry_lastSnapshotId_fkey" FOREIGN KEY ("lastSnapshotId") REFERENCES "public"."HermesCorpusSnapshot"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "HermesCorpusMutation" ADD CONSTRAINT "HermesCorpusMutation_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "public"."HermesRuntimeNode"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "HermesCorpusRevision" ADD CONSTRAINT "HermesCorpusRevision_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "public"."HermesCorpusEntry"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "HermesCorpusRevision" ADD CONSTRAINT "HermesCorpusRevision_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "public"."HermesRuntimeNode"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "HermesCorpusRevision" ADD CONSTRAINT "HermesCorpusRevision_mutationId_fkey" FOREIGN KEY ("mutationId") REFERENCES "public"."HermesCorpusMutation"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "HermesCorpusSnapshot" ADD CONSTRAINT "HermesCorpusSnapshot_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "public"."HermesRuntimeNode"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "HermesCorpusEntry_nodeId_path_key" ON "HermesCorpusEntry" USING btree ("nodeId","path");--> statement-breakpoint
CREATE INDEX "HermesCorpusEntry_nodeId_kind_deletedAt_idx" ON "HermesCorpusEntry" USING btree ("nodeId","kind","deletedAt");--> statement-breakpoint
CREATE INDEX "HermesCorpusEntry_search_idx" ON "HermesCorpusEntry" USING gin (to_tsvector('simple', coalesce("path", '') || ' ' || coalesce("content", '')));--> statement-breakpoint
CREATE UNIQUE INDEX "HermesCorpusMutation_idempotencyKey_key" ON "HermesCorpusMutation" USING btree ("idempotencyKey");--> statement-breakpoint
CREATE INDEX "HermesCorpusMutation_nodeId_status_requestedAt_idx" ON "HermesCorpusMutation" USING btree ("nodeId","status","requestedAt");--> statement-breakpoint
CREATE INDEX "HermesCorpusRevision_nodeId_path_revision_idx" ON "HermesCorpusRevision" USING btree ("nodeId","path","revision" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "HermesCorpusSnapshot_nodeId_observedAt_idx" ON "HermesCorpusSnapshot" USING btree ("nodeId","observedAt" DESC NULLS LAST);