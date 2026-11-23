import { randomUUID } from "node:crypto";
import type { ConfirmChannel, Message } from "amqplib";
import type { QueryResultRow } from "pg";
import { PG } from "../infrastructure/postgres.ts";
import { logger as rootLogger } from "../infrastructure/logger.ts";
import { EVENTS_EXCHANGE } from "../messaging/topology.ts";

// Outbox relay (P5.3): message_outbox → RabbitMQ with publisher confirms.
//
// A row is marked published only after the broker confirmed the message (basic.ack) and did
// not return it as unroutable. Everything else — nack, return, channel closed, no confirm
// before the deadline — leaves the row unpublished and schedules a retry. Delivery is
// therefore at-least-once: a crash between the confirm and the UPDATE, or a confirm that
// arrives after the deadline, republishes the message with the same AMQP messageId.
// Consumers must be idempotent.
//
// LAB: simplified — no ordering guarantee. Parallel relays and retries can reorder messages;
// fine for review.requested (one message per job). Per-aggregate ordering would need a
// single active relay per aggregate (e.g. partitioning by aggregate_id) or a sequence check
// in the consumer.

const logger = rootLogger.child({ component: "outbox-relay" });

export const OUTBOX_RELAY_SETTINGS = Object.freeze({
  batchSize: 50,
  leaseSeconds: 30,
  // Must stay well below the lease: once the lease expires another relay may claim the row
  // while we still wait for its confirm → guaranteed duplicate.
  confirmTimeoutMs: 10_000,
  maxAttempts: 20,
});

/** The part of a ConfirmChannel the relay uses (narrow for test fakes). */
export type RelayChannel = Pick<ConfirmChannel, "publish" | "on" | "off" | "once">;

export interface OutboxRelayOptions {
  /** Test seam; defaults to OUTBOX_RELAY_SETTINGS.confirmTimeoutMs. */
  confirmTimeoutMs?: number;
}

interface OutboxMessageRow extends QueryResultRow {
  id: string;
  message_id: string;
  routing_key: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export type PublishResult = "published" | "returned" | "publish_failed" | "timeout";

type PublishOutcome =
  | { result: "published" }
  | { result: Exclude<PublishResult, "published">; error: string };

const workerId = `outbox-relay-${randomUUID()}`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Same policy as the cache-invalidation worker: 1 s doubling, + up to 1 s jitter. The exponent cap
// (8) makes 256 s the effective maximum; the 5 min cap never applies.
function retryDelayMs(attempts: number): number {
  const exponential = Math.min(1_000 * 2 ** Math.min(attempts - 1, 8), 5 * 60_000);
  return exponential + Math.floor(Math.random() * 1_000);
}

async function claimBatch(): Promise<OutboxMessageRow[]> {
  return PG.transaction(async (client) => {
    // ORDER BY (available_at, id) matches message_outbox_pending_idx. RETURNING has no
    // defined order, hence the outer SELECT ... ORDER BY.
    const result = await client.query<OutboxMessageRow>(
      `
        WITH candidates AS (
          SELECT id
          FROM message_outbox
          WHERE published_at IS NULL
            AND dead_lettered_at IS NULL
            AND available_at <= now()
            AND (locked_until IS NULL OR locked_until < now())
          ORDER BY available_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT $1
        ),
        claimed AS (
          UPDATE message_outbox AS o
          SET locked_by = $2,
              locked_until = now() + ($3 * interval '1 second'),
              attempts = o.attempts + 1
          FROM candidates
          WHERE o.id = candidates.id
          RETURNING o.id, o.message_id, o.routing_key, o.payload, o.attempts, o.available_at
        )
        SELECT id, message_id, routing_key, payload, attempts
        FROM claimed
        ORDER BY available_at, id
      `,
      [OUTBOX_RELAY_SETTINGS.batchSize, workerId, OUTBOX_RELAY_SETTINGS.leaseSeconds],
    );

    return result.rows;
  });
}

/**
 * Publishes one message. `flushed === false` means the channel's write buffer is full
 * (publish() returned false): the caller waits for `drain` before the next publish.
 */
function publishOne(
  channel: RelayChannel,
  row: OutboxMessageRow,
  returned: ReadonlySet<string>,
): { confirm: Promise<PublishOutcome>; flushed: boolean } {
  let flushed = true;

  // The executor runs synchronously, so `flushed` is set before we return.
  const confirm = new Promise<PublishOutcome>((resolve) => {
    try {
      flushed = channel.publish(
        EVENTS_EXCHANGE,
        row.routing_key,
        Buffer.from(JSON.stringify(row.payload)),
        {
          persistent: true,
          // Without `mandatory`, an unroutable message (no bound queue) is acked and dropped.
          mandatory: true,
          messageId: row.message_id,
          contentType: "application/json",
          type: row.routing_key,
          timestamp: Math.floor(Date.now() / 1000),
        },
        (err: unknown) => {
          if (err) {
            // Broker nack ("message nacked") or "channel closed" with the message unconfirmed.
            resolve({ result: "publish_failed", error: errorMessage(err) });
          } else if (returned.has(row.message_id)) {
            // basic.return arrives before basic.ack on the same channel.
            resolve({
              result: "returned",
              error: `unroutable: no queue bound to ${EVENTS_EXCHANGE} for ${row.routing_key}`,
            });
          } else {
            resolve({ result: "published" });
          }
        },
      );
    } catch (error) {
      // E.g. IllegalOperationError: the channel is already closed.
      resolve({ result: "publish_failed", error: errorMessage(error) });
    }
  });

  return { confirm, flushed };
}

function waitForDrain(channel: RelayChannel, deadline: Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      channel.off("drain", done);
      channel.off("close", done);
      resolve();
    };
    channel.once("drain", done);
    // Closed channel: the next publish throws and is recorded as publish_failed.
    channel.once("close", done);
    void deadline.then(done);
  });
}

async function publishBatch(
  channel: RelayChannel,
  rows: OutboxMessageRow[],
  confirmTimeoutMs: number,
): Promise<{ row: OutboxMessageRow; outcome: PublishOutcome }[]> {
  // Keyed by messageId, which is stable across republishes: a late return of an earlier
  // (timed-out) publish of the same row that arrives during this batch marks this publish
  // returned too. Errs on the safe side — an extra retry and a duplicate, never a lost message.
  const returned = new Set<string>();
  const onReturn = (message: Message) => {
    const messageId: unknown = message.properties.messageId;
    if (typeof messageId === "string") returned.add(messageId);
  };

  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, confirmTimeoutMs);
  });
  const timeout = (error: string): PublishOutcome => ({ result: "timeout", error });

  channel.on("return", onReturn);

  try {
    const pending: Promise<{ row: OutboxMessageRow; outcome: PublishOutcome }>[] = [];

    for (const row of rows) {
      if (timedOut) {
        pending.push(Promise.resolve({ row, outcome: timeout("not published: deadline passed") }));
        continue;
      }

      const { confirm, flushed } = publishOne(channel, row, returned);
      const bounded = Promise.race([
        confirm,
        deadline.then(() => timeout(`no confirm within ${confirmTimeoutMs} ms`)),
      ]);
      pending.push(bounded.then((outcome) => ({ row, outcome })));

      if (!flushed) await waitForDrain(channel, deadline);
    }

    return await Promise.all(pending);
  } finally {
    clearTimeout(timer);
    channel.off("return", onReturn);
  }
}

async function markPublished(ids: string[]): Promise<void> {
  const result = await PG.writeQuery(
    `
      UPDATE message_outbox
      SET published_at = now(),
          locked_by = NULL,
          locked_until = NULL,
          last_error = NULL
      WHERE id = ANY($1::bigint[])
        AND locked_by = $2
        AND published_at IS NULL
        AND dead_lettered_at IS NULL
    `,
    [ids, workerId],
  );

  if (result.rowCount !== ids.length) {
    // Lease lost (expired and taken over): the other relay republishes → duplicate message.
    logger.warn(
      { expected: ids.length, marked: result.rowCount },
      "Some confirmed outbox messages were not marked published (lease lost)",
    );
  }
}

async function scheduleRetry(row: OutboxMessageRow, outcome: PublishOutcome): Promise<void> {
  const error = "error" in outcome ? outcome.error.slice(0, 4_000) : null;
  const context = {
    outboxId: row.id,
    messageId: row.message_id,
    routingKey: row.routing_key,
    attempts: row.attempts,
    publishResult: outcome.result,
    lastError: error,
  };

  if (row.attempts >= OUTBOX_RELAY_SETTINGS.maxAttempts) {
    const result = await PG.writeQuery(
      `
        UPDATE message_outbox
        SET dead_lettered_at = now(),
            locked_by = NULL,
            locked_until = NULL,
            last_error = $3
        WHERE id = $1
          AND locked_by = $2
          AND published_at IS NULL
      `,
      [row.id, workerId, error],
    );
    if (result.rowCount !== 1) {
      logLeaseLost(context);
      return;
    }
    logger.error({ ...context, result: "dead_lettered" }, "Outbox message dead-lettered");
    return;
  }

  const delayMs = retryDelayMs(row.attempts);
  const result = await PG.writeQuery(
    `
      UPDATE message_outbox
      SET available_at = now() + ($3 * interval '1 millisecond'),
          locked_by = NULL,
          locked_until = NULL,
          last_error = $4
      WHERE id = $1
        AND locked_by = $2
        AND published_at IS NULL
    `,
    [row.id, workerId, delayMs, error],
  );
  if (result.rowCount !== 1) {
    logLeaseLost(context);
    return;
  }
  logger.warn(
    { ...context, result: "retry_scheduled", delayMs },
    "Outbox message not published; retry scheduled",
  );
}

// The UPDATE matched nothing: another relay took the row over after our lease expired (or it
// was already finalized). Its state is that relay's business; ours must not claim an outcome.
function logLeaseLost(context: Record<string, unknown>): void {
  logger.warn({ ...context, result: "lease_lost" }, "Outbox message not rescheduled (lease lost)");
}

/**
 * Claims one batch and relays it. Returns the number of claimed rows (0 → caller sleeps).
 * With no channel (broker down, channel being reopened) nothing is claimed, so attempts
 * aren't burned while the broker is unavailable.
 */
export async function runOutboxRelayBatch(
  channel: RelayChannel | null,
  options: OutboxRelayOptions = {},
): Promise<number> {
  if (channel === null) return 0;

  const rows = await claimBatch();
  if (rows.length === 0) return 0;

  const results = await publishBatch(
    channel,
    rows,
    options.confirmTimeoutMs ?? OUTBOX_RELAY_SETTINGS.confirmTimeoutMs,
  );

  const counts: Partial<Record<PublishResult, number>> = {};
  for (const { outcome } of results) {
    counts[outcome.result] = (counts[outcome.result] ?? 0) + 1;
  }

  const publishedIds = results
    .filter(({ outcome }) => outcome.result === "published")
    .map(({ row }) => row.id);

  if (publishedIds.length > 0) {
    try {
      await markPublished(publishedIds);
    } catch (error) {
      // Confirmed but not marked: republished after the lease expires (duplicate).
      logger.error(
        { err: error, count: publishedIds.length },
        "Could not mark confirmed outbox messages as published",
      );
    }
  }

  for (const { row, outcome } of results) {
    if (outcome.result === "published") continue;
    try {
      await scheduleRetry(row, outcome);
    } catch (error) {
      // PostgreSQL unavailable too: the lease expires and the row is claimed again.
      logger.error({ err: error, outboxId: row.id }, "Could not reschedule outbox message");
    }
  }

  logger.info({ claimed: rows.length, ...counts }, "Outbox relay batch done");
  return rows.length;
}
