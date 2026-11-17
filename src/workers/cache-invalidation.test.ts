import { beforeEach, describe, expect, it, vi } from "vitest";

// Worker metrics with PostgreSQL/Redis replaced. SQL semantics (SKIP LOCKED, lease,
// backoff in the DB) are covered by cache-invalidation.int.test.ts against real PG.

vi.mock("../infrastructure/logger.ts", async () => {
  const { pino } = await import("pino");
  return { logger: pino({ level: "silent" }) };
});

vi.mock("../infrastructure/postgres.ts", () => ({
  PG: { transaction: vi.fn(), writeQuery: vi.fn() },
}));

vi.mock("../infrastructure/redis.ts", () => ({
  REDIS: { invalidateMoviesList: vi.fn() },
}));

const { runCacheInvalidationBatch, refreshOutboxBacklogMetrics } = await import(
  "./cache-invalidation.ts"
);
const { PG } = await import("../infrastructure/postgres.ts");
const { REDIS } = await import("../infrastructure/redis.ts");
const metrics = await import("../infrastructure/metrics.ts");
const { metricValue } = await import("../test/metric-value.ts");

const transaction = vi.mocked(PG.transaction);
const writeQuery = vi.mocked(PG.writeQuery);

function claim(events: { id: string; event_type: string; attempts: number }[]) {
  transaction.mockImplementation(async (callback) =>
    callback({ query: async () => ({ rows: events }) } as never),
  );
}

const outboxResult = (result: string) =>
  metricValue(metrics.outboxEventsTotal, { result });
const batchCount = () => metricValue(metrics.outboxBatchDuration, {}, "_count");

beforeEach(() => {
  vi.clearAllMocks();
  metrics.metricsRegistry.resetMetrics();
  vi.mocked(REDIS.invalidateMoviesList).mockResolvedValue("v2");
  writeQuery.mockResolvedValue({ rowCount: 1, rows: [] } as never);
});

describe("runCacheInvalidationBatch metrics", () => {
  it("counts processed events and observes batch duration", async () => {
    claim([
      { id: "1", event_type: "movies.list.invalidate", attempts: 1 },
      { id: "2", event_type: "movies.list.invalidate", attempts: 1 },
    ]);

    expect(await runCacheInvalidationBatch()).toBe(2);

    expect(await outboxResult("processed")).toBe(2);
    expect(await batchCount()).toBe(1);
  });

  it("does not observe duration for empty polls", async () => {
    claim([]);

    await runCacheInvalidationBatch();

    expect(await batchCount()).toBe(0);
  });

  it("counts a scheduled retry when handling fails", async () => {
    claim([{ id: "1", event_type: "unknown.event", attempts: 1 }]);

    await runCacheInvalidationBatch();

    expect(await outboxResult("retry_scheduled")).toBe(1);
    expect(await outboxResult("processed")).toBe(0);
  });

  it("counts a dead-lettered event on the last attempt", async () => {
    claim([{ id: "1", event_type: "unknown.event", attempts: 20 }]);

    await runCacheInvalidationBatch();

    expect(await outboxResult("dead_lettered")).toBe(1);
    expect(await outboxResult("retry_scheduled")).toBe(0);
  });

  it("counts reschedule_failed when the retry cannot be persisted", async () => {
    claim([{ id: "1", event_type: "unknown.event", attempts: 1 }]);
    writeQuery.mockRejectedValue(new Error("db down"));

    await runCacheInvalidationBatch();

    expect(await outboxResult("reschedule_failed")).toBe(1);
    expect(await outboxResult("retry_scheduled")).toBe(0);
  });
});

describe("refreshOutboxBacklogMetrics", () => {
  // Module-level throttle state persists across tests: use far-apart timestamps.
  it("sets backlog gauges and the refresh timestamp", async () => {
    writeQuery.mockResolvedValue({
      rows: [{ pending: 7, oldest_age_seconds: 42.5 }],
    } as never);

    await refreshOutboxBacklogMetrics(1_000_000_000);

    expect(await metricValue(metrics.outboxPendingEvents)).toBe(7);
    expect(await metricValue(metrics.outboxOldestPendingAge)).toBe(42.5);
    expect(await metricValue(metrics.outboxBacklogRefreshedAt)).toBe(1_000_000);
  });

  it("queries at most once per 10 s", async () => {
    writeQuery.mockResolvedValue({
      rows: [{ pending: 0, oldest_age_seconds: 0 }],
    } as never);

    await refreshOutboxBacklogMetrics(2_000_000_000);
    await refreshOutboxBacklogMetrics(2_000_009_999);
    expect(writeQuery).toHaveBeenCalledTimes(1);

    await refreshOutboxBacklogMetrics(2_000_010_000);
    expect(writeQuery).toHaveBeenCalledTimes(2);
  });

  it("keeps previous values and the old timestamp when the query fails", async () => {
    writeQuery.mockResolvedValueOnce({
      rows: [{ pending: 3, oldest_age_seconds: 1 }],
    } as never);
    await refreshOutboxBacklogMetrics(3_000_000_000);

    writeQuery.mockRejectedValueOnce(new Error("db down"));
    await expect(
      refreshOutboxBacklogMetrics(3_000_020_000),
    ).resolves.toBeUndefined();

    expect(await metricValue(metrics.outboxPendingEvents)).toBe(3);
    expect(await metricValue(metrics.outboxBacklogRefreshedAt)).toBe(3_000_000);
  });
});
