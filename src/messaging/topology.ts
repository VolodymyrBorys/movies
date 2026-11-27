import type { Channel } from "amqplib";
import { REVIEW_REQUESTED_ROUTING_KEY } from "../modules/reviews/review-messages.ts";

// Broker topology owned by this service (P5).
//
//   movies.events (topic) ──review.requested──▶ reviews.generate (quorum)
//                                                 │ nack(requeue=false) / delivery-limit
//                                                 ▼
//                                   movies.dlx (direct) ──▶ reviews.generate.dlq (quorum)
//
//   consumer ──default exchange──▶ reviews.generate.retry.<delay> (quorum, x-message-ttl)
//                                     │ TTL expired → dead-lettered
//                                     └──▶ default exchange, routing key reviews.generate
//
// Declarations are idempotent; re-declaring a queue with DIFFERENT arguments fails with
// PRECONDITION_FAILED (406) and, inside the recovery `setup`, turns into an endless reconnect
// loop (src/infrastructure/rabbitmq.ts). Changing an argument below therefore needs the queue
// deleted first (or a new queue name) — there is no in-place migration for queue arguments.

/** Topic exchange for all domain events of the service; routing keys like `review.requested`. */
export const EVENTS_EXCHANGE = "movies.events";

/** Dead-letter exchange: messages the consumer gave up on. Routing key = source queue. */
export const DEAD_LETTER_EXCHANGE = "movies.dlx";

export const REVIEWS_QUEUE = "reviews.generate";
export const REVIEWS_DEAD_LETTER_QUEUE = "reviews.generate.dlq";

/**
 * Poison-message safety net: a message delivered this many times without an ack (e.g. the
 * consumer crashes before acking) is dead-lettered by the broker. DB `attempts` can't cover
 * that case — a crashing process never writes them.
 *
 * LAB: simplified — a message dead-lettered this way leaves its job `queued`/`running`
 * forever (nothing consumes the DLQ), and the partial unique index blocks a new job for the
 * same movie version. Detected by the DLQ > 0 alert (P5.5), fixed manually (SQL in
 * docs/progress/messaging.md → P5.4 → Failure modes). Production would also run a
 * reconciliation that re-enqueues stale non-terminal jobs (proposed as P5.4b).
 */
export const REVIEWS_DELIVERY_LIMIT = 10;

/**
 * Retry delays, one queue per delay: RabbitMQ expires messages only at the HEAD of a queue,
 * so one queue with per-message TTLs would let a 5 min message block a 10 s one behind it.
 * Index = failed attempt number - 1 (the last tier repeats).
 */
export const REVIEW_RETRY_TIERS = Object.freeze([
  { queue: "reviews.generate.retry.10s", delayMs: 10_000 },
  { queue: "reviews.generate.retry.30s", delayMs: 30_000 },
  { queue: "reviews.generate.retry.2m", delayMs: 120_000 },
  { queue: "reviews.generate.retry.5m", delayMs: 300_000 },
] as const);

export type ReviewRetryTier = (typeof REVIEW_RETRY_TIERS)[number];

// Quorum queues dead-letter at-most-once by default: a message being moved to the DLX can be
// lost if the broker fails mid-way. at-least-once needs `x-overflow: reject-publish`
// (otherwise the broker silently falls back to at-most-once). With no max-length set, the
// overflow setting itself never triggers.
const AT_LEAST_ONCE_DEAD_LETTERING = Object.freeze({
  "x-dead-letter-strategy": "at-least-once",
  "x-overflow": "reject-publish",
});

export type TopologyChannel = Pick<Channel, "assertExchange" | "assertQueue" | "bindQueue">;

/** Publisher side (outbox relay): only the exchange. */
export async function assertPublisherTopology(
  channel: Pick<Channel, "assertExchange">,
): Promise<void> {
  await channel.assertExchange(EVENTS_EXCHANGE, "topic", { durable: true });
}

/** Consumer side (review worker): queues, bindings, retry queues, DLX and DLQ. */
export async function assertReviewConsumerTopology(channel: TopologyChannel): Promise<void> {
  await assertPublisherTopology(channel);
  await channel.assertExchange(DEAD_LETTER_EXCHANGE, "direct", { durable: true });

  await channel.assertQueue(REVIEWS_DEAD_LETTER_QUEUE, {
    durable: true,
    arguments: { "x-queue-type": "quorum" },
  });
  await channel.bindQueue(REVIEWS_DEAD_LETTER_QUEUE, DEAD_LETTER_EXCHANGE, REVIEWS_QUEUE);

  await channel.assertQueue(REVIEWS_QUEUE, {
    durable: true,
    arguments: {
      "x-queue-type": "quorum",
      "x-delivery-limit": REVIEWS_DELIVERY_LIMIT,
      "x-dead-letter-exchange": DEAD_LETTER_EXCHANGE,
      "x-dead-letter-routing-key": REVIEWS_QUEUE,
      ...AT_LEAST_ONCE_DEAD_LETTERING,
    },
  });
  await channel.bindQueue(REVIEWS_QUEUE, EVENTS_EXCHANGE, REVIEW_REQUESTED_ROUTING_KEY);

  for (const tier of REVIEW_RETRY_TIERS) {
    // No consumer: messages sit until the TTL, then go back to the work queue through the
    // default exchange ("" routes by queue name).
    await channel.assertQueue(tier.queue, {
      durable: true,
      arguments: {
        "x-queue-type": "quorum",
        "x-message-ttl": tier.delayMs,
        "x-dead-letter-exchange": "",
        "x-dead-letter-routing-key": REVIEWS_QUEUE,
        ...AT_LEAST_ONCE_DEAD_LETTERING,
      },
    });
  }
}

/** Retry queue for the given failed attempt (1-based); the last tier repeats. */
export function retryTierFor(failedAttempt: number): ReviewRetryTier {
  const index = Math.min(Math.max(failedAttempt, 1), REVIEW_RETRY_TIERS.length) - 1;
  // Index is clamped to the array bounds above.
  return REVIEW_RETRY_TIERS[index] as ReviewRetryTier;
}
