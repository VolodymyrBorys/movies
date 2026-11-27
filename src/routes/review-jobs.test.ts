import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// HTTP-level test of GET /v1/review-jobs/:id: real app, router, params validation, controller
// and repository (SQL not executed: PG is mocked). PG/Redis/logger replaced.

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

const { app } = await import("../app.ts");
const { PG } = await import("../infrastructure/postgres.ts");

const readQuery = vi.mocked(PG.readQuery);
const writeQuery = vi.mocked(PG.writeQuery);

const MOVIE_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const PATH = `/v1/review-jobs/${JOB_ID}`;

const succeededRow = {
  id: JOB_ID,
  movie_id: MOVIE_ID,
  movie_version: 3,
  status: "succeeded",
  attempts: 2,
  review: "A quiet, cerebral film.",
  model: "gemini-3.8-flash",
  created_at: "2026-11-23T10:00:00.123456Z",
  started_at: "2026-11-23T10:00:01.000001Z",
  finished_at: "2026-11-23T10:00:05.000002Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  writeQuery.mockResolvedValue({ rows: [succeededRow] } as never);
});

describe("GET /v1/review-jobs/:id", () => {
  it("returns the job in camelCase with the result", async () => {
    const res = await request(app).get(PATH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: {
        id: JOB_ID,
        movieId: MOVIE_ID,
        movieVersion: 3,
        status: "succeeded",
        attempts: 2,
        review: "A quiet, cerebral film.",
        model: "gemini-3.8-flash",
        createdAt: "2026-11-23T10:00:00.123456Z",
        startedAt: "2026-11-23T10:00:01.000001Z",
        finishedAt: "2026-11-23T10:00:05.000002Z",
      },
    });
  });

  it("reads from the primary (polling right after POST is read-after-write)", async () => {
    await request(app).get(PATH);

    expect(writeQuery).toHaveBeenCalledTimes(1);
    expect(writeQuery.mock.calls[0]?.[1]).toEqual([JOB_ID]);
    expect(readQuery).not.toHaveBeenCalled();
  });

  it("never selects internal columns (last_error, lease)", async () => {
    await request(app).get(PATH);

    const sql = String(writeQuery.mock.calls[0]?.[0]);
    expect(sql).not.toMatch(/last_error|locked_by|locked_until/);
  });

  it("returns 404 REVIEW_JOB_NOT_FOUND for an unknown id", async () => {
    writeQuery.mockResolvedValue({ rows: [] } as never);

    const res = await request(app).get(PATH);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("REVIEW_JOB_NOT_FOUND");
  });

  it("returns 400 for a non-uuid id without touching PG", async () => {
    const res = await request(app).get("/v1/review-jobs/42");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(writeQuery).not.toHaveBeenCalled();
  });

  it("answers 500 for a DB failure", async () => {
    writeQuery.mockRejectedValue(new Error("connection terminated"));

    const res = await request(app).get(PATH);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
  });
});
