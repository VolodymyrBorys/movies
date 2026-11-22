import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Replaced: the Qdrant client (external I/O) and EmbeddingService (collaborator
// with its own tests). Search orchestration, validation and cancellation stay real.
// `query` only records calls. The Qdrant promise is returned by `qdrant.respond`
// and deliberately bypasses vi.fn: Vitest spies attach handlers to returned
// promises (settledResults), which would hide unhandled rejections from tests.
const { query, embedQuery, qdrant } = vi.hoisted(() => ({
  query: vi.fn(),
  embedQuery: vi.fn(),
  qdrant: { respond: (): Promise<unknown> => Promise.resolve({ points: [] }) },
}));

vi.mock("../../../infrastructure/qdrant/qdrant.client.ts", () => ({
  getQdrantClient: () => ({
    query: (...args: unknown[]): Promise<unknown> => {
      query(...args);
      return qdrant.respond();
    },
  }),
}));

vi.mock("../embedding/embedding.service.ts", () => ({
  embeddingService: { embedQuery },
}));

const { QdrantSearchService } = await import("./qdrant-search.service.ts");
const { RagInputError, RagUpstreamError } = await import("../rag.errors.ts");

type QueryArgs = Record<string, unknown>;

const vector = [0.1, 0.2, 0.3];

function point(id: string, score: number, payload: unknown) {
  return { id, score, payload };
}

const validPayload = {
  documentId: "doc-1",
  content: "Secret document body",
  source: "manual.md",
  chunkIndex: 2,
  indexedAt: "2026-11-16T00:00:00.000Z",
};

function lastQueryArgs(): QueryArgs {
  const [, args] = query.mock.lastCall as [string, QueryArgs];
  return args;
}

/** Resolves on the next macrotask, so the caller can be cancelled meanwhile. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("QdrantSearchService", () => {
  const service = new QdrantSearchService();

  beforeEach(() => {
    query.mockReset();
    embedQuery.mockReset();
    embedQuery.mockResolvedValue(vector);
    qdrant.respond = () =>
      Promise.resolve({ points: [point("p1", 0.9, validPayload)] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("request building", () => {
    it("uses default limit 5 and omits optional fields", async () => {
      await service.search("question");

      const args = lastQueryArgs();
      expect(query.mock.lastCall?.[0]).toBe("technical_documents");
      expect(args).toMatchObject({ query: vector, limit: 5, with_payload: true });
      expect(args).not.toHaveProperty("score_threshold");
      expect(args).not.toHaveProperty("filter");
    });

    it("embeds the trimmed query", async () => {
      await service.search("  question  ");

      expect(embedQuery.mock.lastCall?.[0]).toBe("question");
    });

    it("adds score_threshold and metadata filters only when given", async () => {
      await service.search("question", {
        limit: 10,
        scoreThreshold: 0.5,
        documentId: "doc-1",
        source: "manual.md",
      });

      expect(lastQueryArgs()).toMatchObject({
        limit: 10,
        score_threshold: 0.5,
        filter: {
          must: [
            { key: "documentId", match: { value: "doc-1" } },
            { key: "source", match: { value: "manual.md" } },
          ],
        },
      });
    });
  });

  describe("validation", () => {
    it.each([
      ["empty query", "  ", {}, "Search query cannot be empty"],
      ["limit 0", "q", { limit: 0 }, "limit must be"],
      ["limit 51", "q", { limit: 51 }, "limit must be"],
      ["fractional limit", "q", { limit: 1.5 }, "limit must be"],
      ["scoreThreshold 2", "q", { scoreThreshold: 2 }, "scoreThreshold must be"],
      ["NaN scoreThreshold", "q", { scoreThreshold: Number.NaN }, "scoreThreshold must be"],
    ])("rejects %s before any external call", async (_name, q, options, message) => {
      await expect(service.search(q, options)).rejects.toThrow(message);
      await expect(service.search(q, options)).rejects.toBeInstanceOf(RagInputError);
      expect(embedQuery).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe("response mapping", () => {
    it("maps points to domain results", async () => {
      await expect(service.search("question")).resolves.toEqual([
        { id: "p1", score: 0.9, payload: validPayload },
      ]);
    });

    it.each([
      ["null payload", null, "without payload"],
      ["missing content", { ...validPayload, content: undefined }, "invalid document payload"],
      ["string chunkIndex", { ...validPayload, chunkIndex: "2" }, "invalid document payload"],
    ])("rejects %s", async (_name, payload, message) => {
      qdrant.respond = () =>
        Promise.resolve({ points: [point("p1", 0.9, payload)] });

      await expect(service.search("question")).rejects.toThrow(message);
      await expect(service.search("question")).rejects.toMatchObject({
        name: "RagUpstreamError",
        stage: "search",
        retryable: false,
      });
    });

    it.each([
      ["HTTP 503", Object.assign(new Error("HTTP 503"), { status: 503 }), true],
      ["client timeout", Object.assign(new Error("timeout"), { name: "QdrantClientTimeoutError" }), true],
      ["HTTP 404", Object.assign(new Error("HTTP 404"), { status: 404 }), false],
    ])("wraps a Qdrant %s as a search failure, keeping the cause", async (_name, error, retryable) => {
      qdrant.respond = () => Promise.reject(error);

      const rejection = await service.search("question").catch((e: unknown) => e);

      expect(rejection).toMatchObject({
        name: "RagUpstreamError",
        stage: "search",
        retryable,
        cause: error,
      });
    });

    it("does not re-wrap an embedding failure as a search failure", async () => {
      const error = new RagUpstreamError("embed", "embed failed", { retryable: true });
      embedQuery.mockRejectedValue(error);

      await expect(service.search("question")).rejects.toBe(error);
    });

    it("does not log retrieved document content", async () => {
      const spies = (["log", "info", "warn", "error", "dir", "debug"] as const).map(
        (method) => vi.spyOn(console, method).mockImplementation(() => {}),
      );

      await service.search("question");

      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    });
  });

  describe("cancellation", () => {
    it("does nothing when the signal is already aborted", async () => {
      await expect(
        service.search("question", {}, AbortSignal.abort()),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(embedQuery).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    });

    it("forwards the signal to embedding", async () => {
      const controller = new AbortController();

      await service.search("question", {}, controller.signal);

      expect(embedQuery.mock.lastCall?.[1]).toBe(controller.signal);
    });

    it("does not start the Qdrant query when cancelled during embedding", async () => {
      const controller = new AbortController();
      embedQuery.mockImplementation(async () => {
        controller.abort();
        return vector;
      });

      await expect(
        service.search("question", {}, controller.signal),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(query).not.toHaveBeenCalled();
    });

    it("releases the caller immediately when cancelled during the Qdrant query (soft cancel)", async () => {
      const controller = new AbortController();
      const pending = deferred<unknown>();
      qdrant.respond = () => pending.promise;

      const search = service.search("question", {}, controller.signal);
      await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
      controller.abort();

      await expect(search).rejects.toMatchObject({ name: "AbortError" });

      // The underlying request finishes later; nothing must blow up.
      pending.resolve({ points: [] });
    });

    it("does not leak an unhandled rejection when the query fails after cancellation", async () => {
      const controller = new AbortController();
      const pending = deferred<unknown>();
      qdrant.respond = () => pending.promise;
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);

      try {
        const search = service.search("question", {}, controller.signal);
        await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
        controller.abort();
        await expect(search).rejects.toMatchObject({ name: "AbortError" });

        pending.reject(new Error("late Qdrant failure"));
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    });

    it("does not leak an unhandled rejection when cancelled during embedding and the query fails", async () => {
      const controller = new AbortController();
      embedQuery.mockImplementation(async () => {
        controller.abort();
        return vector;
      });
      qdrant.respond = () => Promise.reject(new Error("Qdrant failure"));
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);

      try {
        await expect(
          service.search("question", {}, controller.signal),
        ).rejects.toMatchObject({ name: "AbortError" });
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    });
  });
});
