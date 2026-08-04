CREATE TYPE "public"."MemoryPolicyStatus" AS ENUM('DRAFT', 'ACTIVE', 'SUSPENDED');--> statement-breakpoint
CREATE TABLE "MemoryPolicy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(64) NOT NULL,
	"displayName" varchar(120) NOT NULL,
	"description" varchar(500) NOT NULL,
	"status" "MemoryPolicyStatus" DEFAULT 'DRAFT' NOT NULL,
	"maximumCaptureMode" "AgentMemoryMode" DEFAULT 'LEARN_EXCHANGE' NOT NULL,
	"retentionDays" integer,
	"maximumItemsPerOwner" integer DEFAULT 500 NOT NULL,
	"recallLimit" integer DEFAULT 6 NOT NULL,
	"recallMinimumScore" double precision DEFAULT 0.4 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"firstActivatedAt" timestamp (6) with time zone,
	"createdBy" uuid,
	"updatedBy" uuid,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL,
	CONSTRAINT "MemoryPolicy_bounds_check" CHECK (("maximumItemsPerOwner" >= 10) AND ("recallLimit" >= 1) AND ("recallMinimumScore" >= 0) AND ("recallMinimumScore" <= 1) AND ("retentionDays" IS NULL OR "retentionDays" >= 1) AND (revision > 0)),
	CONSTRAINT "MemoryPolicy_activation_check" CHECK ((status <> 'ACTIVE') OR ("firstActivatedAt" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "MemoryPolicy_slug_key" ON "MemoryPolicy" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "MemoryPolicy_single_active_key" ON "MemoryPolicy" USING btree ((true)) WHERE status = 'ACTIVE';