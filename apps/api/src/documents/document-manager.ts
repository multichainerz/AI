import type {
  DocumentDetail,
  DocumentList,
  DocumentMetrics,
  DocumentUploadMetadata,
} from "@orcasynapse/contracts";
import type { Readable } from "node:stream";

export interface DocumentPrincipal {
  id: string;
  subject: string;
  identityMode: "ENTERPRISE" | "ADMINISTRATOR_PREVIEW";
  scopes: readonly string[];
}

export interface DocumentUpload {
  fileName: string;
  declaredMediaType: string;
  stream: Readable;
}

export interface DocumentManager {
  list(principal: DocumentPrincipal): Promise<DocumentList>;
  get(principal: DocumentPrincipal, documentId: string): Promise<DocumentDetail>;
  upload(
    principal: DocumentPrincipal,
    upload: DocumentUpload,
    metadata: DocumentUploadMetadata,
  ): Promise<DocumentDetail>;
  delete(
    principal: DocumentPrincipal,
    documentId: string,
    options: { force: boolean; reason?: string | undefined },
  ): Promise<void>;
  metrics(): Promise<DocumentMetrics>;
}

export class DocumentNotFoundError extends Error {
  constructor() {
    super("The document does not exist or is not available to this identity.");
    this.name = "DocumentNotFoundError";
  }
}

export class DocumentConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentConflictError";
  }
}

export class DocumentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentValidationError";
  }
}

export class DocumentStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentStorageError";
  }
}
