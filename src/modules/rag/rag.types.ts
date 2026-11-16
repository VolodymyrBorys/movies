import type { ContextSource } from "./context/context.types.ts";

export interface RagAnswerInput {
  question: string;
}

export interface RagAnswerOptions {
  retrieval?: {
    limit?: number;
    scoreThreshold?: number;
  };
  context?: {
    maxChunks?: number;
    minScore?: number;
    maxContextChars?: number;
  };
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
