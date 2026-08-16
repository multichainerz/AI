CREATE TABLE "ScopedMemoryEntry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"divisionId" uuid,
	"content" text NOT NULL,
	"runId" uuid,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ScopedMemoryEntry" ADD CONSTRAINT "ScopedMemoryEntry_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "public"."Division"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "ScopedMemoryEntry_divisionId_createdAt_idx" ON "ScopedMemoryEntry" USING btree ("divisionId","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ScopedMemoryEntry_search_idx" ON "ScopedMemoryEntry" USING gin (to_tsvector('simple', "content"));