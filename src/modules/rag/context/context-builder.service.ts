import { toSingleLine } from "../prompt-safety.ts";
import type { QdrantSearchResult } from "../vector-store/qdrant.types.ts";
import type {
  BuiltContext,
  ContextBuilderOptions,
  ContextChunk,
  ContextSource,
} from "./context.types.ts";

const DEFAULT_MAX_CHUNKS = 5;
const DEFAULT_MIN_SCORE = 0;
const DEFAULT_MAX_CONTEXT_CHARS = 12_000;

export class ContextBuilderService {
  build(
    results: QdrantSearchResult[],
    options: ContextBuilderOptions = {},
  ): BuiltContext {
    const {
      maxChunks = DEFAULT_MAX_CHUNKS,
      minScore = DEFAULT_MIN_SCORE,
      maxContextChars = DEFAULT_MAX_CONTEXT_CHARS,
    } = options;

    this.validateOptions(options);

    if (results.length === 0) {
      return {
        text: "",
        sources: [],
        chunks: [],
        includedChunks: 0,
      };
    }

    // 1. Filter by minimum similarity score; drop chunks without content,
    //    otherwise their metadata labels alone would make the context non-empty.
    const filtered = results.filter(
      (result) =>
        result.score >= minScore && result.payload.content.trim() !== "",
    );

    // 2. Sort by relevance.
    const sorted = [...filtered].sort((a, b) => b.score - a.score);

    // 3. Remove duplicate document chunks.
    const unique = this.removeDuplicates(sorted);

    // 4. Select chunks within the configured limits.
    const selected = unique.slice(0, maxChunks);

    // 5. Build context while respecting character budget.
    const sources: ContextSource[] = [];
    const chunks: ContextChunk[] = [];
    const sections: string[] = [];

    let currentLength = 0;

    for (const result of selected) {
      const section = this.formatChunk(result);

      const separatorLength = sections.length > 0 ? 2 : 0;
      const nextLength = currentLength + separatorLength + section.length;

      if (nextLength > maxContextChars) {
        continue;
      }

      sections.push(section);
      currentLength = nextLength;

      const contextSource: ContextSource = {
        id: result.id,
        documentId: result.payload.documentId,
        source: result.payload.source,
        chunkIndex: result.payload.chunkIndex,
        score: result.score,
      };
      sources.push(contextSource);
      chunks.push({ ...contextSource, content: result.payload.content });
    }

    return {
      text: sections.join("\n\n"),
      sources,
      chunks,
      includedChunks: sections.length,
    };
  }

  private removeDuplicates(
    results: QdrantSearchResult[],
  ): QdrantSearchResult[] {
    const seen = new Set<string>();

    return results.filter((result) => {
      const key = [result.payload.documentId, result.payload.chunkIndex].join(
        ":",
      );

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
  }

  // Header values are kept on one line so a payload can't add fake header lines.
  // Delimiter tags are neutralized where the prompt is built (gemini-generation.service.ts),
  // so `text` here and the raw `chunks` returned by search stay unescaped.
  private formatChunk(result: QdrantSearchResult): string {
    const { documentId, source, chunkIndex, content } = result.payload;

    return [
      `[Source: ${toSingleLine(source)}]`,
      `[Document: ${toSingleLine(documentId)}]`,
      `[Chunk: ${chunkIndex}]`,
      `[Relevance score: ${result.score.toFixed(4)}]`,
      "",
      content,
    ].join("\n");
  }

  private validateOptions(options: ContextBuilderOptions): void {
    const {
      maxChunks = DEFAULT_MAX_CHUNKS,
      minScore = DEFAULT_MIN_SCORE,
      maxContextChars = DEFAULT_MAX_CONTEXT_CHARS,
    } = options;

    if (!Number.isInteger(maxChunks) || maxChunks < 1) {
      throw new Error("maxChunks must be a positive integer");
    }

    if (!Number.isFinite(minScore)) {
      throw new Error("minScore must be a finite number");
    }

    if (!Number.isInteger(maxContextChars) || maxContextChars < 1) {
      throw new Error("maxContextChars must be a positive integer");
    }
  }
}

export const contextBuilderService = new ContextBuilderService();
