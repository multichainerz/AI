import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  vector,
} from "drizzle-orm/pg-core";

/*
 * Drizzle is the typed query layer. Schema changes stay hand-written SQL under
 * prisma/migrations so the existing history - which migrations.test.ts asserts
 * on and which every deployed installation has already applied - remains the
 * single source of truth. Table and column names are quoted camelCase to match
 * what those migrations created.
 */

export const documentStatus = pgEnum("DocumentStatus", [
  "QUARANTINED",
  "QUEUED",
  "CONVERTING",
  "READY",
  "FAILED",
  "REJECTED",
  "DELETING",
  "DELETED",
]);

export const documentClassification = pgEnum("DocumentClassification", [
  "INTERNAL",
  "CONFIDENTIAL",
  "RESTRICTED",
]);

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, precision: 6 });

export const documents = pgTable(
  "Document",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerSubject: varchar("ownerSubject", { length: 200 }).notNull(),
    fileName: varchar("fileName", { length: 255 }).notNull(),
    mediaType: varchar("mediaType", { length: 160 }).notNull(),
    sizeBytes: bigint("sizeBytes", { mode: "bigint" }).notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    classification: documentClassification("classification").notNull(),
    status: documentStatus("status").notNull().default("QUEUED"),
    failureCode: varchar("failureCode", { length: 80 }),
    failureMessage: varchar("failureMessage", { length: 500 }),
    retentionUntil: timestamptz("retentionUntil").notNull(),
    completedAt: timestamptz("completedAt"),
    deletedAt: timestamptz("deletedAt"),
    createdAt: timestamptz("createdAt").notNull().defaultNow(),
    updatedAt: timestamptz("updatedAt").notNull().defaultNow(),
  },
  (table) => [
    index("Document_ownerSubject_status_updatedAt_idx").on(
      table.ownerSubject,
      table.status,
      table.updatedAt,
    ),
    index("Document_status_createdAt_idx").on(table.status, table.createdAt),
    index("Document_retentionUntil_status_idx").on(table.retentionUntil, table.status),
    index("Document_sha256_idx").on(table.sha256),
  ],
);

/**
 * Owner-scoped retrievable text extracted from a Document.
 *
 * This replaces the external Supermemory projection. The embedding is produced
 * by OrcaSynapse itself, so no upstream release can silently change the model
 * or its dimensions the way Supermemory did - the column width is the contract.
 * `ownerSubject` is denormalised from the parent so retrieval filters on the
 * owner boundary inside the index scan rather than after a join.
 */
export const documentChunks = pgTable(
  "DocumentChunk",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("documentId")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    ownerSubject: varchar("ownerSubject", { length: 200 }).notNull(),
    ordinal: integer("ordinal").notNull(),
    content: text("content").notNull(),
    characterCount: integer("characterCount").notNull(),
    embeddingModel: varchar("embeddingModel", { length: 120 }).notNull(),
    embedding: vector("embedding", { dimensions: 1024 }).notNull(),
    contentSearch: text("contentSearch"),
    createdAt: timestamptz("createdAt").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("DocumentChunk_documentId_ordinal_key").on(table.documentId, table.ordinal),
    index("DocumentChunk_ownerSubject_idx").on(table.ownerSubject),
  ],
);

export type DocumentRow = typeof documents.$inferSelect;
export type DocumentChunkRow = typeof documentChunks.$inferSelect;
export type NewDocumentChunkRow = typeof documentChunks.$inferInsert;

/** Lexical rank expression used alongside vector distance for hybrid retrieval. */
export function lexicalRank(query: string) {
  return sql<number>`ts_rank_cd(to_tsvector('simple', ${documentChunks.content}), plainto_tsquery('simple', ${query}))`;
}
