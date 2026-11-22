import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// HTTP-level test of POST /v1/movies/:id/review: real app, router, params validation,
// controller, movies service/repository (SQL not executed: PG is mocked), request signal and
// error mapping. Replaced: PG/Redis/logger, MovieReviewGenerationService (own unit tests) and
// the deadline (100 ms instead of 30 s). No Gemini calls, no cost.

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

vi.mock("../modules/rag/rag-deadlines.ts", () => ({
  SEARCH_DEADLINE_MS: 100,
  ANSWER_DEADLINE_MS: 100,
  REVIEW_DEADLINE_MS: 100,
}));

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));

vi.mock("../modules/rag/generation/movie-review-generation.service.ts", () => ({
  movieReviewGenerationService: { generate },
}));

const { app } = await import("../app.ts");
const { PG } = await import("../infrastructure/postgres.ts");
const { RagNotConfiguredError } = await import("../config/rag.ts");
const { RagUpstreamError } = await import("../modules/rag/rag.errors.ts");

const readQuery = vi.mocked(PG.readQuery);
const writeQuery = vi.mocked(PG.writeQuery);
const transaction = vi.mocked(PG.transaction);

const ID = "11111111-1111-4111-8111-111111111111";
const PATH = `/v1/movies/${ID}/review`;

const movie = {
  id: ID,
  title: "Arrival",
  description: "A linguist is recruited to talk to visitors.",
  release_year: 2016,
  duration_minutes: 116,
  created_at: "2026-11-19T10:00:00.123456Z",
  status: "published",
  version: 3,
};

type GenerateInput = {
  title: string;
  description: string | null;
  releaseYear: number;
  durationMinutes: number;
  signal: AbortSignal;
};

function lastInput(): GenerateInput {
  return generate.mock.lastCall?.[0] as GenerateInput;
}

/** Rejects like the SDK (bare AbortError) once the signal aborts; never settles otherwise. */
function pendingUntilAborted(input: GenerateInput): Promise<never> {
  const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });
  return new Promise((_, reject) => {
    if (input.signal.aborted) {
      reject(abortError());
      return;
    }
    input.signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  writeQuery.mockResolvedValue({ rows: [movie] } as never);
  generate.mockResolvedValue({ review: "A quiet, cerebral film.", model: "gemini-3.8-flash" });
});

describe("POST /v1/movies/:id/review", () => {
  it("returns the review with the movie id and the version it was generated from", async () => {
    const res = await request(app).post(PATH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        movieId: ID,
        movieVersion: 3,
        review: "A quiet, cerebral film.",
        model: "gemini-3.8-flash",
      },
    });
  });

  it("reads the movie from the primary and passes its fields and a request signal", async () => {
    await request(app).post(PATH);

    expect(writeQuery).toHaveBeenCalledTimes(1);
    expect(readQuery).not.toHaveBeenCalled();
    expect(writeQuery.mock.calls[0]?.[1]).toEqual([ID]);

    const input = lastInput();
    expect(input).toMatchObject({
      title: "Arrival",
      description: "A linguist is recruited to talk to visitors.",
      releaseYear: 2016,
      durationMinutes: 116,
    });
    expect(input.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not write anything (the review is not persisted)", async () => {
    await request(app).post(PATH);

    expect(transaction).not.toHaveBeenCalled();
    // The only PG call is the SELECT by id.
    expect(writeQuery.mock.calls[0]?.[0]).toMatch(/^\s*SELECT/);
  });

  it("returns 404 without calling Gemini when the movie doesn't exist", async () => {
    writeQuery.mockResolvedValue({ rows: [] } as never);

    const res = await request(app).post(PATH);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("MOVIE_NOT_FOUND");
    expect(generate).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-uuid id without touching PG or Gemini", async () => {
    const res = await request(app).post("/v1/movies/not-a-uuid/review");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(writeQuery).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("answers 500 for a DB failure (regular path, not a RAG error)", async () => {
    writeQuery.mockRejectedValue(new Error("connection terminated"));

    const res = await request(app).post(PATH);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
    expect(generate).not.toHaveBeenCalled();
  });

  it.each([
    [true, 503, "DEPENDENCY_UNAVAILABLE"],
    [false, 502, "DEPENDENCY_FAILED"],
  ])("maps a Gemini failure (retryable=%s) to %i", async (retryable, status, code) => {
    generate.mockRejectedValue(
      new RagUpstreamError("generate", "generate failed: HTTP 503 <raw>", { retryable }),
    );

    const res = await request(app).post(PATH);

    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(JSON.stringify(res.body)).not.toContain("<raw>");
  });

  it("answers 503 RAG_NOT_CONFIGURED without Gemini config", async () => {
    generate.mockRejectedValue(new RagNotConfiguredError());

    const res = await request(app).post(PATH);

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("RAG_NOT_CONFIGURED");
  });

  it("answers 504 when the deadline passes during generation", async () => {
    generate.mockImplementation(pendingUntilAborted);

    const res = await request(app).post(PATH);

    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe("DEADLINE_EXCEEDED");
  });

  it("does not start generation when the deadline passed during the DB read", async () => {
    writeQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ rows: [movie] } as never), 150);
        }),
    );

    const res = await request(app).post(PATH);

    expect(res.status).toBe(504);
    expect(generate).not.toHaveBeenCalled();
  });
});
