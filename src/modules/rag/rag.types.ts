import type {
  ContextBuilderOptions,
  ContextSource,
} from "./context/context.types.ts";
import type { QdrantSearchOptions } from "./vector-store/qdrant.types.ts";

export interface RagAnswerInput {
  question: string;
}

// Same public shape as before; reuses the owning services' option types.
export interface RagAnswerOptions {
  retrieval?: Pick<QdrantSearchOptions, "limit" | "scoreThreshold">;
  context?: ContextBuilderOptions;
}

export interface RagAnswerResult {
  answer: string;
  model: string | null;
  sources: ContextSource[];
  metadata: {
    retrievedChunks: number;
    includedChunks: number;
    contextLength: number;
    generationSkipped: boolean;
  };
}
