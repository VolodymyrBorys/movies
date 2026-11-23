import type { Channel } from "amqplib";

// Broker topology owned by this service (P5). P5.3 declares only what the publisher needs:
// the exchange. Queues, bindings, retry queues and the DLX come with the consumer (P5.4).

/** Topic exchange for all domain events of the service; routing keys like `review.requested`. */
export const EVENTS_EXCHANGE = "movies.events";

/**
 * Idempotent: re-declaring with the same arguments is a no-op. Declaring with different
 * arguments closes the channel with PRECONDITION_FAILED (406) — see src/infrastructure/rabbitmq.ts.
 */
export async function assertPublisherTopology(
  channel: Pick<Channel, "assertExchange">,
): Promise<void> {
  await channel.assertExchange(EVENTS_EXCHANGE, "topic", { durable: true });
}
