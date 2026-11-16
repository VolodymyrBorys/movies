import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QdrantSearchResult } from "./vector-store/qdrant.types.ts";

// Replaced: QdrantSearchService (I/O, own tests). ContextBuilderService stays real
// (pure); a pass-through spy only checks which options reach it.
const { search } = vi.hoisted(() => ({ search: vi.fn() }));

vi.mock("./vector-store/qdrant-search.service.ts", () => ({
  qdrantSearchService: { search },
}));

const { KnowledgeBaseSearchService } = await import(
  "./knowledge-base-search.service.ts"
);
const { contextBuilderService } = await import(
  "./context/context-builder.service.ts"
);

function result(id: number, score: number, chunkIndex: number): QdrantSearchResult {
  return {
    id,
    score,
    payload: {
      documentId: "doc-1",
      source: "manual.md",
      chunkIndex,
      content: `content ${id}`,
      indexedAt: "2026-11-16T00:00:00.000Z",
    },
  };
}

describe("KnowledgeBaseSearchService", () => {
  const service = new KnowledgeBaseSearchService();
  const results = [result(1, 0.9, 0), result(2, 0.8, 1), result(3, 0.5, 2)];

  beforeEach(() => {
    search.mockReset();
    search.mockResolvedValue(results);
  });

  it("rejects an empty query without searching", async () => {
    await expect(service.search({ query: "   " })).rejects.toThrow(
      "Search query cannot be empty",
    );
    expect(search).not.toHaveBeenCalled();
  });

  it("searches with the trimmed query and leaves defaults to the owning services", async () => {
    const build = vi.spyOn(contextBuilderService, "build");

    await service.search({ query: "  question  " });

    expect(search).toHaveBeenCalledWith("question", undefined, undefined);
    expect(build).toHaveBeenCalledWith(results, undefined);
  });

  it("passes retrieval options, context options and signal through unchanged", async () => {
    const build = vi.spyOn(contextBuilderService, "build");
    const controller = new AbortController();
    const retrieval = { limit: 10, scoreThreshold: 0.3, documentId: "doc-1", source: "manual.md" };
    const context = { maxChunks: 2, minScore: 0.6, maxContextChars: 5_000 };

    await service.search(
      { query: "question" },
      { retrieval, context, signal: controller.signal },
    );

    expect(search).toHaveBeenCalledWith("question", retrieval, controller.signal);
    expect(build).toHaveBeenCalledWith(results, context);
  });

  it("returns the built context and the number of retrieved chunks", async () => {
    const { context, retrievedChunks } = await service.search(
      { query: "question" },
      { context: { minScore: 0.6 } },
    );

    expect(retrievedChunks).toBe(3);
    expect(context.includedChunks).toBe(2);
    expect(context.sources.map((s) => s.id)).toEqual([1, 2]);
  });

  it("does not build context when retrieval fails", async () => {
    const build = vi.spyOn(contextBuilderService, "build");
    const error = new DOMException("aborted", "AbortError");
    search.mockRejectedValue(error);

    await expect(service.search({ query: "question" })).rejects.toBe(error);
    expect(build).not.toHaveBeenCalled();
  });
});
