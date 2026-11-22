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

/** A chunk included in the context, with its raw content (for API/tool consumers, not the prompt). */
export interface ContextChunk extends ContextSource {
  content: string;
}

export interface BuiltContext {
  /** Prompt-formatted context (labels + content), for generation. */
  text: string;
  sources: ContextSource[];
  /** Same chunks as `sources`, same order, plus content. */
  chunks: ContextChunk[];
  includedChunks: number;
}
