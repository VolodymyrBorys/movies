import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import { PG } from "../infrastructure/postgres.ts";
import { REDIS } from "../infrastructure/redis.ts";

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

    console.error("Outbox event moved to dead-letter state", {
      eventId: event.id,
      attempts: event.attempts,
      error: message,
    });

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
  const events = await claimBatch();

  for (const event of events) {
    try {
      await processEvent(event);
      await markProcessed(event.id);
    } catch (error) {
      try {
        await scheduleRetry(event, error);
      } catch (persistenceError) {
        // Якщо PostgreSQL теж недоступний, lease закінчиться,
        // і подія знову стане доступною для захоплення.
        console.error("Could not reschedule outbox event", {
          eventId: event.id,
          error: persistenceError,
        });
      }
    }
  }

  return events.length;
}
