import { beforeEach, describe, expect, it, vi } from "vitest";

// MovieService with real repository and metrics; only infrastructure clients replaced.

vi.mock("../../infrastructure/logger.ts", async () => {
  const { pino } = await import("pino");
  return { logger: pino({ level: "silent" }) };
});

vi.mock("../../infrastructure/postgres.ts", () => ({
  PG: { readQuery: vi.fn(), writeQuery: vi.fn(), transaction: vi.fn() },
}));

vi.mock("../../infrastructure/redis.ts", () => ({
  REDIS: {
    getMoviesListVersion: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
    invalidateMoviesList: vi.fn(),
  },
}));

const { MovieService } = await import("./movies.service.ts");
const { PG } = await import("../../infrastructure/postgres.ts");
const { REDIS } = await import("../../infrastructure/redis.ts");
const { cacheRequestsTotal, metricsRegistry } = await import(
  "../../infrastructure/metrics.ts"
);
const { metricValue } = await import("../../test/metric-value.ts");

const service = new MovieService();
const cacheResult = (result: string) =>
  metricValue(cacheRequestsTotal, { cache: "movies_list", result });

beforeEach(() => {
  vi.clearAllMocks();
  metricsRegistry.resetMetrics();
  vi.mocked(REDIS.getMoviesListVersion).mockResolvedValue("v1");
  vi.mocked(REDIS.get).mockResolvedValue(null);
  vi.mocked(REDIS.set).mockResolvedValue(undefined);
  vi.mocked(PG.readQuery).mockResolvedValue({ rows: [] } as never);
});

describe("MovieService.getMovies cache metrics", () => {
  it("counts a hit and does not query PostgreSQL", async () => {
    vi.mocked(REDIS.get).mockResolvedValue({ data: [], hasMore: false, nextCursor: null });

    await service.getMovies({ limit: 5, sort: "desc" });

    expect(await cacheResult("hit")).toBe(1);
    expect(await cacheResult("miss")).toBe(0);
    expect(PG.readQuery).not.toHaveBeenCalled();
  });

  it("counts a miss and reads PostgreSQL", async () => {
    await service.getMovies({ limit: 5, sort: "desc" });

    expect(await cacheResult("miss")).toBe(1);
    expect(await cacheResult("hit")).toBe(0);
    expect(PG.readQuery).toHaveBeenCalledTimes(1);
  });

  it("counts an error when Redis fails and still serves from PostgreSQL", async () => {
    vi.mocked(REDIS.getMoviesListVersion).mockRejectedValue(new Error("redis down"));

    const page = await service.getMovies({ limit: 5, sort: "desc" });

    expect(page).toEqual({ data: [], hasMore: false, nextCursor: null });
    expect(await cacheResult("error")).toBe(1);
    expect(await cacheResult("miss")).toBe(0);
  });

  it("does not count lookups rejected by validation", async () => {
    await expect(service.getMovies({ limit: 0, sort: "desc" })).rejects.toThrow();

    const { values } = await cacheRequestsTotal.get();
    expect(values).toHaveLength(0);
  });

  it("exposes the metric with fixed labels and the movies-api service label", async () => {
    await service.getMovies({ limit: 5, sort: "desc" });

    const text = await metricsRegistry.metrics();
    expect(text).toContain(
      'cache_requests_total{cache="movies_list",result="miss",service="movies-api"} 1',
    );
  });
});
