CREATE TYPE "DocumentStatus" AS ENUM ('QUARANTINED', 'QUEUED', 'CONVERTING', 'OCR_PENDING', 'OCR_PROCESSING', 'READY', 'FAILED', 'REJECTED', 'DELETING', 'DELETED');
CREATE TYPE "DocumentClassification" AS ENUM ('INTERNAL', 'CONFIDENTIAL', 'RESTRICTED');
CREATE TYPE "DocumentArtifactKind" AS ENUM ('ORIGINAL', 'PAGE_IMAGE', 'OCR_TEXT', 'OCR_MARKDOWN', 'OCR_JSON');

CREATE TABLE "Document" (
  "id" UUID NOT NULL,
  "ownerSubject" VARCHAR(200) NOT NULL,
  "fileName" VARCHAR(255) NOT NULL,
  "mediaType" VARCHAR(160) NOT NULL,
  "sizeBytes" BIGINT NOT NULL,
  "sha256" VARCHAR(64) NOT NULL,
  "classification" "DocumentClassification" NOT NULL,
  "status" "DocumentStatus" NOT NULL DEFAULT 'QUARANTINED',
  "originalObjectKey" VARCHAR(1024) NOT NULL,
  "pageCount" INTEGER,
  "processingGeneration" INTEGER NOT NULL DEFAULT 0,
  "normalizedText" TEXT,
  "normalizedMarkdown" TEXT,
  "ocrMetadata" JSONB,
  "failureCode" VARCHAR(80),
  "failureMessage" VARCHAR(500),
  "retentionUntil" TIMESTAMPTZ(6) NOT NULL,
  "approvedAt" TIMESTAMPTZ(6),
  "approvedBy" UUID,
  "completedAt" TIMESTAMPTZ(6),
  "deletedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DocumentArtifact" (
  "id" UUID NOT NULL,
  "documentId" UUID NOT NULL,
  "kind" "DocumentArtifactKind" NOT NULL,
  "pageNumber" INTEGER NOT NULL DEFAULT 0,
  "objectKey" VARCHAR(1024) NOT NULL,
  "mediaType" VARCHAR(160) NOT NULL,
  "sizeBytes" BIGINT NOT NULL,
  "sha256" VARCHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DocumentArtifact_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DocumentProcessingRun" (
  "id" UUID NOT NULL,
  "documentId" UUID NOT NULL,
  "generation" INTEGER NOT NULL,
  "conversionJobId" UUID,
  "ocrJobId" UUID,
  "startedAt" TIMESTAMPTZ(6),
  "completedAt" TIMESTAMPTZ(6),
  "failedAt" TIMESTAMPTZ(6),
  "failureCode" VARCHAR(80),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "DocumentProcessingRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Document_ownerSubject_status_updatedAt_idx" ON "Document"("ownerSubject", "status", "updatedAt");
CREATE INDEX "Document_status_createdAt_idx" ON "Document"("status", "createdAt");
CREATE INDEX "Document_retentionUntil_status_idx" ON "Document"("retentionUntil", "status");
CREATE INDEX "Document_sha256_idx" ON "Document"("sha256");
CREATE UNIQUE INDEX "DocumentArtifact_documentId_kind_pageNumber_key" ON "DocumentArtifact"("documentId", "kind", "pageNumber");
CREATE INDEX "DocumentArtifact_documentId_createdAt_idx" ON "DocumentArtifact"("documentId", "createdAt");
CREATE UNIQUE INDEX "DocumentProcessingRun_documentId_generation_key" ON "DocumentProcessingRun"("documentId", "generation");
CREATE INDEX "DocumentProcessingRun_conversionJobId_idx" ON "DocumentProcessingRun"("conversionJobId");
CREATE INDEX "DocumentProcessingRun_ocrJobId_idx" ON "DocumentProcessingRun"("ocrJobId");

ALTER TABLE "DocumentArtifact" ADD CONSTRAINT "DocumentArtifact_documentId_fkey"
FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentProcessingRun" ADD CONSTRAINT "DocumentProcessingRun_documentId_fkey"
FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
