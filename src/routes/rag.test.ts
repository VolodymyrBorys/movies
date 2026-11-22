import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// HTTP-level test: real app, router, Zod validation, controller, request signal and error
// mapping. Replaced: KnowledgeBaseSearchService (its pipeline has its own unit tests),
// PG/Redis/logger (not used by this route), and the deadline (100 ms instead of 5 s).
// Gemini/Qdrant are never reached, so no network and no cost.

vi.mock("../infrastructure/logger.ts", async () => {
  const { pino } = await import("pino");
  return { logger: pino({ level: "silent" }) };
});

vi.mock("../infrastructure/postgres.ts", () => ({
  PG: { readQuery: vi.fn(), writeQuery: vi.fn(), transaction: vi.fn() },
}));

vi.mock("../infrastructure/redis.ts", () => ({
  REDIS: {
    getMoviesListVersion: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
    invalidateMoviesList: vi.fn(),
  },
}));

vi.mock("../modules/rag/rag-deadlines.ts", () => ({ SEARCH_DEADLINE_MS: 100 }));

const { search } = vi.hoisted(() => ({ search: vi.fn() }));

vi.mock("../modules/rag/knowledge-base-search.service.ts", () => ({
  knowledgeBaseSearchService: { search },
}));

const { app } = await import("../app.ts");
const { RagNotConfiguredError } = await import("../config/rag.ts");
const { RagUpstreamError } = await import("../modules/rag/rag.errors.ts");
const { ClientDisconnectedError } = await import("../utils/request-signal.ts");
const { abortInFlightRequests } = await import("../infrastructure/shutdown-signal.ts");

const PATH = "/v1/knowledge-base/search";

type SearchOptions = {
  retrieval?: { limit?: number };
  context?: { maxChunks?: number };
  signal: AbortSignal;
};

const source = {
  id: "p1",
  documentId: "doc-1",
  source: "manual.md",
  chunkIndex: 0,
  score: 0.9,
};

const chunk = { ...source, content: "WAL replay restores committed changes." };

const searchResult = {
  context: {
    text: "[Source: manual.md]\n\nWAL replay restores committed changes.",
    sources: [source],
    chunks: [chunk],
    includedChunks: 1,
  },
  retrievedChunks: 3,
};

/** Never settles on its own; rejects like the SDK does (bare AbortError) once the signal aborts. */
function pendingUntilAborted(_input: unknown, options: SearchOptions): Promise<never> {
  const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });
  return new Promise((_, reject) => {
    // An already-aborted signal never fires 'abort' again (the real services check it first).
    if (options.signal.aborted) {
      reject(abortError());
      return;
    }
    options.signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

function lastOptions(): SearchOptions {
  const [, options] = search.mock.lastCall as [unknown, SearchOptions];
  return options;
}

beforeEach(() => {
  vi.clearAllMocks();
  search.mockResolvedValue(searchResult);
});

describe("POST /v1/knowledge-base/search", () => {
  it("returns chunks with content and retrieval metadata", async () => {
    const res = await request(app).post(PATH).send({ query: "  how does recovery work?  " });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: { chunks: [chunk], retrievedChunks: 3, includedChunks: 1 },
    });
    // Prompt-formatted text is an internal detail of generation, not part of this API.
    expect(res.body.data).not.toHaveProperty("text");
    expect(res.headers["x-request-id"]).toEqual(expect.any(String));
  });

  it("passes the trimmed query and a request signal, leaving defaults to the services", async () => {
    await request(app).post(PATH).send({ query: "  recovery  " });

    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.lastCall?.[0]).toEqual({ query: "recovery" });
    const options = lastOptions();
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options).not.toHaveProperty("retrieval");
    expect(options).not.toHaveProperty("context");
  });

  it("applies limit to both retrieval and returned chunks", async () => {
    await request(app).post(PATH).send({ query: "recovery", limit: 7 });

    expect(lastOptions()).toMatchObject({
      retrieval: { limit: 7 },
      context: { maxChunks: 7 },
    });
  });

  it("does not abort the signal after a successful response", async () => {
    await request(app).post(PATH).send({ query: "recovery" });
    const { signal } = lastOptions();

    await new Promise((resolve) => setTimeout(resolve, 150)); // past the 100 ms deadline

    expect(signal.aborted).toBe(false);
  });

  describe("validation", () => {
    it.each([
      ["missing query", {}],
      ["empty query", { query: "" }],
      ["whitespace-only query", { query: "   " }],
      ["query over 1000 chars", { query: "x".repeat(1_001) }],
      ["non-string query", { query: 42 }],
      ["limit 0", { query: "q", limit: 0 }],
      ["limit 21", { query: "q", limit: 21 }],
      ["fractional limit", { query: "q", limit: 1.5 }],
      ["string limit", { query: "q", limit: "5" }],
      ["unknown field", { query: "q", minScore: 0.5 }],
    ])("rejects %s with 400 before any upstream call", async (_name, body) => {
      const res = await request(app).post(PATH).send(body);

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(search).not.toHaveBeenCalled();
    });

    it("accepts a 1000-char query and limit 20", async () => {
      const res = await request(app)
        .post(PATH)
        .send({ query: "x".repeat(1_000), limit: 20 });

      expect(res.status).toBe(200);
    });
  });

  describe("errors", () => {
    it("answers 503 RAG_NOT_CONFIGURED without leaking env variable names", async () => {
      search.mockRejectedValue(new RagNotConfiguredError());

      const res = await request(app).post(PATH).send({ query: "q" });

      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        error: { code: "RAG_NOT_CONFIGURED", message: "RAG is not configured" },
      });
    });

    it.each([
      [true, 503, "DEPENDENCY_UNAVAILABLE"],
      [false, 502, "DEPENDENCY_FAILED"],
    ])("maps an upstream failure (retryable=%s) to %i without upstream text", async (retryable, status, code) => {
      search.mockRejectedValue(
        new RagUpstreamError("search", "search failed: Unexpected Response: 503 <raw body>", {
          retryable,
        }),
      );

      const res = await request(app).post(PATH).send({ query: "q" });

      expect(res.status).toBe(status);
      expect(res.body.error.code).toBe(code);
      expect(JSON.stringify(res.body)).not.toContain("raw body");
    });

    it("answers 504 when the deadline passes, even though the SDK threw a bare AbortError", async () => {
      search.mockImplementation(pendingUntilAborted);

      const startedAt = Date.now();
      const res = await request(app).post(PATH).send({ query: "q" });

      expect(res.status).toBe(504);
      expect(res.body.error.code).toBe("DEADLINE_EXCEEDED");
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(90);
    });

    it("aborts the pipeline when the client disconnects", async () => {
      search.mockImplementation(pendingUntilAborted);

      await expect(
        request(app).post(PATH).send({ query: "q" }).timeout(30),
      ).rejects.toThrow();

      // The server sees 'close' before the 100 ms deadline: the reason is the disconnect.
      await vi.waitFor(() => {
        expect(lastOptions().signal.reason).toBeInstanceOf(ClientDisconnectedError);
      });
    });

    it("answers 500 INTERNAL_ERROR for an unexpected error", async () => {
      search.mockRejectedValue(new Error("boom"));

      const res = await request(app).post(PATH).send({ query: "q" });

      expect(res.status).toBe(500);
      expect(res.body.error).toEqual({
        code: "INTERNAL_ERROR",
        message: "Internal server error",
      });
    });
  });
});

// Must stay last: the shutdown signal is process-wide and one-shot.
describe("POST /v1/knowledge-base/search during shutdown", () => {
  it("aborts in-flight requests with 503 and rejects new ones immediately", async () => {
    search.mockImplementation(pendingUntilAborted);

    const inFlight = request(app).post(PATH).send({ query: "q" }).then((r) => r);
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    abortInFlightRequests();

    const res = await inFlight;
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("SERVICE_SHUTTING_DOWN");

    const late = await request(app).post(PATH).send({ query: "q" });
    expect(late.status).toBe(503);
    expect(late.body.error.code).toBe("SERVICE_SHUTTING_DOWN");
    // The late request never started the (billable) pipeline.
    expect(search).toHaveBeenCalledTimes(1);
  });
});
