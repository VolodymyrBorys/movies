import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PG } from "../infrastructure/postgres.ts";
import { REDIS } from "../infrastructure/redis.ts";
import { moviesRepository } from "../modules/movies/movies.repository.ts";
import { runCacheInvalidationBatch } from "./cache-invalidation.ts";
import {
  insertMovie,
  outboxRows,
  resetState,
  startInfrastructure,
  stopInfrastructure,
} from "../test/integration-db.ts";

// Integration: outbox worker against real PostgreSQL + Redis.
// The runner loop (polling/sleep) is not started; batches are run explicitly.

beforeAll(startInfrastructure);
afterAll(stopInfrastructure);
beforeEach(resetState);

async function insertOutboxEvent(fields: {
  eventType?: string;
  attempts?: number;
  lockedBy?: string | null;
  lockedUntilSql?: string;
}): Promise<void> {
  await PG.writeQuery(
    `
      INSERT INTO cache_invalidation_outbox
        (aggregate_type, aggregate_id, event_type, attempts, locked_by, locked_until)
      VALUES ('movie', 'test', $1, $2, $3, ${fields.lockedUntilSql ?? "NULL"})
    `,
    [
      fields.eventType ?? "movies.list.invalidate",
      fields.attempts ?? 0,
      fields.lockedBy ?? null,
    ],
  );
}

describe("cache invalidation outbox worker", () => {
  it("processes an event written by a movie update and bumps the list version", async () => {
    const id = await insertMovie({ createdAt: "2026-01-01T00:00:00.000000Z" });
    const versionBefore = await REDIS.getMoviesListVersion();

    // Repository only (no service): no best-effort immediate invalidation,
    // so the version change can only come from the worker.
    await moviesRepository.updateMovie(id, "published");

    expect(await runCacheInvalidationBatch()).toBe(1);

    const [event] = await outboxRows();
    expect(event).toMatchObject({
      attempts: 1,
      locked_by: null,
      locked_until: null,
      last_error: null,
      dead_lettered_at: null,
    });
    expect(event?.processed_at).toBeInstanceOf(Date);
    expect(await REDIS.getMoviesListVersion()).not.toBe(versionBefore);

    // Processed events are not claimed again.
    expect(await runCacheInvalidationBatch()).toBe(0);
  });

  it("lets only one of two concurrent batches claim an event (SKIP LOCKED)", async () => {
    await insertOutboxEvent({});

    const counts = await Promise.all([
      runCacheInvalidationBatch(),
      runCacheInvalidationBatch(),
    ]);

    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    const [event] = await outboxRows();
    expect(event?.attempts).toBe(1);
    expect(event?.processed_at).toBeInstanceOf(Date);
  });

  it("schedules a retry with backoff when processing fails", async () => {
    await insertOutboxEvent({ eventType: "unknown.event" });

    expect(await runCacheInvalidationBatch()).toBe(1);

    const [event] = await outboxRows();
    expect(event).toMatchObject({
      attempts: 1,
      locked_by: null,
      processed_at: null,
      dead_lettered_at: null,
    });
    expect(event?.last_error).toMatch(/Unsupported event type/);
    // Backoff: not available again immediately.
    expect(event!.available_at.getTime()).toBeGreaterThan(Date.now());
    expect(await runCacheInvalidationBatch()).toBe(0);
  });

  it("dead-letters an event on its last allowed attempt", async () => {
    await insertOutboxEvent({ eventType: "unknown.event", attempts: 19 });

    await runCacheInvalidationBatch();

    const [event] = await outboxRows();
    expect(event?.attempts).toBe(20);
    expect(event?.dead_lettered_at).toBeInstanceOf(Date);
    expect(event?.processed_at).toBeNull();
    expect(await runCacheInvalidationBatch()).toBe(0);
  });

  it("does not claim an event under an active lease, but reclaims an expired one", async () => {
    await insertOutboxEvent({
      lockedBy: "other-worker",
      lockedUntilSql: "now() + interval '1 minute'",
    });
    expect(await runCacheInvalidationBatch()).toBe(0);

    await PG.writeQuery(
      "UPDATE cache_invalidation_outbox SET locked_until = now() - interval '1 second'",
    );
    expect(await runCacheInvalidationBatch()).toBe(1);

    const [event] = await outboxRows();
    expect(event?.processed_at).toBeInstanceOf(Date);
  });
});
