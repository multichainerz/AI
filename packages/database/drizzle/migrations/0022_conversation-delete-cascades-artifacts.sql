ALTER TABLE "ChatArtifact" DROP CONSTRAINT "ChatArtifact_conversationId_fkey";
--> statement-breakpoint
ALTER TABLE "ChatArtifact" ADD CONSTRAINT "ChatArtifact_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "public"."ChatConversation"("id") ON DELETE cascade ON UPDATE cascade;