import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// HTTP-level test: real app, router, validation, controller, service, repository, cursor.
// Only infrastructure clients are replaced (no PostgreSQL/Redis/network).
// LAB: simplified — SQL is asserted as text, not executed; production would also run an
// integration test against real PostgreSQL/Redis to prove the queries match the schema.

vi.mock("../infrastructure/logger.ts", async () => {
  const { pino } = await import("pino");
  return { logger: pino({ level: "silent" }) };
});

vi.mock("../infrastructure/postgres.ts", () => ({
  PG: {
    readQuery: vi.fn(),
    writeQuery: vi.fn(),
    transaction: vi.fn(),
  },
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
const { REDIS } = await import("../infrastructure/redis.ts");
const { encodeMovieCursor } = await import("../modules/movies/cursor.ts");

const readQuery = vi.mocked(PG.readQuery);
const transaction = vi.mocked(PG.transaction);
const redisGet = vi.mocked(REDIS.get);
const redisSet = vi.mocked(REDIS.set);
const getVersion = vi.mocked(REDIS.getMoviesListVersion);
const invalidate = vi.mocked(REDIS.invalidateMoviesList);

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const ID3 = "33333333-3333-4333-8333-333333333333";

// Same millisecond, different microseconds: the cursor must keep them apart.
const TS1 = "2026-11-16T10:00:00.000001Z";
const TS2 = "2026-11-16T10:00:00.000002Z";
const TS3 = "2026-11-16T10:00:00.000003Z";

function listRows(...rows: [id: string, ts: string][]) {
  return {
    rows: rows.map(([id, ts]) => ({
      id,
      status: "draft",
      version: 1,
      cursor_created_at: ts,
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  getVersion.mockResolvedValue("v1");
  redisGet.mockResolvedValue(null);
  redisSet.mockResolvedValue(undefined);
  invalidate.mockResolvedValue("v2");
  readQuery.mockResolvedValue(listRows() as never);
});

describe("GET /v1/movies", () => {
  it("returns the first page with defaults (limit 20, newest first)", async () => {
    readQuery.mockResolvedValue(
      listRows([ID3, TS3], [ID2, TS2], [ID1, TS1]) as never,
    );

    const res = await request(app).get("/v1/movies");

    expect(res.status).toBe(200);
    // Response shape unchanged: cursor helper column is not exposed.
    expect(res.body).toEqual({
      data: [
        { id: ID3, status: "draft", version: 1 },
        { id: ID2, status: "draft", version: 1 },
        { id: ID1, status: "draft", version: 1 },
      ],
      hasMore: false,
      nextCursor: null,
    });

    expect(readQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = readQuery.mock.calls[0]!;
    expect(sql).toMatch(/FROM movies\b/);
    expect(sql).toMatch(/ORDER BY created_at DESC, id DESC/);
    expect(sql).not.toMatch(/WHERE/);
    expect(params).toEqual([21]);
  });

  it("paginates with a (created_at, id) keyset cursor", async () => {
    // limit=2 → repository asks for 3 rows to detect hasMore.
    readQuery.mockResolvedValueOnce(
      listRows([ID1, TS1], [ID2, TS2], [ID3, TS3]) as never,
    );

    const first = await request(app).get("/v1/movies?limit=2&sort=asc");

    expect(first.status).toBe(200);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.data.map((m: { id: string }) => m.id)).toEqual([ID1, ID2]);
    // Cursor points at the LAST returned row, with microseconds intact.
    expect(first.body.nextCursor).toBe(
      encodeMovieCursor({ createdAt: TS2, id: ID2 }),
    );

    readQuery.mockResolvedValueOnce(listRows([ID3, TS3]) as never);

    const second = await request(app)
      .get("/v1/movies")
      .query({ limit: "2", sort: "asc", cursor: first.body.nextCursor });

    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ hasMore: false, nextCursor: null });

    const [sql, params] = readQuery.mock.calls[1]!;
    expect(sql).toMatch(
      /WHERE \(created_at, id\) > \(\$1::timestamptz, \$2::uuid\)/,
    );
    expect(sql).toMatch(/ORDER BY created_at ASC, id ASC/);
    expect(params).toEqual([TS2, ID2, 3]);
  });

  it("uses < for descending pages", async () => {
    const cursor = encodeMovieCursor({ createdAt: TS2, id: ID2 });

    const res = await request(app).get("/v1/movies").query({ cursor });

    expect(res.status).toBe(200);
    const [sql] = readQuery.mock.calls[0]!;
    expect(sql).toMatch(/WHERE \(created_at, id\) < /);
    expect(sql).toMatch(/ORDER BY created_at DESC, id DESC/);
  });

  it.each([
    ["limit=0"],
    ["limit=101"],
    ["limit=abc"],
    ["sort=sideways"],
  ])("rejects invalid query %s with 400 and does not hit storage", async (qs) => {
    const res = await request(app).get(`/v1/movies?${qs}`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(readQuery).not.toHaveBeenCalled();
    expect(getVersion).not.toHaveBeenCalled();
  });

  it.each([
    ["garbage", "%%%"],
    ["old bigint format", Buffer.from("42").toString("base64url")],
    [
      "impossible date",
      Buffer.from(`2026-02-30T10:00:00.000001Z,${ID1}`).toString("base64url"),
    ],
  ])("rejects an invalid cursor (%s) with 400", async (_name, cursor) => {
    const res = await request(app).get("/v1/movies").query({ cursor });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.message).toMatch(/cursor/i);
    expect(readQuery).not.toHaveBeenCalled();
  });

  it("serves a cache hit without querying PostgreSQL", async () => {
    const cached = { data: [], hasMore: false, nextCursor: null };
    redisGet.mockResolvedValue(cached);

    const res = await request(app).get("/v1/movies?limit=5");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(cached);
    expect(redisGet).toHaveBeenCalledWith(
      "movies:v1:list:vv1:limit:5:sort:desc:cursor:first",
    );
    expect(readQuery).not.toHaveBeenCalled();
  });

  it("falls back to PostgreSQL when the cache read fails and skips cache write", async () => {
    getVersion.mockRejectedValue(new Error("redis down"));
    readQuery.mockResolvedValue(listRows([ID1, TS1]) as never);

    const res = await request(app).get("/v1/movies");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(redisSet).not.toHaveBeenCalled();
  });
});

describe("PATCH /v1/movies/:id", () => {
  function fakeTransaction(updated: unknown[]) {
    const query = vi.fn(async (sql: string, _params?: unknown[]) =>
      /UPDATE movies/.test(sql) ? { rows: updated } : { rows: [] },
    );
    transaction.mockImplementation(async (callback) =>
      callback({ query } as never),
    );
    return query;
  }

  it("rejects a non-uuid id with 400 and does not hit storage", async () => {
    const res = await request(app).patch("/v1/movies/42").send({ status: "x" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("updates the movie and enqueues invalidation in the same transaction", async () => {
    const query = fakeTransaction([{ id: ID1, status: "published", version: 2 }]);

    const res = await request(app)
      .patch(`/v1/movies/${ID1}`)
      .send({ status: "published" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: { id: ID1, status: "published", version: 2 },
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]![0]).toMatch(/UPDATE movies\b/);
    expect(query.mock.calls[0]![1]).toEqual([ID1, "published"]);
    expect(query.mock.calls[1]![0]).toMatch(/INSERT INTO cache_invalidation_outbox/);
    expect(query.mock.calls[1]![1]).toEqual([
      "movie",
      ID1,
      "movies.list.invalidate",
    ]);
  });

  it("returns 404 and enqueues nothing when the movie does not exist", async () => {
    const query = fakeTransaction([]);

    const res = await request(app)
      .patch(`/v1/movies/${ID1}`)
      .send({ status: "published" });

    expect(res.status).toBe(404);
    expect(query).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
