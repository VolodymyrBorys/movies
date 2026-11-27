import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// HTTP-level test of POST /v1/movies/:id/review (async, P5.2): real app, router, params
// validation, controller and review-jobs repository (SQL not executed: PG is mocked — the
// real SQL, dedupe and atomicity are proven in review-jobs.int.test.ts). PG/Redis/logger
// replaced; the review generator is mocked only to prove the API never calls it.

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

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));

vi.mock("../modules/rag/generation/movie-review-generation.service.ts", () => ({
  movieReviewGenerationService: { generate },
}));

const { app } = await import("../app.ts");
const { PG } = await import("../infrastructure/postgres.ts");

const readQuery = vi.mocked(PG.readQuery);
const writeQuery = vi.mocked(PG.writeQuery);
const transaction = vi.mocked(PG.transaction);

const MOVIE_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const PATH = `/v1/movies/${MOVIE_ID}/review`;

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    movie_id: MOVIE_ID,
    movie_version: 3,
    status: "queued",
    attempts: 0,
    review: null,
    model: null,
    created_at: "2026-11-23T10:00:00.123456Z",
    started_at: null,
    finished_at: null,
    ...overrides,
  };
}

interface FakeDb {
  movie?: unknown[];
  inserted?: unknown[];
  existing?: unknown[];
  insertError?: unknown;
}

/** Routes each SQL statement inside PG.transaction to canned rows. */
function fakeTransaction(db: FakeDb) {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (/FROM movies/.test(sql)) return { rows: db.movie ?? [{ version: 3 }] };
    if (/INSERT INTO review_jobs/.test(sql)) {
      if (db.insertError !== undefined) throw db.insertError;
      return { rows: db.inserted ?? [] };
    }
    if (/FROM review_jobs/.test(sql)) return { rows: db.existing ?? [] };
    if (/INSERT INTO message_outbox/.test(sql)) return { rows: [] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  transaction.mockImplementation(async (callback) => callback({ query } as never));
  return query;
}

function calls(query: ReturnType<typeof fakeTransaction>, pattern: RegExp) {
  return query.mock.calls.filter(([sql]) => pattern.test(sql));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /v1/movies/:id/review (async job)", () => {
  it("creates a job for the current movie version: 202 + Location, camelCase body", async () => {
    fakeTransaction({ inserted: [jobRow()] });

    const res = await request(app).post(PATH);

    expect(res.status).toBe(202);
    expect(res.headers.location).toBe(`/v1/review-jobs/${JOB_ID}`);
    expect(res.body).toEqual({
      data: {
        id: JOB_ID,
        movieId: MOVIE_ID,
        movieVersion: 3,
        status: "queued",
        attempts: 0,
        review: null,
        model: null,
        createdAt: "2026-11-23T10:00:00.123456Z",
        startedAt: null,
        finishedAt: null,
      },
    });
  });

  it("inserts the job for the version it read and review.requested in the same transaction", async () => {
    const query = fakeTransaction({ inserted: [jobRow()] });

    await request(app).post(PATH);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(calls(query, /INSERT INTO review_jobs/)[0]?.[1]).toEqual([MOVIE_ID, 3]);

    const outbox = calls(query, /INSERT INTO message_outbox/);
    expect(outbox).toHaveLength(1);
    const [aggregateType, aggregateId, routingKey, payload] = outbox[0]?.[1] as unknown[];
    expect([aggregateType, aggregateId, routingKey]).toEqual([
      "review_job",
      JOB_ID,
      "review.requested",
    ]);
    expect(JSON.parse(payload as string)).toEqual({
      schemaVersion: 1,
      jobId: JOB_ID,
      movieId: MOVIE_ID,
      movieVersion: 3,
    });
  });

  it("never calls the review generator (the worker does, P5.4)", async () => {
    fakeTransaction({ inserted: [jobRow()] });

    await request(app).post(PATH);

    expect(generate).not.toHaveBeenCalled();
  });

  it.each([["queued"], ["running"]])(
    "returns the existing %s job with 202 and enqueues no new message",
    async (status) => {
      const query = fakeTransaction({ inserted: [], existing: [jobRow({ status })] });

      const res = await request(app).post(PATH);

      expect(res.status).toBe(202);
      expect(res.headers.location).toBe(`/v1/review-jobs/${JOB_ID}`);
      expect(res.body.data.status).toBe(status);
      expect(calls(query, /INSERT INTO message_outbox/)).toHaveLength(0);
    },
  );

  it("returns an already succeeded job with 200 and the review", async () => {
    const succeeded = jobRow({
      status: "succeeded",
      attempts: 1,
      review: "A quiet, cerebral film.",
      model: "gemini-3.8-flash",
      started_at: "2026-11-23T10:00:01.000001Z",
      finished_at: "2026-11-23T10:00:05.000002Z",
    });
    const query = fakeTransaction({ inserted: [], existing: [succeeded] });

    const res = await request(app).post(PATH);

    expect(res.status).toBe(200);
    expect(res.headers.location).toBe(`/v1/review-jobs/${JOB_ID}`);
    expect(res.body.data).toMatchObject({
      status: "succeeded",
      review: "A quiet, cerebral film.",
      model: "gemini-3.8-flash",
      finishedAt: "2026-11-23T10:00:05.000002Z",
    });
    expect(calls(query, /INSERT INTO message_outbox/)).toHaveLength(0);
  });

  it("retries the insert once when the conflicting job left the active set", async () => {
    // Round 1: conflict, but the job is gone from queued/running/succeeded by the SELECT.
    let insertRound = 0;
    const query = vi.fn(async (sql: string) => {
      if (/FROM movies/.test(sql)) return { rows: [{ version: 3 }] };
      if (/INSERT INTO review_jobs/.test(sql)) {
        insertRound += 1;
        return { rows: insertRound === 1 ? [] : [jobRow()] };
      }
      if (/FROM review_jobs/.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    transaction.mockImplementation(async (callback) => callback({ query } as never));

    const res = await request(app).post(PATH);

    expect(res.status).toBe(202);
    expect(insertRound).toBe(2);
    expect(calls(query, /INSERT INTO message_outbox/)).toHaveLength(1);
  });

  it("gives up after 2 rounds with a 500 (bounded, no endless loop)", async () => {
    const query = fakeTransaction({ inserted: [], existing: [] });

    const res = await request(app).post(PATH);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
    expect(calls(query, /INSERT INTO review_jobs/)).toHaveLength(2);
  });

  it("returns 404 without inserting anything when the movie doesn't exist", async () => {
    const query = fakeTransaction({ movie: [] });

    const res = await request(app).post(PATH);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("MOVIE_NOT_FOUND");
    expect(calls(query, /INSERT/)).toHaveLength(0);
  });

  it("returns 404 when the movie is deleted between the SELECT and the INSERT (FK violation)", async () => {
    fakeTransaction({
      insertError: Object.assign(new Error("violates foreign key constraint"), {
        code: "23503",
        constraint: "review_jobs_movie_fk",
      }),
    });

    const res = await request(app).post(PATH);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("MOVIE_NOT_FOUND");
  });

  it("answers 500 for any other DB error (other FK, connection loss)", async () => {
    fakeTransaction({
      insertError: Object.assign(new Error("fk"), { code: "23503", constraint: "other_fk" }),
    });

    const res = await request(app).post(PATH);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("INTERNAL_ERROR");
  });

  it("returns 400 for a non-uuid id without touching PG", async () => {
    const res = await request(app).post("/v1/movies/not-a-uuid/review");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(transaction).not.toHaveBeenCalled();
    expect(writeQuery).not.toHaveBeenCalled();
    expect(readQuery).not.toHaveBeenCalled();
  });
});
