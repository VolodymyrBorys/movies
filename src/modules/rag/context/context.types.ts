export interface ContextBuilderOptions {
  maxChunks?: number;
  minScore?: number;
  maxContextChars?: number;
}

export interface ContextSource {
  id: string | number;
  documentId: string;
  source: string;
  chunkIndex: number;
  score: number;
}

export interface BuiltContext {
  text: string;
  sources: ContextSource[];
  includedChunks: number;
}
