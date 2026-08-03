-- OrcaSynapse owns document retrieval locally instead of delegating it to an
-- external memory service. The embedding dimension is fixed in the column type
-- so a runtime cannot silently index a different model than the one approved.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "DocumentChunk" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "documentId" UUID NOT NULL,
    "ownerSubject" VARCHAR(200) NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "characterCount" INTEGER NOT NULL,
    "embeddingModel" VARCHAR(120) NOT NULL,
    "embedding" vector(1024) NOT NULL,
    "contentSearch" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DocumentChunk_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DocumentChunk_documentId_ordinal_key" ON "DocumentChunk"("documentId", "ordinal");
CREATE INDEX "DocumentChunk_ownerSubject_idx" ON "DocumentChunk"("ownerSubject");

-- Cosine distance matches the normalised embeddings BGE-M3 produces.
CREATE INDEX "DocumentChunk_embedding_idx"
    ON "DocumentChunk" USING hnsw ("embedding" vector_cosine_ops);

-- The 'simple' configuration is deliberate: it applies no language-specific
-- stemming, so Indonesian and English terms are both indexed literally and
-- lexical recall does not silently degrade for non-English content.
CREATE INDEX "DocumentChunk_content_fts_idx"
    ON "DocumentChunk" USING gin (to_tsvector('simple', "content"));

ALTER TABLE "DocumentChunk"
    ADD CONSTRAINT "DocumentChunk_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "Document"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
