export interface ChunkBounds {
  /** Target characters per chunk. BGE-M3 handles long inputs, but smaller
   *  chunks keep retrieved excerpts specific enough to be worth injecting. */
  targetCharacters: number;
  overlapCharacters: number;
  maxChunks: number;
}

export const DEFAULT_CHUNK_BOUNDS: ChunkBounds = {
  targetCharacters: 1_200,
  overlapCharacters: 150,
  maxChunks: 4_000,
};

export interface TextChunk {
  ordinal: number;
  content: string;
}

const BOUNDARY = /\n\n+|(?<=[.!?])\s+|\n/g;

/**
 * Splits on paragraph, then sentence, then line boundaries, falling back to a
 * hard cut only when a single span exceeds the target. Overlap is applied so a
 * fact spanning a boundary is still retrievable from one side of it.
 */
export function chunkText(text: string, bounds: ChunkBounds = DEFAULT_CHUNK_BOUNDS): TextChunk[] {
  const normalized = text.trim();
  if (!normalized) return [];

  const spans: string[] = [];
  let cursor = 0;
  BOUNDARY.lastIndex = 0;
  for (const match of normalized.matchAll(BOUNDARY)) {
    const end = (match.index ?? 0) + match[0].length;
    const span = normalized.slice(cursor, end).trim();
    if (span) spans.push(span);
    cursor = end;
  }
  const tail = normalized.slice(cursor).trim();
  if (tail) spans.push(tail);

  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    const value = current.trim();
    if (value) chunks.push(value);
    current = "";
  };

  for (const span of spans) {
    if (span.length > bounds.targetCharacters) {
      flush();
      for (let index = 0; index < span.length; index += bounds.targetCharacters) {
        chunks.push(span.slice(index, index + bounds.targetCharacters).trim());
        if (chunks.length >= bounds.maxChunks) return finalize(chunks, bounds);
      }
      continue;
    }
    if (current.length + span.length + 1 > bounds.targetCharacters) flush();
    current = current ? `${current} ${span}` : span;
    if (chunks.length >= bounds.maxChunks) return finalize(chunks, bounds);
  }
  flush();

  return finalize(chunks, bounds);
}

function finalize(chunks: string[], bounds: ChunkBounds): TextChunk[] {
  return chunks
    .slice(0, bounds.maxChunks)
    .map((content, index) => {
      if (index === 0 || bounds.overlapCharacters <= 0) return { ordinal: index, content };
      const previous = chunks[index - 1] ?? "";
      const carry = previous.slice(-bounds.overlapCharacters).trim();
      return { ordinal: index, content: carry ? `${carry} ${content}` : content };
    })
    .filter(({ content }) => content.length > 0);
}
