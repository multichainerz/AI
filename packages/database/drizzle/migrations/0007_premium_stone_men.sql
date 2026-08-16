CREATE TYPE "public"."ConfigurationSetStatus" AS ENUM('ACTIVE', 'RETIRED');--> statement-breakpoint
CREATE TABLE "SkillSet" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(64) NOT NULL,
	"displayName" varchar(120) NOT NULL,
	"description" varchar(500) DEFAULT '' NOT NULL,
	"status" "ConfigurationSetStatus" DEFAULT 'ACTIVE' NOT NULL,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tracksRuntime" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"createdBy" uuid,
	"updatedBy" uuid,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ToolSet" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(64) NOT NULL,
	"displayName" varchar(120) NOT NULL,
	"description" varchar(500) DEFAULT '' NOT NULL,
	"status" "ConfigurationSetStatus" DEFAULT 'ACTIVE' NOT NULL,
	"toolsetNames" text[] DEFAULT '{}' NOT NULL,
	"tracksAdmission" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"createdBy" uuid,
	"updatedBy" uuid,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "AgentProfileVersion" ADD COLUMN "toolSetId" uuid;--> statement-breakpoint
ALTER TABLE "AgentProfileVersion" ADD COLUMN "skillSetId" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "SkillSet_slug_key" ON "SkillSet" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "SkillSet_status_updatedAt_idx" ON "SkillSet" USING btree ("status","updatedAt");--> statement-breakpoint
CREATE UNIQUE INDEX "ToolSet_slug_key" ON "ToolSet" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "ToolSet_status_updatedAt_idx" ON "ToolSet" USING btree ("status","updatedAt");--> statement-breakpoint
ALTER TABLE "AgentProfileVersion" ADD CONSTRAINT "AgentProfileVersion_toolSetId_fkey" FOREIGN KEY ("toolSetId") REFERENCES "public"."ToolSet"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "AgentProfileVersion" ADD CONSTRAINT "AgentProfileVersion_skillSetId_fkey" FOREIGN KEY ("skillSetId") REFERENCES "public"."SkillSet"("id") ON DELETE restrict ON UPDATE cascade;