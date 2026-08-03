CREATE TYPE "MemorySyncStatus" AS ENUM ('NOT_INDEXED', 'QUEUED', 'PROCESSING', 'READY', 'FAILED', 'DELETE_PENDING', 'DELETED');

ALTER TABLE "ChatMessage" ADD COLUMN "sources" JSONB NOT NULL DEFAULT '[]';

CREATE TABLE "DocumentMemoryPublication" (
  "id" UUID NOT NULL,
  "documentId" UUID NOT NULL,
  "ownerSubject" VARCHAR(200) NOT NULL,
  "scopeTag" VARCHAR(100) NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 0,
  "status" "MemorySyncStatus" NOT NULL DEFAULT 'NOT_INDEXED',
  "externalDocumentId" VARCHAR(255),
  "jobId" UUID,
  "failureCode" VARCHAR(80),
  "failureMessage" VARCHAR(500),
  "queuedAt" TIMESTAMPTZ(6),
  "syncedAt" TIMESTAMPTZ(6),
  "deletedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "DocumentMemoryPublication_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DocumentMemoryPublication_documentId_key" ON "DocumentMemoryPublication"("documentId");
CREATE INDEX "DocumentMemoryPublication_ownerSubject_status_updatedAt_idx" ON "DocumentMemoryPublication"("ownerSubject", "status", "updatedAt");
CREATE INDEX "DocumentMemoryPublication_status_queuedAt_idx" ON "DocumentMemoryPublication"("status", "queuedAt");
CREATE INDEX "DocumentMemoryPublication_scopeTag_status_idx" ON "DocumentMemoryPublication"("scopeTag", "status");

ALTER TABLE "DocumentMemoryPublication" ADD CONSTRAINT "DocumentMemoryPublication_documentId_fkey"
FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
