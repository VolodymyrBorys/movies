import type {
  BuiltContext,
  ContextBuilderOptions,
} from "./context/context.types.ts";
import type { QdrantSearchOptions } from "./vector-store/qdrant.types.ts";

export interface KnowledgeBaseSearchInput {
  query: string;
}

// Defaults and validation live in the owning services
// (QdrantSearchService, ContextBuilderService); options are passed through as-is.
export interface KnowledgeBaseSearchOptions {
  retrieval?: QdrantSearchOptions;
  context?: ContextBuilderOptions;
  /** Cancels embedding (hard, client-side) and the Qdrant query (soft). */
  signal?: AbortSignal;
}

export interface KnowledgeBaseSearchResult {
  context: BuiltContext;
  retrievedChunks: number;
}
