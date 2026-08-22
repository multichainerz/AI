CREATE TABLE "ModelObservation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connectionId" uuid NOT NULL,
	"alias" varchar(200) NOT NULL,
	"displayName" varchar(300),
	"observedContextWindowTokens" integer,
	"observedMaxOutputTokens" integer,
	"inputModalities" text[] DEFAULT '{}' NOT NULL,
	"ownedBy" varchar(200),
	"lastSeenAt" timestamp (6) with time zone NOT NULL,
	"missingFromUpstream" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ModelObservation" ADD CONSTRAINT "ModelObservation_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "public"."ServiceConnection"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "ModelObservation_connectionId_alias_key" ON "ModelObservation" USING btree ("connectionId","alias");--> statement-breakpoint
CREATE INDEX "ModelObservation_connectionId_idx" ON "ModelObservation" USING btree ("connectionId");