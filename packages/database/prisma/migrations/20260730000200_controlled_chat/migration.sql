CREATE TYPE "ChatConversationStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "ChatMessageRole" AS ENUM ('USER', 'ASSISTANT');
CREATE TYPE "ChatMessageStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'CANCELLED');

CREATE TABLE "ChatConversation" (
  "id" UUID NOT NULL,
  "ownerSubject" VARCHAR(200) NOT NULL,
  "title" VARCHAR(160) NOT NULL,
  "modelAlias" VARCHAR(200) NOT NULL,
  "status" "ChatConversationStatus" NOT NULL DEFAULT 'ACTIVE',
  "generation" INTEGER NOT NULL DEFAULT 0,
  "lastMessageAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "ChatConversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChatMessage" (
  "id" UUID NOT NULL,
  "conversationId" UUID NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "role" "ChatMessageRole" NOT NULL,
  "status" "ChatMessageStatus" NOT NULL,
  "content" TEXT NOT NULL,
  "modelAlias" VARCHAR(200),
  "inputTokens" INTEGER,
  "outputTokens" INTEGER,
  "totalTokens" INTEGER,
  "latencyMs" INTEGER,
  "finishReason" VARCHAR(120),
  "providerRequestId" VARCHAR(200),
  "errorCode" VARCHAR(80),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMPTZ(6),
  CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ChatConversation_ownerSubject_status_updatedAt_idx"
  ON "ChatConversation"("ownerSubject", "status", "updatedAt");
CREATE INDEX "ChatConversation_lastMessageAt_idx" ON "ChatConversation"("lastMessageAt");
CREATE UNIQUE INDEX "ChatMessage_conversationId_ordinal_key"
  ON "ChatMessage"("conversationId", "ordinal");
CREATE INDEX "ChatMessage_conversationId_createdAt_idx"
  ON "ChatMessage"("conversationId", "createdAt");
CREATE INDEX "ChatMessage_status_createdAt_idx" ON "ChatMessage"("status", "createdAt");

ALTER TABLE "ChatMessage"
  ADD CONSTRAINT "ChatMessage_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "ChatConversation"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
