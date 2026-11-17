import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../app.ts";
import { PG } from "../infrastructure/postgres.ts";
import { REDIS } from "../infrastructure/redis.ts";
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
