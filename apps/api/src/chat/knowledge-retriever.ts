import { knowledgeSourceSchema, type KnowledgeSource } from "@aihub/contracts";
import type { AIHubPrismaClient } from "@aihub/database";
import { SupermemoryClient } from "@aihub/document-runtime";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface KnowledgeRetriever {
  search(ownerSubject: string, query: string): Promise<KnowledgeSource[]>;
}

export class SupermemoryKnowledgeRetriever implements KnowledgeRetriever {
  constructor(
    private readonly prisma: AIHubPrismaClient,
    private readonly client: SupermemoryClient,
  ) {}

  async search(ownerSubject: string, query: string): Promise<KnowledgeSource[]> {
    const hits = await this.client.search(ownerSubject, query);
    const documentIds = [...new Set(hits.flatMap(({ metadata }) => {
      const id = metadata.aihubDocumentId;
      return typeof id === "string" && UUID.test(id) ? [id] : [];
    }))];
    if (documentIds.length === 0) return [];
    const documents = await this.prisma.document.findMany({
      where: {
        id: { in: documentIds },
        ownerSubject,
        status: "READY",
        deletedAt: null,
        memoryPublication: { status: "READY" },
      },
      select: { id: true, fileName: true, classification: true },
    });
    const allowed = new Map(documents.map((document) => [document.id, document]));
    const seen = new Set<string>();
    return hits.flatMap((hit): KnowledgeSource[] => {
      const id = hit.metadata.aihubDocumentId;
      if (typeof id !== "string" || seen.has(id)) return [];
      const document = allowed.get(id);
      if (!document) return [];
      const excerpt = hit.chunks
        .filter(({ content }) => content.trim().length > 0)
        .slice(0, 3)
        .map(({ content }) => content.trim())
        .join("\n\n")
        .slice(0, 4_000);
      if (!excerpt) return [];
      seen.add(id);
      return [knowledgeSourceSchema.parse({
        documentId: document.id,
        fileName: document.fileName,
        classification: document.classification,
        score: hit.score,
        excerpt,
      })];
    }).slice(0, 6);
  }
}
