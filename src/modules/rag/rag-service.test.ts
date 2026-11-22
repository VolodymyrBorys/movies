import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuiltContext } from "./context/context.types.ts";

// Replaced: retrieval (KnowledgeBaseSearchService) and generation (Gemini).
// Both have their own tests; here only RagService orchestration is under test.
const { kbSearch, generate } = vi.hoisted(() => ({
  kbSearch: vi.fn(),
  generate: vi.fn(),
}));

vi.mock("./knowledge-base-search.service.ts", () => ({
  knowledgeBaseSearchService: { search: kbSearch },
}));

vi.mock("./generation/gemini-generation.service.ts", () => ({
  geminiGenerationService: { generate },
}));

const { RagService } = await import("./rag-service.ts");

const filledContext: BuiltContext = {
  text: "[Source: manual.md]\n\nWAL replay.",
  sources: [
    { id: "p1", documentId: "doc-1", source: "manual.md", chunkIndex: 0, score: 0.9 },
  ],
  chunks: [
    {
      id: "p1",
      documentId: "doc-1",
      source: "manual.md",
      chunkIndex: 0,
      score: 0.9,
      content: "WAL replay.",
    },
  ],
  includedChunks: 1,
};

const emptyContext: BuiltContext = {
  text: "",
  sources: [],
  chunks: [],
  includedChunks: 0,
};

describe("RagService", () => {
  const service = new RagService();

  beforeEach(() => {
    kbSearch.mockReset();
    generate.mockReset();
    kbSearch.mockResolvedValue({ context: filledContext, retrievedChunks: 5 });
    generate.mockResolvedValue({ answer: "Use WAL.", model: "test-model" });
  });

  it("rejects an empty question without any external call", async () => {
    await expect(service.answer({ question: "  " })).rejects.toThrow(
      "Question cannot be empty",
    );
    expect(kbSearch).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("passes the trimmed question and all options (incl. signal) to retrieval", async () => {
    const controller = new AbortController();
    const options = {
      retrieval: { limit: 3, scoreThreshold: 0.4 },
      context: { maxChunks: 2, minScore: 0.6 },
      signal: controller.signal,
    };

    await service.answer({ question: "  question  " }, options);

    expect(kbSearch).toHaveBeenCalledWith({ query: "question" }, options);
  });

  describe("empty context", () => {
    it("does not call Gemini and reports generationSkipped", async () => {
      kbSearch.mockResolvedValue({ context: emptyContext, retrievedChunks: 4 });

      const result = await service.answer({ question: "question" });

      expect(generate).not.toHaveBeenCalled();
      expect(result).toEqual({
        answer: expect.stringContaining("don't have enough relevant information"),
        model: null,
        sources: [],
        metadata: {
          retrievedChunks: 4,
          includedChunks: 0,
          contextLength: 0,
          generationSkipped: true,
        },
      });
    });
  });

  describe("with context", () => {
    it("generates an answer and preserves sources and metadata", async () => {
      const result = await service.answer({ question: "question" });

      expect(generate).toHaveBeenCalledWith({
        question: "question",
        context: filledContext.text,
      });
      expect(result).toEqual({
        answer: "Use WAL.",
        model: "test-model",
        sources: filledContext.sources,
        metadata: {
          retrievedChunks: 5,
          includedChunks: 1,
          contextLength: filledContext.text.length,
          generationSkipped: false,
        },
      });
    });

    it("omits signal from generation input when none is given (exactOptionalPropertyTypes)", async () => {
      await service.answer({ question: "question" });

      expect(generate.mock.lastCall?.[0]).not.toHaveProperty("signal");
    });

    it("forwards the signal to generation", async () => {
      const controller = new AbortController();

      await service.answer({ question: "question" }, { signal: controller.signal });

      expect(generate.mock.lastCall?.[0]).toMatchObject({ signal: controller.signal });
    });
  });

  describe("errors", () => {
    it("does not call Gemini when retrieval fails", async () => {
      const error = new DOMException("aborted", "AbortError");
      kbSearch.mockRejectedValue(error);

      await expect(service.answer({ question: "question" })).rejects.toBe(error);
      expect(generate).not.toHaveBeenCalled();
    });

    it("propagates generation errors unchanged", async () => {
      const error = Object.assign(new Error("HTTP 503"), { status: 503 });
      generate.mockRejectedValue(error);

      await expect(service.answer({ question: "question" })).rejects.toBe(error);
    });
  });
});
