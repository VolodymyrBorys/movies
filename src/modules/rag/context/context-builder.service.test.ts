import { describe, expect, it } from "vitest";
import type { QdrantSearchResult } from "../vector-store/qdrant.types.ts";
import { ContextBuilderService } from "./context-builder.service.ts";

function result(
  id: number,
  score: number,
  chunkIndex: number,
  content = `content ${id}`,
  documentId = "doc-1",
): QdrantSearchResult {
  return {
    id,
    score,
    payload: {
      documentId,
      source: "source.md",
      chunkIndex,
      content,
      indexedAt: "2026-11-16T00:00:00.000Z",
    },
  };
}

describe("ContextBuilderService", () => {
  const builder = new ContextBuilderService();

  it("returns an empty context for no results", () => {
    expect(builder.build([])).toEqual({
      text: "",
      sources: [],
      includedChunks: 0,
    });
  });

  it("returns an empty context when all chunks have empty content", () => {
    const context = builder.build([result(1, 0.9, 0, "   "), result(2, 0.8, 1, "")]);

    expect(context.text).toBe("");
    expect(context.sources).toEqual([]);
    expect(context.includedChunks).toBe(0);
  });

  it("sorts by score and removes duplicate document chunks", () => {
    const context = builder.build([
      result(1, 0.5, 0),
      result(2, 0.9, 1),
      result(3, 0.9, 1),
    ]);

    expect(context.sources.map((s) => s.chunkIndex)).toEqual([1, 0]);
    expect(context.includedChunks).toBe(2);
  });

  it("preserves source metadata", () => {
    const context = builder.build([result(7, 0.75, 3)]);

    expect(context.sources).toEqual([
      {
        id: 7,
        documentId: "doc-1",
        source: "source.md",
        chunkIndex: 3,
        score: 0.75,
      },
    ]);
  });

  it("filters out chunks below minScore", () => {
    const context = builder.build([result(1, 0.5, 0), result(2, 0.7, 1)], {
      minScore: 0.6,
    });

    expect(context.sources.map((s) => s.id)).toEqual([2]);
  });

  it("limits the number of chunks to maxChunks", () => {
    const context = builder.build(
      [result(1, 0.9, 0), result(2, 0.8, 1), result(3, 0.7, 2)],
      { maxChunks: 2 },
    );

    expect(context.includedChunks).toBe(2);
  });

  it("skips chunks that would exceed maxContextChars", () => {
    const context = builder.build([result(1, 0.9, 0, "x".repeat(50))], {
      maxContextChars: 10,
    });

    expect(context.text).toBe("");
    expect(context.includedChunks).toBe(0);
  });

  it.each([
    [{ maxChunks: 0 }, "maxChunks"],
    [{ minScore: Number.NaN }, "minScore"],
    [{ maxContextChars: 1.5 }, "maxContextChars"],
  ])("rejects invalid options %o", (options, field) => {
    expect(() => builder.build([], options)).toThrow(field);
  });
});
