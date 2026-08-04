import {
  DOCUMENT_UPLOAD_ACCEPT,
  SUPPORTED_DOCUMENT_MEDIA_TYPES,
  SUPPORTED_DOCUMENT_TYPES,
  isSupportedDocumentMediaType,
} from "@orcasynapse/contracts";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXTRACTION_BOUNDS,
  ExtractionFailedError,
  TextLayerMissingError,
  UnsupportedDocumentError,
  extractDocumentText,
  extractionFormatFor,
} from "./extraction.js";

const encode = (value: string) => new TextEncoder().encode(value);

describe("the advertised document formats and the extractor", () => {
  // The upload picker, the upload route, and the extractor drifted apart once:
  // the dashboard offered images the extractor rejects and withheld xlsx and
  // pptx it accepts. This binds all three to one list.
  it("advertises exactly the media types the extractor can handle", () => {
    for (const mediaType of SUPPORTED_DOCUMENT_MEDIA_TYPES) {
      expect(extractionFormatFor(mediaType), mediaType).toBeDefined();
    }
  });

  it("advertises no type the extractor would reject", () => {
    for (const mediaType of ["image/png", "image/jpeg", "image/webp", "application/zip"]) {
      expect(SUPPORTED_DOCUMENT_MEDIA_TYPES).not.toContain(mediaType);
      expect(isSupportedDocumentMediaType(mediaType), mediaType).toBe(false);
    }
  });

  it("offers the office formats the scenario depends on", () => {
    for (const extension of [".pdf", ".docx", ".xlsx", ".pptx", ".csv", ".json"]) {
      expect(DOCUMENT_UPLOAD_ACCEPT).toContain(extension);
    }
  });

  it("pairs every extension with the media type it carries", () => {
    expect(SUPPORTED_DOCUMENT_TYPES).toHaveLength(SUPPORTED_DOCUMENT_MEDIA_TYPES.length);
    expect(new Set(SUPPORTED_DOCUMENT_TYPES.map(({ extension }) => extension)).size)
      .toBe(SUPPORTED_DOCUMENT_TYPES.length);
  });

  it("accepts a declared type that carries a charset", () => {
    expect(isSupportedDocumentMediaType("TEXT/PLAIN; charset=utf-8")).toBe(true);
  });
});

describe("extractionFormatFor", () => {
  it("maps the supported enterprise formats", () => {
    expect(extractionFormatFor("text/plain")).toBe("TEXT");
    expect(extractionFormatFor("text/markdown")).toBe("TEXT");
    expect(extractionFormatFor("application/json")).toBe("JSON");
    expect(extractionFormatFor("application/pdf")).toBe("PDF");
    expect(
      extractionFormatFor(
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ),
    ).toBe("PPTX");
  });

  it("ignores charset parameters and casing", () => {
    expect(extractionFormatFor("TEXT/PLAIN; charset=utf-8")).toBe("TEXT");
  });

  it("does not claim support for image formats", () => {
    expect(extractionFormatFor("image/png")).toBeUndefined();
    expect(extractionFormatFor("image/jpeg")).toBeUndefined();
  });
});

describe("extractDocumentText", () => {
  it("normalizes plain text and strips control characters", async () => {
    const result = await extractDocumentText({
      mediaType: "text/plain",
      bytes: encode("Approved\u0000 threshold\r\nis  ten.\n\n\n\nEnd."),
    });

    expect(result.format).toBe("TEXT");
    expect(result.text).toBe("Approved threshold\nis ten.\n\nEnd.");
    expect(result.pages).toBeNull();
  });

  it("flattens JSON into retrievable path and value lines", async () => {
    const result = await extractDocumentText({
      mediaType: "application/json",
      bytes: encode(JSON.stringify({ policy: { threshold: 10, owner: "operations" }, tags: ["a"] })),
    });

    expect(result.text).toContain("policy.threshold: 10");
    expect(result.text).toContain("policy.owner: operations");
    expect(result.text).toContain("tags[0]: a");
  });

  it("rejects an unsupported media type by name", async () => {
    await expect(
      extractDocumentText({ mediaType: "image/png", bytes: encode("binary") }),
    ).rejects.toBeInstanceOf(UnsupportedDocumentError);
  });

  it("reports invalid JSON as an extraction failure rather than a missing text layer", async () => {
    await expect(
      extractDocumentText({ mediaType: "application/json", bytes: encode("{not json") }),
    ).rejects.toBeInstanceOf(ExtractionFailedError);
  });

  it("distinguishes an empty text layer so the dashboard can require OCR", async () => {
    const error = await extractDocumentText({
      mediaType: "text/plain",
      bytes: encode("   \n\t  "),
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(TextLayerMissingError);
    expect((error as TextLayerMissingError).code).toBe("OCR_PROVIDER_REQUIRED");
  });

  it("refuses a payload beyond the configured size bound before parsing it", async () => {
    await expect(
      extractDocumentText(
        { mediaType: "text/plain", bytes: encode("hello world") },
        { ...DEFAULT_EXTRACTION_BOUNDS, maxBytes: 4 },
      ),
    ).rejects.toBeInstanceOf(ExtractionFailedError);
  });

  it("truncates at the character bound and reports that it did", async () => {
    const result = await extractDocumentText(
      { mediaType: "text/plain", bytes: encode("abcdefghij") },
      { ...DEFAULT_EXTRACTION_BOUNDS, maxCharacters: 4 },
    );

    expect(result.text).toBe("abcd");
    expect(result.truncated).toBe(true);
  });
});
