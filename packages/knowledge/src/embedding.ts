export const APPROVED_EMBEDDING_MODEL = "Xenova/bge-m3" as const;

/**
 * Fallback weight cache, outside the install tree so a non-root service user
 * can always write it. Deployments should override it with a mounted volume
 * via ORCASYNAPSE_MODEL_CACHE_DIR; without that the ~2 GB of weights are
 * re-downloaded on every container restart.
 */
export const DEFAULT_MODEL_CACHE_DIR = "/var/tmp/orcasynapse-models";
export const APPROVED_EMBEDDING_DIMENSIONS = 1024 as const;

export class EmbeddingUnavailableError extends Error {
  readonly code = "EMBEDDING_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingUnavailableError";
  }
}

export class EmbeddingContractError extends Error {
  readonly code = "EMBEDDING_CONTRACT_VIOLATED";
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingContractError";
  }
}

export interface TextEmbedder {
  readonly model: string;
  readonly dimensions: number;
  embed(inputs: string[]): Promise<number[][]>;
}

type FeatureExtractionPipeline = (
  inputs: string[],
  options: { pooling: "cls" | "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

/**
 * CPU-local BGE-M3 through transformers.js.
 *
 * OrcaSynapse owns this call deliberately. The previous memory service resolved
 * its own embedding model, and an upstream release silently substituted a
 * different one at a different width without failing - so retrieval quality
 * regressed invisibly. Here the model is pinned, the width is asserted on every
 * batch, and the column type rejects anything else.
 */
export class LocalBgeM3Embedder implements TextEmbedder {
  readonly model = APPROVED_EMBEDDING_MODEL;
  readonly dimensions = APPROVED_EMBEDDING_DIMENSIONS;
  #pipeline: Promise<FeatureExtractionPipeline> | undefined;

  /**
   * Where model weights are cached.
   *
   * This is not optional in practice. Left unset, `@huggingface/transformers`
   * caches inside its own directory under `node_modules`, which every shipped
   * container makes unwritable by running as a non-root user — the load then
   * fails with EACCES on the first embedding. `ORCASYNAPSE_MODEL_CACHE_DIR`
   * lets the deployment point this at a mounted volume so the weights also
   * survive a restart instead of being re-fetched.
   */
  constructor(
    private readonly cacheDirectory: string =
      process.env.ORCASYNAPSE_MODEL_CACHE_DIR ?? DEFAULT_MODEL_CACHE_DIR,
  ) {}

  private async resolve(): Promise<FeatureExtractionPipeline> {
    this.#pipeline ??= (async () => {
      try {
        // Checked before the library touches it. Transformers writes its cache
        // from a path deep inside model loading, where an EACCES surfaces as a
        // bare stack trace and — because part of that write is not awaited —
        // can escape as an unhandled rejection that kills the process. Failing
        // here instead names the directory and the fix.
        const { mkdir, access } = await import("node:fs/promises");
        const { constants } = await import("node:fs");
        try {
          await mkdir(this.cacheDirectory, { recursive: true });
          await access(this.cacheDirectory, constants.W_OK);
        } catch (cause) {
          throw new Error(
            `the model cache directory '${this.cacheDirectory}' is not writable ` +
            `(${cause instanceof Error ? cause.message : "unknown error"}). ` +
            "Set ORCASYNAPSE_MODEL_CACHE_DIR to a writable path or mount a volume there.",
          );
        }

        const transformers = await import("@huggingface/transformers");
        transformers.env.cacheDir = this.cacheDirectory;
        // Weights are resolved from the local cache; an air-gapped node must be
        // seeded at install time rather than reaching out during a request.
        const pipe = await transformers.pipeline("feature-extraction", APPROVED_EMBEDDING_MODEL);
        return pipe as unknown as FeatureExtractionPipeline;
      } catch (error) {
        this.#pipeline = undefined;
        throw new EmbeddingUnavailableError(
          `The approved local embedding model could not be loaded: ${
            error instanceof Error ? error.message.slice(0, 200) : "unknown error"
          }`,
        );
      }
    })();
    return this.#pipeline;
  }

  async embed(inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) return [];
    const pipe = await this.resolve();
    const output = await pipe(inputs, { pooling: "cls", normalize: true });
    return assertEmbeddingContract(output.tolist(), inputs.length);
  }
}

/**
 * Fails a batch whose shape does not match the approved model.
 *
 * This is the guard the previous memory service lacked: it resolved its own
 * embedding model, and an upstream release substituted a narrower one without
 * erroring, so retrieval quality regressed with nothing to observe. Here a
 * substitution is a hard failure at the first batch.
 */
export function assertEmbeddingContract(vectors: number[][], expectedCount: number): number[][] {
  if (vectors.length !== expectedCount) {
    throw new EmbeddingContractError(
      `The embedding runtime returned ${vectors.length} vectors for ${expectedCount} inputs.`,
    );
  }
  for (const vector of vectors) {
    if (vector.length !== APPROVED_EMBEDDING_DIMENSIONS) {
      throw new EmbeddingContractError(
        `The embedding runtime produced ${vector.length} dimensions; OrcaSynapse requires ${APPROVED_EMBEDDING_DIMENSIONS}.`,
      );
    }
  }
  return vectors;
}

/** Embeds in bounded batches so a large document cannot exhaust node memory. */
export async function embedInBatches(
  embedder: TextEmbedder,
  inputs: string[],
  batchSize = 16,
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let index = 0; index < inputs.length; index += batchSize) {
    vectors.push(...(await embedder.embed(inputs.slice(index, index + batchSize))));
  }
  return vectors;
}
