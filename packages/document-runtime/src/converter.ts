import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_PAGES = 500;
const MAX_PAGE_BYTES = 25 * 1024 * 1024;

export interface ConvertedPage {
  pageNumber: number;
  mediaType: "image/png" | "image/jpeg";
  bytes: Uint8Array;
}

const officeExtensions = new Set([".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp"]);

async function run(command: string, args: string[], timeout: number): Promise<void> {
  try {
    await execFileAsync(command, args, {
      timeout,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch {
    throw new Error(`Document conversion command '${command}' failed.`);
  }
}

export async function convertDocumentToPages(
  original: Uint8Array,
  fileName: string,
  mediaType: string,
): Promise<ConvertedPage[]> {
  if (mediaType === "image/png" || mediaType === "image/jpeg") {
    return [{ pageNumber: 1, mediaType, bytes: original }];
  }
  const root = await mkdtemp(join(tmpdir(), "aihub-document-"));
  try {
    const sourceName = basename(fileName).replace(/[^A-Za-z0-9._-]/g, "_") || "source";
    const source = join(root, sourceName);
    const output = join(root, "pages");
    await mkdir(output);
    await writeFile(source, original);
    let pdf = source;
    if (mediaType !== "application/pdf") {
      const extension = extname(sourceName).toLowerCase();
      if (!officeExtensions.has(extension)) throw new Error("This document type cannot be converted to page images.");
      await run("soffice", ["--headless", "--convert-to", "pdf", "--outdir", root, source], 5 * 60_000);
      pdf = join(root, `${sourceName.slice(0, -extension.length)}.pdf`);
    }
    await run("pdftoppm", ["-png", "-r", "150", pdf, join(output, "page")], 10 * 60_000);
    const names = (await readdir(output))
      .filter((name) => /^page-\d+\.png$/i.test(name))
      .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
    if (names.length === 0) throw new Error("Document conversion produced no pages.");
    if (names.length > MAX_PAGES) throw new Error(`Document exceeds the ${MAX_PAGES}-page processing limit.`);
    const pages: ConvertedPage[] = [];
    for (const [index, name] of names.entries()) {
      const bytes = await readFile(join(output, name));
      if (bytes.byteLength > MAX_PAGE_BYTES) throw new Error("A converted page exceeds the image-size limit.");
      pages.push({ pageNumber: index + 1, mediaType: "image/png", bytes });
    }
    return pages;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
