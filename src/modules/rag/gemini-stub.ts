// LAB: Gemini stub (owner, 2026-11-22/23: no live Gemini runs — billable, frequent 503).
// Every Gemini call site (answer, review, embeddings) runs its real code up to the SDK call
// and returns these values instead. On by default; real calls need `{ geminiStub: false }`
// in code — deliberately not an env flag, so no config value turns on billing by accident.

export const GEMINI_STUB_TEXT = "message from gemini";
export const GEMINI_STUB_MODEL = "stub";

/**
 * Constant unit vector (Cosine needs a non-zero vector). Every query maps to the same point,
 * so search results are arbitrary — the pipeline runs, relevance is meaningless.
 */
export function geminiStubEmbedding(dimensions: number): number[] {
  return Array.from({ length: dimensions }, () => 1 / Math.sqrt(dimensions));
}

export interface GeminiStubOptions {
  /** Default true: return the stub without calling Gemini. */
  geminiStub?: boolean;
}
