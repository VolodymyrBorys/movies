import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import { PG } from "../infrastructure/postgres.ts";
import { REDIS } from "../infrastructure/redis.ts";
import { logger as rootLogger } from "../infrastructure/logger.ts";
import {
  outboxBacklogRefreshedAt,
  outboxBatchDuration,
  outboxEventsTotal,
  outboxOldestPendingAge,
  outboxPendingEvents,
} from "../infrastructure/metrics.ts";

const logger = rootLogger.child({ component: "cache-invalidation-worker" });

const workerId = `cache-invalidation-${randomUUID()}`;
const batchSize = 25;
const leaseSeconds = 30;
const maxAttempts = 20;

interface OutboxEvent extends QueryResultRow {
  id: string;
  event_type: string;
  attempts: number;
}

function retryDelayMs(attempts: number): number {
  const exponential = Math.min(
    1_000 * 2 ** Math.min(attempts - 1, 8),
    5 * 60_000,
  );

  return exponential + Math.floor(Math.random() * 1_000);
}

async function claimBatch(): Promise<OutboxEvent[]> {
  return PG.transaction(async (client) => {
    const result = await client.query<OutboxEvent>(
      `
        WITH candidates AS (
          SELECT id
          FROM cache_invalidation_outbox
          WHERE processed_at IS NULL
            AND dead_lettered_at IS NULL
            AND available_at <= now()
            AND (
              locked_until IS NULL
              OR locked_until < now()
            )
          ORDER BY id
          FOR UPDATE SKIP LOCKED
          LIMIT $1
        )
        UPDATE cache_invalidation_outbox AS o
        SET locked_by = $2,
            locked_until = now() + ($3 * interval '1 second'),
            attempts = o.attempts + 1
        FROM candidates
        WHERE o.id = candidates.id
        RETURNING o.id, o.event_type, o.attempts
      `,
      [batchSize, workerId, leaseSeconds],
    );

    return result.rows;
  });
}

async function markProcessed(id: string): Promise<void> {
  const result = await PG.writeQuery(
    `
      UPDATE cache_invalidation_outbox
      SET processed_at = now(),
          locked_by = NULL,
          locked_until = NULL,
          last_error = NULL
      WHERE id = $1
        AND locked_by = $2
        AND processed_at IS NULL
        AND dead_lettered_at IS NULL
    `,
    [id, workerId],
  );

  if (result.rowCount !== 1) {
    throw new Error(`Outbox event ${id} was not marked processed`);
  }
}

async function scheduleRetry(
  event: OutboxEvent,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);

  if (event.attempts >= maxAttempts) {
    await PG.writeQuery(
      `
        UPDATE cache_invalidation_outbox
        SET dead_lettered_at = now(),
            locked_by = NULL,
            locked_until = NULL,
            last_error = $3
        WHERE id = $1
          AND locked_by = $2
          AND processed_at IS NULL
      `,
      [event.id, workerId, message.slice(0, 4_000)],
    );
    outboxEventsTotal.inc({ result: "dead_lettered" });

    logger.error(
      { eventId: event.id, attempts: event.attempts, lastError: message },
      "Outbox event moved to dead-letter state",
    );

    return;
  }

  await PG.writeQuery(
    `
      UPDATE cache_invalidation_outbox
      SET available_at = now() + ($3 * interval '1 millisecond'),
          locked_by = NULL,
          locked_until = NULL,
          last_error = $4
      WHERE id = $1
        AND locked_by = $2
        AND processed_at IS NULL
    `,
    [event.id, workerId, retryDelayMs(event.attempts), message.slice(0, 4_000)],
  );
  outboxEventsTotal.inc({ result: "retry_scheduled" });
}

async function processEvent(event: OutboxEvent): Promise<void> {
  switch (event.event_type) {
    case "movies.list.invalidate":
      await REDIS.invalidateMoviesList();
      return;

    default:
      throw new Error(`Unsupported event type: ${event.event_type}`);
  }
}

export async function runCacheInvalidationBatch(): Promise<number> {
  const startedAt = process.hrtime.bigint();
  const events = await claimBatch();

  for (const event of events) {
    try {
      await processEvent(event);
      await markProcessed(event.id);
      outboxEventsTotal.inc({ result: "processed" });
    } catch (error) {
      try {
        await scheduleRetry(event, error);
      } catch (persistenceError) {
        outboxEventsTotal.inc({ result: "reschedule_failed" });
        // Якщо PostgreSQL теж недоступний, lease закінчиться,
        // і подія знову стане доступною для захоплення.
        logger.error(
          { eventId: event.id, err: persistenceError },
          "Could not reschedule outbox event",
        );
      }
    }
  }

  if (events.length > 0) {
    outboxBatchDuration.observe(
      Number(process.hrtime.bigint() - startedAt) / 1e9,
    );
  }

  return events.length;
}

// Backlog is sampled by the worker, NOT on /metrics scrape: a scrape-time query would
// make /v1/metrics slow or failing exactly when PostgreSQL is in trouble.
const BACKLOG_REFRESH_INTERVAL_MS = 10_000;
let lastBacklogRefreshMs = 0;

/**
 * Updates backlog gauges at most once per interval. Pending rows are the ones covered by
 * the partial index cache_invalidation_outbox_pending_idx, so the scan stays small while
 * processed rows accumulate (hypothesis — confirm with EXPLAIN ANALYZE on real volume).
 * Failures are logged and leave the previous values; staleness is visible through
 * outbox_backlog_last_refresh_timestamp_seconds.
 */
export async function refreshOutboxBacklogMetrics(
  nowMs: number = Date.now(),
): Promise<void> {
  if (nowMs - lastBacklogRefreshMs < BACKLOG_REFRESH_INTERVAL_MS) return;
  lastBacklogRefreshMs = nowMs;

  try {
    const { rows } = await PG.writeQuery<{
      pending: number;
      oldest_age_seconds: number;
    }>(
      `
        SELECT
          count(*)::int AS pending,
          COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)), 0)::float8 AS oldest_age_seconds
        FROM cache_invalidation_outbox
        WHERE processed_at IS NULL
          AND dead_lettered_at IS NULL
      `,
    );

    const row = rows[0];
    if (row === undefined) throw new Error("Backlog query returned no rows");

    outboxPendingEvents.set(row.pending);
    outboxOldestPendingAge.set(row.oldest_age_seconds);
    outboxBacklogRefreshedAt.set(nowMs / 1000);
  } catch (error) {
    logger.warn({ err: error }, "Outbox backlog metrics refresh failed");
  }
}
