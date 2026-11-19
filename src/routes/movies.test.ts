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
const { metricsRegistry } = await import("../infrastructure/metrics.ts");
const { metricValue } = await import("../test/metric-value.ts");

const readQuery = vi.mocked(PG.readQuery);
const writeQuery = vi.mocked(PG.writeQuery);
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
  // `exists` = what the follow-up existence check (only run after a 0-row conditional
  // UPDATE) returns.
  function fakeTransaction(updated: unknown[], exists = false) {
    const query = vi.fn(async (sql: string, _params?: unknown[]) =>
      /UPDATE movies/.test(sql)
        ? { rows: updated }
        : /SELECT 1 FROM movies/.test(sql)
          ? { rows: exists ? [{ "?column?": 1 }] : [] }
          : { rows: [] },
    );
    transaction.mockImplementation(async (callback) =>
      callback({ query } as never),
    );
    return query;
  }

  it("rejects a non-uuid id with 400 and does not hit storage", async () => {
    const res = await request(app).patch("/v1/movies/42").send({ status: "published" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([["deleted"], [""], ["Published"]])(
    "rejects status %j outside the enum with 400 and does not hit storage",
    async (status) => {
      const res = await request(app).patch(`/v1/movies/${ID1}`).send({ status });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it("updates the movie and enqueues invalidation in the same transaction", async () => {
    const query = fakeTransaction([{ id: ID1, status: "published", version: 2 }]);

    const res = await request(app)
      .patch(`/v1/movies/${ID1}`)
      .send({ status: "published" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: { id: ID1, status: "published", version: 2 },
    });
    expect(res.headers.etag).toBe('"2"');

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]![0]).toMatch(/UPDATE movies\b/);
    // No If-Match → no precondition (null expected versions).
    expect(query.mock.calls[0]![1]).toEqual([ID1, "published", null]);
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

  describe("optimistic concurrency (If-Match)", () => {
    it("applies the update when If-Match carries the current version", async () => {
      const query = fakeTransaction([{ id: ID1, status: "published", version: 3 }]);

      const res = await request(app)
        .patch(`/v1/movies/${ID1}`)
        .set("If-Match", '"2"')
        .send({ status: "published" });

      expect(res.status).toBe(200);
      expect(res.headers.etag).toBe('"3"');
      const [sql, params] = query.mock.calls[0]!;
      // Compare-and-set inside the UPDATE itself, not a separate read.
      expect(sql).toMatch(/AND \(\$3::int\[\] IS NULL OR version = ANY\(\$3::int\[\]\)\)/);
      expect(params).toEqual([ID1, "published", [2]]);
      expect(query.mock.calls[1]![0]).toMatch(/INSERT INTO cache_invalidation_outbox/);
      expect(invalidate).toHaveBeenCalledTimes(1);
    });

    it("returns 412, writes no outbox event and skips invalidation on a version mismatch", async () => {
      const query = fakeTransaction([], true);

      const res = await request(app)
        .patch(`/v1/movies/${ID1}`)
        .set("If-Match", '"1"')
        .send({ status: "published" });

      expect(res.status).toBe(412);
      expect(res.body.error.code).toBe("PRECONDITION_FAILED");
      // No movie version tag on a 412: the client must re-read the resource, not reuse a tag
      // from the error. (Express still adds its default weak body ETag, W/"len-hash", to any
      // JSON response; a weak tag never matches If-Match, so it can't be misused.)
      expect(res.headers.etag ?? "").not.toMatch(/^"\d+"$/);
      expect(query.mock.calls.map(([sql]) => sql)).not.toContainEqual(
        expect.stringMatching(/cache_invalidation_outbox/),
      );
      expect(invalidate).not.toHaveBeenCalled();
    });

    it("returns 404 (not 412) when the movie does not exist", async () => {
      fakeTransaction([], false);

      const res = await request(app)
        .patch(`/v1/movies/${ID1}`)
        .set("If-Match", '"1"')
        .send({ status: "published" });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("MOVIE_NOT_FOUND");
    });

    it('treats "*" as "must exist" (no version check)', async () => {
      const query = fakeTransaction([{ id: ID1, status: "published", version: 5 }]);

      const res = await request(app)
        .patch(`/v1/movies/${ID1}`)
        .set("If-Match", "*")
        .send({ status: "published" });

      expect(res.status).toBe(200);
      expect(query.mock.calls[0]![1]).toEqual([ID1, "published", null]);
    });

    it("returns 412 for a weak tag (never matches under strong comparison)", async () => {
      const query = fakeTransaction([], true);

      const res = await request(app)
        .patch(`/v1/movies/${ID1}`)
        .set("If-Match", 'W/"2"')
        .send({ status: "published" });

      expect(res.status).toBe(412);
      expect(query.mock.calls[0]![1]).toEqual([ID1, "published", []]);
    });

    it("rejects a malformed If-Match with 400 before touching storage", async () => {
      const res = await request(app)
        .patch(`/v1/movies/${ID1}`)
        .set("If-Match", "2")
        .send({ status: "published" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(transaction).not.toHaveBeenCalled();
    });
  });
});

describe("GET /v1/movies/:id", () => {
  const movie = {
    id: ID1,
    title: "Arrival",
    description: null,
    release_year: 2016,
    duration_minutes: 116,
    created_at: "2026-11-19T10:00:00.123456Z",
    status: "published",
    version: 3,
  };

  it("returns the movie from the primary (read-after-write), not the replica", async () => {
    writeQuery.mockResolvedValue({ rows: [movie] } as never);

    const res = await request(app).get(`/v1/movies/${ID1}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: movie });
    expect(res.headers.etag).toBe('"3"');

    expect(writeQuery).toHaveBeenCalledTimes(1);
    expect(readQuery).not.toHaveBeenCalled();
    const [sql, params] = writeQuery.mock.calls[0]!;
    expect(sql).toMatch(/FROM movies\s+WHERE id = \$1/);
    expect(sql).toMatch(/to_char\(created_at AT TIME ZONE 'UTC'.*\) AS created_at/);
    expect(params).toEqual([ID1]);
  });

  it("answers a matching If-None-Match with 304 and no body (conditional GET)", async () => {
    writeQuery.mockResolvedValue({ rows: [movie] } as never);

    const res = await request(app)
      .get(`/v1/movies/${ID1}`)
      .set("If-None-Match", '"3"');

    expect(res.status).toBe(304);
    expect(res.text).toBe("");
  });

  it("does not touch the list cache", async () => {
    writeQuery.mockResolvedValue({ rows: [movie] } as never);

    await request(app).get(`/v1/movies/${ID1}`);

    expect(getVersion).not.toHaveBeenCalled();
    expect(redisGet).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
  });

  it("returns 404 when the movie does not exist", async () => {
    writeQuery.mockResolvedValue({ rows: [] } as never);

    const res = await request(app).get(`/v1/movies/${ID1}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("MOVIE_NOT_FOUND");
  });

  it("rejects a non-uuid id with 400 and does not hit storage", async () => {
    const res = await request(app).get("/v1/movies/42");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(writeQuery).not.toHaveBeenCalled();
  });

  it("returns 500 (not 404) when PostgreSQL fails", async () => {
    // Once: beforeEach's clearAllMocks keeps implementations, so a sticky rejection would leak.
    writeQuery.mockRejectedValueOnce(new Error("connection terminated"));

    const res = await request(app).get(`/v1/movies/${ID1}`);

    expect(res.status).toBe(500);
  });
});

describe("POST /v1/movies", () => {
  // Microsecond text, as produced by to_char() in SQL.
  const CREATED_AT = "2026-11-19T10:00:00.123456Z";

  function fakeTransaction() {
    const query = vi.fn(async (sql: string, params?: unknown[]) =>
      /INSERT INTO movies/.test(sql)
        ? {
            rows: [
              {
                id: ID1,
                title: params?.[0],
                description: params?.[1],
                release_year: params?.[2],
                duration_minutes: params?.[3],
                created_at: CREATED_AT,
                status: params?.[4],
                version: 1,
              },
            ],
          }
        : { rows: [] },
    );
    transaction.mockImplementation(async (callback) =>
      callback({ query } as never),
    );
    return query;
  }

  const valid = { title: "  Arrival ", releaseYear: 2016, durationMinutes: 116 };

  it("creates a movie with defaults, enqueues invalidation in the same transaction, returns 201", async () => {
    const query = fakeTransaction();

    const res = await request(app).post("/v1/movies").send(valid);

    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/v1/movies/${ID1}`);
    expect(res.headers.etag).toBe('"1"');
    expect(res.body).toEqual({
      data: {
        id: ID1,
        title: "Arrival", // trimmed
        description: null,
        release_year: 2016,
        duration_minutes: 116,
        created_at: CREATED_AT, // passed through unchanged, microseconds intact
        status: "draft",
        version: 1,
      },
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]![0]).toMatch(/INSERT INTO movies\b/);
    // Same UTC microsecond format as the cursor, not a JS Date.
    expect(query.mock.calls[0]![0]).toMatch(
      /to_char\(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\.US"Z"'\) AS created_at/,
    );
    expect(query.mock.calls[0]![1]).toEqual(["Arrival", null, 2016, 116, "draft"]);
    expect(query.mock.calls[1]![0]).toMatch(/INSERT INTO cache_invalidation_outbox/);
    expect(query.mock.calls[1]![1]).toEqual(["movie", ID1, "movies.list.invalidate"]);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("passes description and an explicit status through", async () => {
    const query = fakeTransaction();

    const res = await request(app)
      .post("/v1/movies")
      .send({ ...valid, description: "Linguist meets heptapods", status: "published" });

    expect(res.status).toBe(201);
    expect(query.mock.calls[0]![1]).toEqual([
      "Arrival",
      "Linguist meets heptapods",
      2016,
      116,
      "published",
    ]);
  });

  it("still returns 201 when the immediate cache invalidation fails (outbox retries)", async () => {
    fakeTransaction();
    invalidate.mockRejectedValue(new Error("redis down"));

    const res = await request(app).post("/v1/movies").send(valid);

    expect(res.status).toBe(201);
  });

  it.each([
    ["missing title", { releaseYear: 2016, durationMinutes: 116 }],
    ["blank title", { ...valid, title: "   " }],
    ["title over 200 chars", { ...valid, title: "x".repeat(201) }],
    ["release year before 1888", { ...valid, releaseYear: 1887 }],
    ["release year as string", { ...valid, releaseYear: "2016" }],
    ["fractional duration", { ...valid, durationMinutes: 1.5 }],
    ["duration 0", { ...valid, durationMinutes: 0 }],
    ["missing duration", { title: "Arrival", releaseYear: 2016 }],
    ["unknown status", { ...valid, status: "deleted" }],
    ["client-supplied id", { ...valid, id: ID2 }],
    ["client-supplied version", { ...valid, version: 7 }],
  ])("rejects %s with 400 and does not hit storage", async (_name, body) => {
    const res = await request(app).post("/v1/movies").send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(transaction).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("DELETE /v1/movies/:id", () => {
  function fakeTransaction(deleted: unknown[]) {
    const query = vi.fn(async (sql: string, _params?: unknown[]) =>
      /DELETE FROM movies/.test(sql) ? { rows: deleted } : { rows: [] },
    );
    transaction.mockImplementation(async (callback) =>
      callback({ query } as never),
    );
    return query;
  }

  it("rejects a non-uuid id with 400 and does not hit storage", async () => {
    const res = await request(app).delete("/v1/movies/42");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("deletes the movie, enqueues invalidation in the same transaction, returns 204", async () => {
    const query = fakeTransaction([{ id: ID1 }]);

    const res = await request(app).delete(`/v1/movies/${ID1}`);

    expect(res.status).toBe(204);
    expect(res.text).toBe("");

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]![0]).toMatch(/DELETE FROM movies\b/);
    expect(query.mock.calls[0]![1]).toEqual([ID1]);
    expect(query.mock.calls[1]![0]).toMatch(/INSERT INTO cache_invalidation_outbox/);
    expect(query.mock.calls[1]![1]).toEqual([
      "movie",
      ID1,
      "movies.list.invalidate",
    ]);
    // Best-effort immediate invalidation runs only after the transaction resolved.
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("still returns 204 when the immediate cache invalidation fails (outbox retries)", async () => {
    fakeTransaction([{ id: ID1 }]);
    invalidate.mockRejectedValue(new Error("redis down"));

    const res = await request(app).delete(`/v1/movies/${ID1}`);

    expect(res.status).toBe(204);
  });

  it("returns 404 and enqueues nothing when the movie does not exist", async () => {
    const query = fakeTransaction([]);

    const res = await request(app).delete(`/v1/movies/${ID1}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("MOVIE_NOT_FOUND");
    expect(query).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("HTTP metrics route label", () => {
  // Express matches paths case-insensitively and req.baseUrl keeps the client's casing.
  // Regression: `/V1/movies` must be counted as route="/v1/movies", otherwise SLO rules and
  // alerts filtering on route="/v1/movies" miss that traffic.
  function requestsTotal(labels: Record<string, string>) {
    const metric = metricsRegistry.getSingleMetric("http_requests_total");
    if (!metric) throw new Error("http_requests_total is not registered");
    return metricValue(metric, labels);
  }

  it.each([
    ["GET", "/V1/movies", "/v1/movies", "200"],
    ["PATCH", `/V1/Movies/${ID1}`, "/v1/movies/:id", "404"],
  ] as const)(
    "%s %s is labelled with the lower-case route template",
    async (method, url, expectedRoute, status) => {
      fakeTransactionNotFound();
      const before = await requestsTotal({ method, route: expectedRoute, status_code: status });

      const res =
        method === "GET"
          ? await request(app).get(url)
          : await request(app).patch(url).send({ status: "published" });

      expect(String(res.status)).toBe(status);
      expect(
        await requestsTotal({ method, route: expectedRoute, status_code: status }),
      ).toBe(before + 1);
      expect(
        await requestsTotal({ method, route: expectedRoute.replace("/v1", "/V1"), status_code: status }),
      ).toBe(0);
    },
  );

  function fakeTransactionNotFound() {
    transaction.mockImplementation(async (callback) =>
      callback({ query: vi.fn(async () => ({ rows: [] })) } as never),
    );
  }
});
