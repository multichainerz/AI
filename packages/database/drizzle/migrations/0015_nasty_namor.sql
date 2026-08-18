CREATE TABLE "ChatSchedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversationId" uuid NOT NULL,
	"prompt" text NOT NULL,
	"intervalSeconds" integer NOT NULL,
	"nextRunAt" timestamp (6) with time zone NOT NULL,
	"lastRunAt" timestamp (6) with time zone,
	"lastOutcome" varchar(32),
	"lastDetail" varchar(500),
	"enabled" boolean DEFAULT true NOT NULL,
	"createdBy" uuid,
	"createdBySubject" varchar(200) NOT NULL,
	"createdByMode" varchar(32) NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL,
	CONSTRAINT "ChatSchedule_intervalSeconds_check" CHECK (("intervalSeconds" >= 300) AND ("intervalSeconds" <= 604800))
);
--> statement-breakpoint
ALTER TABLE "ChatSchedule" ADD CONSTRAINT "ChatSchedule_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "public"."ChatConversation"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "ChatSchedule_enabled_nextRunAt_idx" ON "ChatSchedule" USING btree ("enabled","nextRunAt");--> statement-breakpoint
CREATE INDEX "ChatSchedule_conversationId_idx" ON "ChatSchedule" USING btree ("conversationId");