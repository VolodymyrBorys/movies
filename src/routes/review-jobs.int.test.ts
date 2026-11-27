import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../app.ts";
import { PG } from "../infrastructure/postgres.ts";
import {
  insertMovie,
  resetState,
  startInfrastructure,
  stopInfrastructure,
} from "../test/integration-db.ts";

// Integration: real PostgreSQL (migrated schema), real app over HTTP. Proves what the mocked
// HTTP tests cannot: the SQL matches the schema, the partial unique index dedupes concurrent
// POSTs, job + outbox message are written together, CHECKs and the FK cascade hold.

beforeAll(startInfrastructure);
afterAll(stopInfrastructure);
beforeEach(resetState);

const CREATED_AT = "2026-01-01T00:00:00.000001Z";

interface JobRow {
  id: string;
  movie_id: string;
  movie_version: number;
  status: string;
}

interface MessageRow {
  aggregate_type: string;
  aggregate_id: string;
  routing_key: string;
  payload: unknown;
  published_at: Date | null;
}

async function jobs(): Promise<JobRow[]> {
  const { rows } = await PG.writeQuery<JobRow>(
    "SELECT id, movie_id, movie_version, status FROM review_jobs ORDER BY created_at, id",
  );
  return rows;
}

async function messages(): Promise<MessageRow[]> {
  const { rows } = await PG.writeQuery<MessageRow>(
    "SELECT aggregate_type, aggregate_id, routing_key, payload, published_at FROM message_outbox ORDER BY id",
  );
  return rows;
}

async function setJob(id: string, sql: string): Promise<void> {
  await PG.writeQuery(`UPDATE review_jobs SET ${sql} WHERE id = $1`, [id]);
}

describe("POST /v1/movies/:id/review + GET /v1/review-jobs/:id (real PostgreSQL)", () => {
  it("creates a queued job and its review.requested message; GET returns the job", async () => {
    const movieId = await insertMovie({ createdAt: CREATED_AT, version: 4 });

    const res = await request(app).post(`/v1/movies/${movieId}/review`);

    expect(res.status).toBe(202);
    const job = res.body.data;
    expect(job).toMatchObject({ movieId, movieVersion: 4, status: "queued", attempts: 0 });
    expect(job.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    expect(res.headers.location).toBe(`/v1/review-jobs/${job.id}`);

    expect(await messages()).toEqual([
      {
        aggregate_type: "review_job",
        aggregate_id: job.id,
        routing_key: "review.requested",
        payload: { schemaVersion: 1, jobId: job.id, movieId, movieVersion: 4 },
        published_at: null,
      },
    ]);

    const get = await request(app).get(res.headers.location as string);
    expect(get.status).toBe(200);
    expect(get.body).toEqual({ data: job });
  });

  it("returns the same job for a repeated POST and enqueues one message", async () => {
    const movieId = await insertMovie({ createdAt: CREATED_AT });

    const first = await request(app).post(`/v1/movies/${movieId}/review`);
    const second = await request(app).post(`/v1/movies/${movieId}/review`);

    expect(second.status).toBe(202);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(await jobs()).toHaveLength(1);
    expect(await messages()).toHaveLength(1);
  });

  it("dedupes 10 concurrent POSTs into one job and one message", async () => {
    const movieId = await insertMovie({ createdAt: CREATED_AT });

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => request(app).post(`/v1/movies/${movieId}/review`)),
    );

    expect(responses.map((r) => r.status)).toEqual(Array(10).fill(202));
    expect(new Set(responses.map((r) => r.body.data.id)).size).toBe(1);
    expect(await jobs()).toHaveLength(1);
    expect(await messages()).toHaveLength(1);
  });

  it("creates a new job after the movie changed (PATCH bumps the version)", async () => {
    const movieId = await insertMovie({ createdAt: CREATED_AT, version: 1 });

    const v1 = await request(app).post(`/v1/movies/${movieId}/review`);
    const patch = await request(app).patch(`/v1/movies/${movieId}`).send({ status: "published" });
    expect(patch.status).toBe(200);
    const v2 = await request(app).post(`/v1/movies/${movieId}/review`);

    expect(v2.status).toBe(202);
    expect(v2.body.data.id).not.toBe(v1.body.data.id);
    expect(v2.body.data.movieVersion).toBe(2);
    expect((await jobs()).map((j) => j.movie_version)).toEqual([1, 2]);
    expect(await messages()).toHaveLength(2);
  });

  it.each([["failed"], ["superseded"]])(
    "allows a new job for the same version once the previous one is %s",
    async (status) => {
      const movieId = await insertMovie({ createdAt: CREATED_AT });
      const first = await request(app).post(`/v1/movies/${movieId}/review`);
      await setJob(first.body.data.id, `status = '${status}', finished_at = now()`);

      const second = await request(app).post(`/v1/movies/${movieId}/review`);

      expect(second.status).toBe(202);
      expect(second.body.data.id).not.toBe(first.body.data.id);
      expect(await messages()).toHaveLength(2);
    },
  );

  it("returns an already succeeded job with 200 and its review", async () => {
    const movieId = await insertMovie({ createdAt: CREATED_AT });
    const first = await request(app).post(`/v1/movies/${movieId}/review`);
    await setJob(
      first.body.data.id,
      "status = 'succeeded', review = 'Fine.', model = 'fake', started_at = now(), finished_at = now()",
    );

    const second = await request(app).post(`/v1/movies/${movieId}/review`);

    expect(second.status).toBe(200);
    expect(second.body.data).toMatchObject({
      id: first.body.data.id,
      status: "succeeded",
      review: "Fine.",
      model: "fake",
    });
    expect(await messages()).toHaveLength(1);
  });

  it("returns 404 for an unknown movie and writes nothing", async () => {
    const res = await request(app).post(
      "/v1/movies/00000000-0000-4000-8000-000000000000/review",
    );

    expect(res.status).toBe(404);
    expect(await jobs()).toHaveLength(0);
    expect(await messages()).toHaveLength(0);
  });

  it("deletes the jobs with the movie (FK cascade); GET then answers 404", async () => {
    const movieId = await insertMovie({ createdAt: CREATED_AT });
    const created = await request(app).post(`/v1/movies/${movieId}/review`);

    const del = await request(app).delete(`/v1/movies/${movieId}`);
    expect(del.status).toBe(204);

    const get = await request(app).get(created.headers.location as string);
    expect(get.status).toBe(404);
    expect(get.body.error.code).toBe("REVIEW_JOB_NOT_FOUND");
  });

  it.each([
    ["succeeded without a review", "status = 'succeeded', finished_at = now()"],
    ["running without a lease", "status = 'running'"],
    ["a terminal status without finished_at", "status = 'failed'"],
    ["an unknown status", "status = 'done'"],
  ])("rejects %s (CHECK constraint)", async (_case, sql) => {
    const movieId = await insertMovie({ createdAt: CREATED_AT });
    const created = await request(app).post(`/v1/movies/${movieId}/review`);

    await expect(setJob(created.body.data.id, sql)).rejects.toMatchObject({ code: "23514" });
  });
});
