import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeConfirmChannel } from "../test/fake-confirm-channel.ts";
import { metricValue } from "../test/metric-value.ts";

// Outbox relay with PostgreSQL replaced: publish/confirm handling and which UPDATE follows.
// SQL semantics (SKIP LOCKED, lease, ordering, backoff in the DB) are covered by
// outbox-relay.int.test.ts against real PostgreSQL.

const logLines = vi.hoisted(() => [] as string[]);

vi.mock("../infrastructure/logger.ts", async () => {
  const { pino } = await import("pino");
  const { Writable } = await import("node:stream");
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      logLines.push(chunk.toString());
      done();
    },
  });
  return { logger: pino({ level: "info" }, stream) };
});

/** `result` fields of the relay's log lines since the last reset. */
function loggedResults(): unknown[] {
  return logLines.map((line) => (JSON.parse(line) as { result?: unknown }).result);
}

vi.mock("../infrastructure/postgres.ts", () => ({
  PG: { transaction: vi.fn(), writeQuery: vi.fn() },
}));

const { runOutboxRelayBatch, refreshMessageOutboxBacklogMetrics, OUTBOX_RELAY_SETTINGS } =
  await import("./outbox-relay.ts");
const metrics = await import("../infrastructure/metrics.ts");
const { EVENTS_EXCHANGE } = await import("../messaging/topology.ts");
const { PG } = await import("../infrastructure/postgres.ts");

const transaction = vi.mocked(PG.transaction);
const writeQuery = vi.mocked(PG.writeQuery);

interface Row {
  id: string;
  message_id: string;
  routing_key: string;
  payload: Record<string, unknown>;
  attempts: number;
}

function row(n: number, attempts = 1): Row {
  return {
    id: String(n),
    message_id: `00000000-0000-4000-8000-00000000000${n}`,
    routing_key: "review.requested",
    payload: { schemaVersion: 1, jobId: `job-${n}` },
    attempts,
  };
}

function claim(rows: Row[]) {
  transaction.mockImplementation(async (callback) =>
    callback({ query: async () => ({ rows }) } as never),
  );
}

/** SQL + params of every UPDATE issued after the claim. */
function updates() {
  return writeQuery.mock.calls.map(([sql, params]) => ({
    kind: sql.includes("SET published_at")
      ? "published"
      : sql.includes("SET dead_lettered_at")
        ? "dead_lettered"
        : "retry",
    params: params ?? [],
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  logLines.length = 0;
  writeQuery.mockImplementation(async (_sql, params) => {
    const ids = params?.[0];
    return { rowCount: Array.isArray(ids) ? ids.length : 1, rows: [] } as never;
  });
});

describe("runOutboxRelayBatch", () => {
  it("claims nothing without a channel", async () => {
    expect(await runOutboxRelayBatch(null)).toBe(0);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("returns 0 and publishes nothing for an empty claim", async () => {
    claim([]);
    const channel = new FakeConfirmChannel();

    expect(await runOutboxRelayBatch(channel.asRelayChannel())).toBe(0);
    expect(channel.published).toHaveLength(0);
    expect(writeQuery).not.toHaveBeenCalled();
  });

  it("publishes persistent, mandatory messages with the outbox message_id and marks them after the ack", async () => {
    claim([row(1), row(2)]);
    const channel = new FakeConfirmChannel("ack");

    expect(await runOutboxRelayBatch(channel.asRelayChannel())).toBe(2);

    expect(channel.published).toHaveLength(2);
    expect(channel.published[0]).toMatchObject({
      exchange: EVENTS_EXCHANGE,
      routingKey: "review.requested",
      body: { schemaVersion: 1, jobId: "job-1" },
      options: {
        persistent: true,
        mandatory: true,
        messageId: row(1).message_id,
        contentType: "application/json",
        type: "review.requested",
      },
    });
    expect(updates()).toEqual([
      { kind: "published", params: [["1", "2"], expect.any(String)] },
    ]);
  });

  it("treats a returned (unroutable) message as not published", async () => {
    claim([row(1), row(2)]);
    const channel = new FakeConfirmChannel(["return", "ack"]);

    await runOutboxRelayBatch(channel.asRelayChannel());

    const result = updates();
    expect(result).toContainEqual({ kind: "published", params: [["2"], expect.any(String)] });
    const retry = result.find((u) => u.kind === "retry");
    expect(retry?.params[0]).toBe("1");
    expect(retry?.params[3]).toMatch(/^unroutable/);
  });

  it("schedules a retry on nack", async () => {
    claim([row(1)]);

    await runOutboxRelayBatch(new FakeConfirmChannel("nack").asRelayChannel());

    expect(updates()).toEqual([
      { kind: "retry", params: ["1", expect.any(String), expect.any(Number), "message nacked"] },
    ]);
  });

  it("schedules a retry when publish throws (closed channel) and still publishes the rest", async () => {
    claim([row(1), row(2)]);
    const channel = new FakeConfirmChannel(["throw", "ack"]);

    await runOutboxRelayBatch(channel.asRelayChannel());

    expect(updates()).toEqual([
      { kind: "published", params: [["2"], expect.any(String)] },
      { kind: "retry", params: ["1", expect.any(String), expect.any(Number), "Channel closed"] },
    ]);
  });

  it("does not mark a message without a confirm before the deadline", async () => {
    claim([row(1), row(2)]);
    const channel = new FakeConfirmChannel(["never", "ack"]);

    await runOutboxRelayBatch(channel.asRelayChannel(), { confirmTimeoutMs: 20 });

    const result = updates();
    expect(result).toContainEqual({ kind: "published", params: [["2"], expect.any(String)] });
    const retry = result.find((u) => u.kind === "retry");
    expect(retry?.params[0]).toBe("1");
    expect(retry?.params[3]).toMatch(/no confirm within 20 ms/);
  });

  it("waits for drain when the write buffer is full", async () => {
    claim([row(1), row(2)]);
    const channel = new FakeConfirmChannel(["full", "ack"]);

    const batch = runOutboxRelayBatch(channel.asRelayChannel());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(channel.published).toHaveLength(1);

    channel.emit("drain");
    await batch;

    expect(channel.published).toHaveLength(2);
    expect(updates()).toEqual([{ kind: "published", params: [["1", "2"], expect.any(String)] }]);
  });

  it("gives up waiting for drain at the deadline and does not publish the rest", async () => {
    claim([row(1), row(2)]);
    const channel = new FakeConfirmChannel(["full", "ack"]);

    await runOutboxRelayBatch(channel.asRelayChannel(), { confirmTimeoutMs: 20 });

    expect(channel.published).toHaveLength(1);
    const retry = updates().find((u) => u.kind === "retry");
    expect(retry?.params[0]).toBe("2");
    expect(retry?.params[3]).toMatch(/deadline passed/);
  });

  it("dead-letters after the last attempt", async () => {
    claim([row(1, OUTBOX_RELAY_SETTINGS.maxAttempts)]);

    await runOutboxRelayBatch(new FakeConfirmChannel("return").asRelayChannel());

    expect(updates()).toEqual([
      { kind: "dead_lettered", params: ["1", expect.any(String), expect.stringMatching(/^unroutable/)] },
    ]);
  });

  it("removes its return listener after the batch", async () => {
    claim([row(1)]);
    const channel = new FakeConfirmChannel("ack");

    await runOutboxRelayBatch(channel.asRelayChannel());

    expect(channel.listenerCount("return")).toBe(0);
    expect(channel.listenerCount("drain")).toBe(0);
  });

  it("schedules a retry when the channel closes with confirms pending", async () => {
    claim([row(1), row(2)]);
    // Real amqplib: on close, pending confirm callbacks get "channel closed" asynchronously.
    const channel = new FakeConfirmChannel((_message, confirm) => {
      setImmediate(() => confirm(new Error("channel closed")));
    });

    await runOutboxRelayBatch(channel.asRelayChannel());

    expect(updates()).toEqual([
      { kind: "retry", params: ["1", expect.any(String), expect.any(Number), "channel closed"] },
      { kind: "retry", params: ["2", expect.any(String), expect.any(Number), "channel closed"] },
    ]);
  });

  it("ignores a confirm that arrives after the deadline", async () => {
    claim([row(1)]);
    const channel = new FakeConfirmChannel((_message, confirm) => {
      setTimeout(() => confirm(null), 40);
    });

    await runOutboxRelayBatch(channel.asRelayChannel(), { confirmTimeoutMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Retried (the broker may have it → duplicate later), never marked published.
    expect(updates().map((u) => u.kind)).toEqual(["retry"]);
  });

  it("logs lease_lost instead of a retry when the reschedule matches no row", async () => {
    claim([row(1)]);
    writeQuery.mockResolvedValue({ rowCount: 0, rows: [] } as never);

    await runOutboxRelayBatch(new FakeConfirmChannel("nack").asRelayChannel());

    expect(loggedResults()).toContain("lease_lost");
    expect(loggedResults()).not.toContain("retry_scheduled");
  });

  it("logs lease_lost instead of a dead-letter when the update matches no row", async () => {
    claim([row(1, OUTBOX_RELAY_SETTINGS.maxAttempts)]);
    writeQuery.mockResolvedValue({ rowCount: 0, rows: [] } as never);

    await runOutboxRelayBatch(new FakeConfirmChannel("nack").asRelayChannel());

    expect(loggedResults()).toContain("lease_lost");
    expect(loggedResults()).not.toContain("dead_lettered");
  });

  it("logs retry_scheduled and dead_lettered when the update succeeds", async () => {
    claim([row(1), row(2, OUTBOX_RELAY_SETTINGS.maxAttempts)]);

    await runOutboxRelayBatch(new FakeConfirmChannel("nack").asRelayChannel());

    expect(loggedResults()).toEqual(
      expect.arrayContaining(["retry_scheduled", "dead_lettered"]),
    );
    expect(loggedResults()).not.toContain("lease_lost");
  });

  it("still reschedules failures when marking published fails", async () => {
    claim([row(1), row(2)]);
    writeQuery.mockRejectedValueOnce(new Error("PG down"));
    const channel = new FakeConfirmChannel(["ack", "nack"]);

    await runOutboxRelayBatch(channel.asRelayChannel());

    expect(updates().map((u) => u.kind)).toEqual(["published", "retry"]);
  });
});

describe("relay metrics", () => {
  // Counters are process-wide: compare deltas.
  async function snapshot() {
    const read = async (metric: typeof metrics.messageOutboxPublishTotal, results: readonly string[]) =>
      Object.fromEntries(
        await Promise.all(results.map(async (r) => [r, await metricValue(metric, { result: r })])),
      ) as Record<string, number>;
    return {
      publish: await read(metrics.messageOutboxPublishTotal, metrics.MESSAGE_OUTBOX_PUBLISH_RESULTS),
      events: await read(metrics.messageOutboxEventsTotal, metrics.MESSAGE_OUTBOX_EVENT_RESULTS),
    };
  }
  async function deltaSince(before: Awaited<ReturnType<typeof snapshot>>) {
    const after = await snapshot();
    const diff = (a: Record<string, number>, b: Record<string, number>) =>
      Object.fromEntries(
        Object.entries(a)
          .map(([k, v]) => [k, v - (b[k] ?? 0)] as const)
          .filter(([, v]) => v !== 0),
      );
    return { publish: diff(after.publish, before.publish), events: diff(after.events, before.events) };
  }

  it("pre-creates every result series at 0 (increase() sees the first event)", async () => {
    // Fresh module instance: earlier tests in this file already created the series.
    vi.resetModules();
    const fresh = await import("../infrastructure/metrics.ts");
    for (const [name, results] of [
      ["message_outbox_events_total", fresh.MESSAGE_OUTBOX_EVENT_RESULTS],
      ["message_outbox_publish_total", fresh.MESSAGE_OUTBOX_PUBLISH_RESULTS],
    ] as const) {
      const text = await fresh.metricsRegistry.getSingleMetricAsString(name);
      for (const result of results) {
        expect(text).toContain(`${name}{result="${result}",service="movies-api"} 0`);
      }
    }
  });

  it("counts the broker result per publish and the DB outcome per row", async () => {
    claim([row(1), row(2), row(3, OUTBOX_RELAY_SETTINGS.maxAttempts)]);
    const before = await snapshot();

    await runOutboxRelayBatch(new FakeConfirmChannel(["ack", "return", "nack"]).asRelayChannel());

    expect(await deltaSince(before)).toEqual({
      publish: { published: 1, returned: 1, publish_failed: 1 },
      events: { published: 1, retry_scheduled: 1, dead_lettered: 1 },
    });
  });

  it("counts confirmed rows that could not be marked as lease_lost", async () => {
    claim([row(1), row(2)]);
    writeQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] } as never);
    const before = await snapshot();

    await runOutboxRelayBatch(new FakeConfirmChannel("ack").asRelayChannel());

    expect((await deltaSince(before)).events).toEqual({ published: 1, lease_lost: 1 });
  });

  it("counts failed mark and reschedule UPDATEs as db_error", async () => {
    claim([row(1), row(2)]);
    writeQuery.mockRejectedValue(new Error("PG down"));
    const before = await snapshot();

    await runOutboxRelayBatch(new FakeConfirmChannel(["ack", "nack"]).asRelayChannel());

    expect((await deltaSince(before)).events).toEqual({ db_error: 2 });
  });
});

describe("refreshMessageOutboxBacklogMetrics", () => {
  const gauges = async () => ({
    pending: await metricValue(metrics.messageOutboxPendingMessages),
    oldest: await metricValue(metrics.messageOutboxOldestPendingAge),
    deadLettered: await metricValue(metrics.messageOutboxDeadLetteredMessages),
    refreshedAt: await metricValue(metrics.messageOutboxBacklogRefreshedAt),
  });

  it("sets the gauges from one query, at most once per 10 s, and keeps them on failure", async () => {
    writeQuery.mockResolvedValueOnce({
      rows: [{ pending: 3, oldest_age_seconds: 42.5, dead_lettered: 2 }],
    } as never);

    await refreshMessageOutboxBacklogMetrics(1_000_000_000);
    expect(await gauges()).toEqual({ pending: 3, oldest: 42.5, deadLettered: 2, refreshedAt: 1_000_000 });
    expect(writeQuery.mock.calls[0]?.[0]).toMatch(/FROM message_outbox\s+WHERE published_at IS NULL/);

    // Throttled: no query within the interval.
    await refreshMessageOutboxBacklogMetrics(1_000_009_999);
    expect(writeQuery).toHaveBeenCalledTimes(1);

    // Failure: logged, previous values kept (staleness visible via refreshedAt).
    writeQuery.mockRejectedValueOnce(new Error("PG down"));
    await refreshMessageOutboxBacklogMetrics(1_000_010_000);
    expect(writeQuery).toHaveBeenCalledTimes(2);
    expect(await gauges()).toEqual({ pending: 3, oldest: 42.5, deadLettered: 2, refreshedAt: 1_000_000 });
  });
});
