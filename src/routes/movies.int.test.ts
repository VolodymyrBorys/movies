import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../app.ts";
import { PG } from "../infrastructure/postgres.ts";
import { REDIS } from "../infrastructure/redis.ts";
import { decodeMovieCursor } from "../modules/movies/cursor.ts";
import {
  insertMovie,
  outboxRows,
  resetState,
  startInfrastructure,
  stopInfrastructure,
} from "../test/integration-db.ts";

// Integration: real PostgreSQL (migrated schema) + Redis, real app over HTTP.
// Proves what the mocked HTTP tests cannot: SQL matches the schema, keyset paging is
// correct at microsecond boundaries, outbox insert is atomic with the update.

beforeAll(startInfrastructure);
afterAll(stopInfrastructure);
beforeEach(resetState);

type Page = {
  data: { id: string; status: string | null; version: number | null }[];
  hasMore: boolean;
  nextCursor: string | null;
};

async function fetchAllIds(sort: "asc" | "desc", limit: number) {
  const ids: string[] = [];
  const pageSizes: number[] = [];
  let cursor: string | null = null;

  for (let i = 0; i < 20; i++) {
    const query: Record<string, string> = { sort, limit: String(limit) };
    if (cursor !== null) query.cursor = cursor;

    const res = await request(app).get("/v1/movies").query(query);
    expect(res.status).toBe(200);

    const page = res.body as Page;
    ids.push(...page.data.map((m) => m.id));
    pageSizes.push(page.data.length);

    if (page.nextCursor === null) {
      expect(page.hasMore).toBe(false);
      return { ids, pageSizes };
    }
    cursor = page.nextCursor;
  }

  throw new Error("pagination did not terminate");
}

describe("GET /v1/movies keyset pagination (real PostgreSQL)", () => {
  // A and B share the same MILLIsecond: a Date-based cursor would lose the boundary.
  // C and D share the exact same created_at: only the id tie-breaker orders them.
  const A = { id: "aaaaaaaa-0000-4000-8000-000000000001", createdAt: "2026-01-01T00:00:00.000001Z" };
  const B = { id: "aaaaaaaa-0000-4000-8000-000000000002", createdAt: "2026-01-01T00:00:00.000002Z" };
  const C = { id: "00000000-0000-4000-8000-00000000000c", createdAt: "2026-01-01T00:00:00.000003Z" };
  const D = { id: "ffffffff-0000-4000-8000-00000000000d", createdAt: "2026-01-01T00:00:00.000003Z" };
  const E = { id: "aaaaaaaa-0000-4000-8000-000000000005", createdAt: "2026-01-01T00:00:01.000000Z" };

  beforeEach(async () => {
    // Insert out of order so the result order comes from ORDER BY, not insertion.
    for (const m of [D, A, E, C, B]) await insertMovie(m);
  });

  it("returns every row exactly once in ascending order across page boundaries", async () => {
    const { ids, pageSizes } = await fetchAllIds("asc", 2);

    expect(ids).toEqual([A.id, B.id, C.id, D.id, E.id]);
    expect(pageSizes).toEqual([2, 2, 1]);
  });

  it("returns every row exactly once in descending order", async () => {
    const { ids } = await fetchAllIds("desc", 2);

    expect(ids).toEqual([E.id, D.id, C.id, B.id, A.id]);
  });

  it("matches PostgreSQL's own ordering for every page size", async () => {
    const { rows } = await PG.writeQuery<{ id: string }>(
      "SELECT id FROM movies ORDER BY created_at ASC, id ASC",
    );
    const expected = rows.map((r) => r.id);

    for (const limit of [1, 2, 3, 4, 5, 6]) {
      const { ids } = await fetchAllIds("asc", limit);
      expect(ids, `limit=${limit}`).toEqual(expected);
    }
  });

  it("stays consistent when a row is inserted behind the cursor between pages", async () => {
    const first = await request(app).get("/v1/movies").query({ sort: "asc", limit: "2" });
    expect(first.body.data.map((m: { id: string }) => m.id)).toEqual([A.id, B.id]);

    // Older than the cursor: keyset must not shift the next page (OFFSET would).
    await insertMovie({ createdAt: "2025-12-31T00:00:00.000000Z" });
    await REDIS.invalidateMoviesList();

    const second = await request(app)
      .get("/v1/movies")
      .query({ sort: "asc", limit: "2", cursor: first.body.nextCursor });

    expect(second.body.data.map((m: { id: string }) => m.id)).toEqual([C.id, D.id]);
  });
});

describe("GET /v1/movies cache (real Redis)", () => {
  it("serves a cached page until the list version is bumped", async () => {
    const id = await insertMovie({ createdAt: "2026-01-01T00:00:00.000000Z", status: "draft" });

    const first = await request(app).get("/v1/movies");
    expect(first.body.data[0].status).toBe("draft");

    // Change the row behind the API's back (no outbox, no invalidation).
    await PG.writeQuery("UPDATE movies SET status = 'published' WHERE id = $1", [id]);

    const cached = await request(app).get("/v1/movies");
    expect(cached.body.data[0].status).toBe("draft"); // stale by design until invalidation

    await REDIS.invalidateMoviesList();

    const fresh = await request(app).get("/v1/movies");
    expect(fresh.body.data[0].status).toBe("published");
  });
});

describe("PATCH /v1/movies/:id (real PostgreSQL)", () => {
  it("updates the movie and writes the outbox event", async () => {
    const id = await insertMovie({ createdAt: "2026-01-01T00:00:00.000000Z", version: 1 });

    const res = await request(app).patch(`/v1/movies/${id}`).send({ status: "published" });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id, status: "published", version: 2 });

    const outbox = await outboxRows();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      aggregate_type: "movie",
      aggregate_id: id,
      event_type: "movies.list.invalidate",
      attempts: 0,
      processed_at: null,
    });
  });

  it("rolls back the update when the outbox insert fails (atomicity)", async () => {
    const id = await insertMovie({ createdAt: "2026-01-01T00:00:00.000000Z", status: "draft", version: 1 });

    // Make only the outbox INSERT fail; NOT VALID skips checking existing rows.
    await PG.writeQuery(
      `ALTER TABLE cache_invalidation_outbox
         ADD CONSTRAINT it_reject_events CHECK (event_type <> 'movies.list.invalidate') NOT VALID`,
    );

    try {
      const res = await request(app).patch(`/v1/movies/${id}`).send({ status: "published" });
      expect(res.status).toBe(500);
    } finally {
      await PG.writeQuery(
        "ALTER TABLE cache_invalidation_outbox DROP CONSTRAINT it_reject_events",
      );
    }

    const { rows } = await PG.writeQuery<{ status: string; version: number }>(
      "SELECT status, version FROM movies WHERE id = $1",
      [id],
    );
    expect(rows[0]).toEqual({ status: "draft", version: 1 });
    expect(await outboxRows()).toHaveLength(0);
  });

  it("returns 404 and writes no outbox event for an unknown id", async () => {
    const res = await request(app)
      .patch("/v1/movies/11111111-1111-4111-8111-111111111111")
      .send({ status: "published" });

    expect(res.status).toBe(404);
    expect(await outboxRows()).toHaveLength(0);
  });
});

describe("GET /v1/movies/:id (real PostgreSQL)", () => {
  it("returns the full movie with the microsecond created_at", async () => {
    const id = await insertMovie({
      createdAt: "2026-01-01T00:00:00.000007Z",
      status: "published",
      version: 4,
    });

    const res = await request(app).get(`/v1/movies/${id}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      id,
      title: "Test movie",
      description: null,
      release_year: 2000,
      duration_minutes: 100,
      created_at: "2026-01-01T00:00:00.000007Z",
      status: "published",
      version: 4,
    });
  });

  it("serves the Location of a just-created movie (read-after-write)", async () => {
    const created = await request(app).post("/v1/movies").send({
      title: "Arrival",
      releaseYear: 2016,
      durationMinutes: 116,
    });
    expect(created.status).toBe(201);

    const res = await request(app).get(created.headers.location!);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(created.body.data);
  });

  it("returns 404 after the movie is deleted", async () => {
    const id = await insertMovie({ createdAt: "2026-01-01T00:00:00.000000Z" });
    expect((await request(app).delete(`/v1/movies/${id}`)).status).toBe(204);

    const res = await request(app).get(`/v1/movies/${id}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("MOVIE_NOT_FOUND");
  });
});

describe("POST /v1/movies (real PostgreSQL)", () => {
  const body = {
    title: "Arrival",
    description: "Linguist meets heptapods",
    releaseYear: 2016,
    durationMinutes: 116,
  };

  it("inserts the movie and writes the outbox event", async () => {
    const res = await request(app).post("/v1/movies").send(body);

    expect(res.status).toBe(201);
    const created = res.body.data;
    expect(res.headers.location).toBe(`/v1/movies/${created.id}`);
    expect(created).toMatchObject({
      title: "Arrival",
      description: "Linguist meets heptapods",
      release_year: 2016,
      duration_minutes: 116,
      status: "draft",
      version: 1,
    });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);

    const { rows } = await PG.writeQuery(
      "SELECT title, release_year, duration_minutes, status, version FROM movies WHERE id = $1",
      [created.id],
    );
    expect(rows[0]).toEqual({
      title: "Arrival",
      release_year: 2016,
      duration_minutes: 116,
      status: "draft",
      version: 1,
    });

    const outbox = await outboxRows();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      aggregate_type: "movie",
      aggregate_id: created.id,
      event_type: "movies.list.invalidate",
      processed_at: null,
    });
  });

  it("returns created_at with full microsecond precision, identical to the cursor's value", async () => {
    // Older row so that a limit=1 page of the new movie has hasMore → nextCursor.
    await insertMovie({ createdAt: "2026-01-01T00:00:00.000000Z" });

    const res = await request(app).post("/v1/movies").send(body);
    expect(res.status).toBe(201);

    const { rows } = await PG.writeQuery<{ exact: string }>(
      `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exact
       FROM movies WHERE id = $1`,
      [res.body.data.id],
    );
    expect(res.body.data.created_at).toBe(rows[0]!.exact);

    const page = await request(app).get("/v1/movies").query({ limit: "1" });
    expect(page.body.data[0].id).toBe(res.body.data.id);
    expect(decodeMovieCursor(page.body.nextCursor)).toEqual({
      createdAt: res.body.data.created_at,
      id: res.body.data.id,
    });
  });

  it("shows the new movie in a previously cached list", async () => {
    await insertMovie({ createdAt: "2026-01-01T00:00:00.000000Z" });
    const before = await request(app).get("/v1/movies");
    expect(before.body.data).toHaveLength(1);

    const res = await request(app).post("/v1/movies").send(body);
    expect(res.status).toBe(201);

    const after = await request(app).get("/v1/movies");
    // Newest first: created_at = now() is after the 2026-01-01 row.
    expect(after.body.data.map((m: { id: string }) => m.id)[0]).toBe(res.body.data.id);
    expect(after.body.data).toHaveLength(2);
  });

  it("rolls back the insert when the outbox insert fails (atomicity)", async () => {
    await PG.writeQuery(
      `ALTER TABLE cache_invalidation_outbox
         ADD CONSTRAINT it_reject_events CHECK (event_type <> 'movies.list.invalidate') NOT VALID`,
    );

    try {
      const res = await request(app).post("/v1/movies").send(body);
      expect(res.status).toBe(500);
    } finally {
      await PG.writeQuery(
        "ALTER TABLE cache_invalidation_outbox DROP CONSTRAINT it_reject_events",
      );
    }

    const { rows } = await PG.writeQuery("SELECT 1 FROM movies");
    expect(rows).toHaveLength(0);
    expect(await outboxRows()).toHaveLength(0);
  });
});

describe("DELETE /v1/movies/:id (real PostgreSQL)", () => {
  async function movieExists(id: string) {
    const { rows } = await PG.writeQuery("SELECT 1 FROM movies WHERE id = $1", [id]);
    return rows.length === 1;
  }

  it("deletes the movie and writes the outbox event", async () => {
    const id = await insertMovie({ createdAt: "2026-01-01T00:00:00.000000Z" });

    const res = await request(app).delete(`/v1/movies/${id}`);

    expect(res.status).toBe(204);
    expect(await movieExists(id)).toBe(false);

    const outbox = await outboxRows();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      aggregate_type: "movie",
      aggregate_id: id,
      event_type: "movies.list.invalidate",
      attempts: 0,
      processed_at: null,
    });
  });

  it("removes the movie from the list after a cached read", async () => {
    const id = await insertMovie({ createdAt: "2026-01-01T00:00:00.000000Z" });

    const before = await request(app).get("/v1/movies");
    expect(before.body.data.map((m: { id: string }) => m.id)).toEqual([id]);

    expect((await request(app).delete(`/v1/movies/${id}`)).status).toBe(204);

    // Immediate best-effort invalidation bumped the list version.
    const after = await request(app).get("/v1/movies");
    expect(after.body.data).toEqual([]);
  });

  it("rolls back the delete when the outbox insert fails (atomicity)", async () => {
    const id = await insertMovie({ createdAt: "2026-01-01T00:00:00.000000Z" });

    await PG.writeQuery(
      `ALTER TABLE cache_invalidation_outbox
         ADD CONSTRAINT it_reject_events CHECK (event_type <> 'movies.list.invalidate') NOT VALID`,
    );

    try {
      const res = await request(app).delete(`/v1/movies/${id}`);
      expect(res.status).toBe(500);
    } finally {
      await PG.writeQuery(
        "ALTER TABLE cache_invalidation_outbox DROP CONSTRAINT it_reject_events",
      );
    }

    expect(await movieExists(id)).toBe(true);
    expect(await outboxRows()).toHaveLength(0);
  });

  it("returns 404 on a second delete and writes no extra outbox event", async () => {
    const id = await insertMovie({ createdAt: "2026-01-01T00:00:00.000000Z" });

    expect((await request(app).delete(`/v1/movies/${id}`)).status).toBe(204);
    const second = await request(app).delete(`/v1/movies/${id}`);

    expect(second.status).toBe(404);
    expect(await outboxRows()).toHaveLength(1);
  });
});

describe("movies status/version constraints (migrated schema)", () => {
  async function pgErrorOf(sql: string, params: unknown[] = []) {
    try {
      await PG.writeQuery(sql, params);
    } catch (error) {
      return error as { code?: string; constraint?: string; column?: string };
    }
    throw new Error("expected the statement to fail");
  }

  it("fills status and version from column defaults", async () => {
    const { rows } = await PG.writeQuery<{ status: string; version: number }>(
      `INSERT INTO movies (title, release_year, duration_minutes)
       VALUES ('Defaults', 2000, 100)
       RETURNING status, version`,
    );

    expect(rows[0]).toEqual({ status: "draft", version: 1 });
  });

  it.each([
    ["status", "UPDATE movies SET status = NULL WHERE id = $1"],
    ["version", "UPDATE movies SET version = NULL WHERE id = $1"],
  ])("rejects NULL %s (23502 not_null_violation)", async (column, sql) => {
    const id = await insertMovie({ createdAt: "2026-01-01T00:00:00.000000Z" });

    const error = await pgErrorOf(sql, [id]);

    expect(error.code).toBe("23502");
    expect(error.column).toBe(column);
  });

  it("rejects a status outside the enum (23514 movies_status_valid)", async () => {
    const id = await insertMovie({ createdAt: "2026-01-01T00:00:00.000000Z" });

    const error = await pgErrorOf("UPDATE movies SET status = 'deleted' WHERE id = $1", [id]);

    expect(error.code).toBe("23514");
    expect(error.constraint).toBe("movies_status_valid");
  });

  it("keeps only movies_status_valid; the helper NOT NULL checks are dropped", async () => {
    const { rows } = await PG.writeQuery<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated FROM pg_constraint
       WHERE conrelid = 'movies'::regclass AND contype = 'c' AND conname LIKE 'movies_status%'
          OR conrelid = 'movies'::regclass AND contype = 'c' AND conname LIKE 'movies_version%'
       ORDER BY conname`,
    );

    expect(rows).toEqual([{ conname: "movies_status_valid", convalidated: true }]);
  });

  it("PATCH with a status outside the enum is a 400, not a constraint 500", async () => {
    const id = await insertMovie({ createdAt: "2026-01-01T00:00:00.000000Z", status: "draft" });

    const res = await request(app).patch(`/v1/movies/${id}`).send({ status: "deleted" });

    expect(res.status).toBe(400);
    expect(await outboxRows()).toHaveLength(0);
  });
});

describe("GET /readyz (real dependencies)", () => {
  it("reports ready with all checks up", async () => {
    const res = await request(app).get("/readyz");

    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({
      postgres_write: "up",
      postgres_read: "up",
      redis: "up",
    });
  });
});
