import { z } from "zod";
import { documentClassificationSchema } from "./documents.js";

export const knowledgeSourceSchema = z.object({
  documentId: z.uuid(),
  fileName: z.string().min(1).max(255),
  classification: documentClassificationSchema,
  score: z.number().min(0).max(1),
  excerpt: z.string().min(1).max(4_000),
});

export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema>;
