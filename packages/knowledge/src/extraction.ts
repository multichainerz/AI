import { parseOffice } from "officeparser";
import { extractText as extractPdfText, getDocumentProxy } from "unpdf";

export type ExtractionFormat = "TEXT" | "JSON" | "PDF" | "DOCX" | "PPTX" | "XLSX";

export class UnsupportedDocumentError extends Error {
  readonly code = "UNSUPPORTED_MEDIA_TYPE";
  constructor(mediaType: string) {
    super(`OrcaSynapse cannot extract text from '${mediaType}'.`);
    this.name = "UnsupportedDocumentError";
  }
}

/**
 * Raised when a structurally valid document yields no text - the signature of a
 * scanned or image-only file. It is deliberately distinct from a parse failure
 * so the dashboard can say "this needs OCR" instead of "this file is broken".
 */
export class TextLayerMissingError extends Error {
  readonly code = "OCR_PROVIDER_REQUIRED";
  constructor() {
    super(
      "This document contains no extractable text layer. Scanned and image-only files require an OCR provider, which this release does not include.",
    );
    this.name = "TextLayerMissingError";
  }
}

export class ExtractionFailedError extends Error {
  readonly code = "EXTRACTION_FAILED";
  constructor(message: string) {
    super(message);
    this.name = "ExtractionFailedError";
  }
}

const FORMATS = new Map<string, ExtractionFormat>([
  ["text/plain", "TEXT"],
  ["text/markdown", "TEXT"],
  ["text/html", "TEXT"],
  ["text/csv", "TEXT"],
  ["application/json", "JSON"],
  ["application/pdf", "PDF"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "DOCX"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "PPTX"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "XLSX"],
]);

export function extractionFormatFor(mediaType: string): ExtractionFormat | undefined {
  return FORMATS.get(mediaType.split(";")[0]!.trim().toLowerCase());
}

export interface ExtractionBounds {
  maxBytes: number;
  maxPages: number;
  maxCharacters: number;
  timeoutMs: number;
}

export const DEFAULT_EXTRACTION_BOUNDS: ExtractionBounds = {
  maxBytes: 50 * 1024 * 1024,
  maxPages: 2_000,
  maxCharacters: 4_000_000,
  timeoutMs: 120_000,
};

export interface ExtractionResult {
  format: ExtractionFormat;
  text: string;
  pages: number | null;
  truncated: boolean;
}

function normalize(value: string): string {
  return value
    .normalize("NFC")
    // Strip control characters that survive extraction; they break tsvector and
    // carry no retrieval value.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ExtractionFailedError("Document extraction exceeded its time bound.")),
      timeoutMs,
    );
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** Flattens arbitrary JSON into retrievable "path: value" lines. */
function flattenJson(value: unknown, path: string, lines: string[], depth = 0): void {
  if (lines.length > 50_000 || depth > 32) return;
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    lines.push(`${path}: ${String(value)}`);
    return;
  }
  if (typeof value === "string") {
    if (value.trim()) lines.push(`${path}: ${value}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenJson(item, `${path}[${index}]`, lines, depth + 1));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      flattenJson(nested, path ? `${path}.${key}` : key, lines, depth + 1);
    }
  }
}

export async function extractDocumentText(
  input: { mediaType: string; bytes: Uint8Array },
  bounds: ExtractionBounds = DEFAULT_EXTRACTION_BOUNDS,
): Promise<ExtractionResult> {
  const format = extractionFormatFor(input.mediaType);
  if (!format) throw new UnsupportedDocumentError(input.mediaType);
  if (input.bytes.byteLength > bounds.maxBytes) {
    throw new ExtractionFailedError("The document exceeds the configured extraction size bound.");
  }

  const extracted = await withTimeout(
    (async (): Promise<{ text: string; pages: number | null }> => {
      switch (format) {
        case "TEXT":
          return { text: new TextDecoder("utf-8", { fatal: false }).decode(input.bytes), pages: null };
        case "JSON": {
          const raw = new TextDecoder("utf-8", { fatal: false }).decode(input.bytes);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            throw new ExtractionFailedError("The document is not valid JSON.");
          }
          const lines: string[] = [];
          flattenJson(parsed, "", lines);
          return { text: lines.join("\n"), pages: null };
        }
        case "PDF": {
          const proxy = await getDocumentProxy(input.bytes);
          if (proxy.numPages > bounds.maxPages) {
            throw new ExtractionFailedError("The document exceeds the configured page bound.");
          }
          const { text } = await extractPdfText(proxy, { mergePages: true });
          return { text: Array.isArray(text) ? text.join("\n\n") : text, pages: proxy.numPages };
        }
        default: {
          // officeparser reads the OOXML parts directly; no conversion service.
          const ast = await parseOffice(Buffer.from(input.bytes));
          return { text: ast.toText(), pages: null };
        }
      }
    })(),
    bounds.timeoutMs,
  ).catch((error: unknown) => {
    if (error instanceof ExtractionFailedError || error instanceof TextLayerMissingError) throw error;
    throw new ExtractionFailedError(
      error instanceof Error ? error.message.slice(0, 300) : "Document extraction failed.",
    );
  });

  const normalized = normalize(extracted.text);
  if (!normalized) throw new TextLayerMissingError();

  return {
    format,
    text: normalized.slice(0, bounds.maxCharacters),
    pages: extracted.pages,
    truncated: normalized.length > bounds.maxCharacters,
  };
}
