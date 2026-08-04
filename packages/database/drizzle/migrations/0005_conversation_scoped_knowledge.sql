CREATE TABLE "ChatConversationDocument" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversationId" uuid NOT NULL,
	"documentId" uuid NOT NULL,
	"ownerSubject" varchar(200) NOT NULL,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "AgentRun" ADD COLUMN "knowledgeDocumentIds" uuid[];--> statement-breakpoint
ALTER TABLE "ChatConversationDocument" ADD CONSTRAINT "ChatConversationDocument_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "public"."ChatConversation"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ChatConversationDocument" ADD CONSTRAINT "ChatConversationDocument_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "public"."Document"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "ChatConversationDocument_conversationId_documentId_key" ON "ChatConversationDocument" USING btree ("conversationId","documentId");--> statement-breakpoint
CREATE INDEX "ChatConversationDocument_documentId_idx" ON "ChatConversationDocument" USING btree ("documentId");