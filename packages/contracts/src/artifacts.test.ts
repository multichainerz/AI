import { describe, expect, it } from "vitest";
import { injectableImageMediaType, injectableTextMediaType, normalizeMediaType } from "./artifacts.js";

describe("normalizeMediaType", () => {
  it("strips RFC 6838 parameters and maps image/jpg to image/jpeg", () => {
    expect(normalizeMediaType("image/jpg")).toBe("image/jpeg");
    expect(normalizeMediaType("image/jpeg; charset=binary")).toBe("image/jpeg");
    expect(normalizeMediaType("text/plain; charset=utf-8")).toBe("text/plain");
  });
});

describe("injectableImageMediaType", () => {
  it("accepts PNG/JPEG/GIF/WebP after parameter strip", () => {
    expect(injectableImageMediaType("image/jpg")).toBe("image/jpeg");
    expect(injectableImageMediaType("image/jpeg; charset=binary")).toBe("image/jpeg");
    expect(injectableImageMediaType("image/png")).toBe("image/png");
    expect(injectableImageMediaType("image/gif")).toBe("image/gif");
    expect(injectableImageMediaType("image/webp")).toBe("image/webp");
  });

  it("rejects SVG, text, and parameterized text", () => {
    expect(injectableImageMediaType("image/svg+xml")).toBeNull();
    expect(injectableImageMediaType("text/plain")).toBeNull();
    expect(injectableImageMediaType("text/plain; charset=utf-8")).toBeNull();
  });
});

describe("injectableTextMediaType", () => {
  it("accepts parameterized plain text, markdown, and octet-stream plus a text extension", () => {
    expect(injectableTextMediaType("text/plain; charset=utf-8", "notes.txt")).toBe(true);
    expect(injectableTextMediaType("text/markdown", "x.md")).toBe(true);
    expect(injectableTextMediaType("application/octet-stream", "notes.txt")).toBe(true);
  });

  it("rejects HTML, SVG, and octet-stream without a text extension", () => {
    expect(injectableTextMediaType("text/html", "page.html")).toBe(false);
    expect(injectableTextMediaType("image/svg+xml", "vector.svg")).toBe(false);
    expect(injectableTextMediaType("application/octet-stream", "blob.bin")).toBe(false);
  });
});
