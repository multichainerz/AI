CREATE TYPE "ChatFeedbackRating" AS ENUM ('HELPFUL', 'NOT_HELPFUL');

CREATE TABLE "ChatFeedback" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "ownerSubject" VARCHAR(200) NOT NULL,
    "rating" "ChatFeedbackRating" NOT NULL,
    "comment" VARCHAR(1000),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "ChatFeedback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChatFeedback_messageId_key" ON "ChatFeedback"("messageId");
CREATE INDEX "ChatFeedback_ownerSubject_createdAt_idx" ON "ChatFeedback"("ownerSubject", "createdAt");
CREATE INDEX "ChatFeedback_rating_createdAt_idx" ON "ChatFeedback"("rating", "createdAt");

ALTER TABLE "ChatFeedback"
ADD CONSTRAINT "ChatFeedback_messageId_fkey"
FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
