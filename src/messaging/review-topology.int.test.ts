import { connect, type Channel, type ChannelModel, type GetMessage } from "amqplib";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { rabbitMqConfig } from "../config/rabbitmq.ts";
import { amqpVhost } from "../test/integration-env.ts";
import type { ReviewDelivery } from "../workers/review-handler.ts";
import { ReviewConsumer } from "./review-consumer.ts";
import {
  assertReviewConsumerTopology,
  DEAD_LETTER_EXCHANGE,
  EVENTS_EXCHANGE,
  REVIEW_RETRY_TIERS,
  REVIEWS_DEAD_LETTER_QUEUE,
  REVIEWS_DELIVERY_LIMIT,
  REVIEWS_QUEUE,
} from "./topology.ts";

// Integration: review topology (P5.4) on a REAL broker, in the disposable vhost movies_test
// (src/test/integration-env.ts). Proves what unit tests can't: that RabbitMQ accepts these
// queue arguments, routes review.requested to the work queue, dead-letters rejected and
// over-delivered messages to the DLQ, and returns expired retry messages to the work queue.

const ALL_QUEUES = [
  REVIEWS_QUEUE,
  REVIEWS_DEAD_LETTER_QUEUE,
  ...REVIEW_RETRY_TIERS.map((tier) => tier.queue),
];

let model: ChannelModel;
let channel: Channel;

function rabbitUrl(): string {
  if (rabbitMqConfig === null) {
    throw new Error("RABBITMQ_URL (or TEST_RABBITMQ_URL) must be set for broker integration tests");
  }
  // Re-checked here, right before deleting anything.
  const vhost = amqpVhost(rabbitMqConfig.url);
  if (!vhost.endsWith("_test")) throw new Error(`Refusing to touch vhost "${vhost}"`);
  return rabbitMqConfig.url;
}

async function getOne(queue: string): Promise<GetMessage | false> {
  return channel.get(queue, { noAck: false });
}

/** Polls basic.get until a message arrives; false after the timeout. */
async function tryWaitForMessage(queue: string, timeoutMs: number): Promise<GetMessage | false> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = await getOne(queue);
    if (message !== false) return message;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function waitForMessage(queue: string, timeoutMs: number): Promise<GetMessage> {
  const message = await tryWaitForMessage(queue, timeoutMs);
  if (message === false) throw new Error(`no message in ${queue} within ${timeoutMs} ms`);
  return message;
}

function publishReviewRequested(body: object): void {
  channel.publish(EVENTS_EXCHANGE, "review.requested", Buffer.from(JSON.stringify(body)), {
    persistent: true,
    messageId: "msg-int",
  });
}

function firstDeath(message: GetMessage): Record<string, unknown> | undefined {
  const deaths: unknown = message.properties.headers?.["x-death"];
  return Array.isArray(deaths) ? (deaths[0] as Record<string, unknown>) : undefined;
}

beforeAll(async () => {
  model = await connect(rabbitUrl());
  channel = await model.createChannel();
  // Fresh queues: a declaration with changed arguments would fail with 406 otherwise.
  for (const queue of ALL_QUEUES) await channel.deleteQueue(queue);
  await channel.deleteExchange(DEAD_LETTER_EXCHANGE);
  await channel.deleteExchange(EVENTS_EXCHANGE);
  await assertReviewConsumerTopology(channel);
});

afterAll(async () => {
  await model?.close();
});

beforeEach(async () => {
  for (const queue of ALL_QUEUES) await channel.purgeQueue(queue);
});

describe("review topology on a real broker", () => {
  it("is idempotent: re-declaring with the same arguments succeeds", async () => {
    await expect(assertReviewConsumerTopology(channel)).resolves.toBeUndefined();
  });

  it("routes review.requested from movies.events to the work queue", async () => {
    publishReviewRequested({ n: 1 });

    const message = await waitForMessage(REVIEWS_QUEUE, 2_000);
    expect(message.properties.messageId).toBe("msg-int");
    channel.ack(message);
  });

  it("nack(requeue=false) dead-letters to the DLQ with x-death reason 'rejected'", async () => {
    publishReviewRequested({ n: 2 });
    const message = await waitForMessage(REVIEWS_QUEUE, 2_000);

    channel.nack(message, false, false);

    const dead = await waitForMessage(REVIEWS_DEAD_LETTER_QUEUE, 2_000);
    expect(firstDeath(dead)).toMatchObject({ reason: "rejected", queue: REVIEWS_QUEUE });
    channel.ack(dead);
  });

  it("a message whose consumer keeps crashing before ack is dead-lettered (poison message)", async () => {
    publishReviewRequested({ n: 3 });

    // Crash emulation: take the message unacked on a fresh channel, then close the channel —
    // the broker returns it as a failed delivery. (Observed 2026-11-25 on the local 4.x
    // broker: 13 × nack(requeue=true) did NOT count towards the limit and set no
    // x-delivery-count header — an explicit requeue is not a failed delivery.)
    const headersSeen: unknown[] = [];
    for (let i = 0; i < REVIEWS_DELIVERY_LIMIT + 3; i++) {
      const crashing = await model.createChannel();
      const deadline = Date.now() + 1_000;
      let message: GetMessage | false = false;
      while (message === false && Date.now() < deadline) {
        message = await crashing.get(REVIEWS_QUEUE, { noAck: false });
        if (message === false) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (message !== false) {
        const headers = message.properties.headers ?? {};
        headersSeen.push({
          deliveryCount: headers["x-delivery-count"] ?? null,
          acquiredCount: headers["x-acquired-count"] ?? null,
        });
      }
      await crashing.close();
      if (message === false) break;
    }

    const dead = await tryWaitForMessage(REVIEWS_DEAD_LETTER_QUEUE, 2_000);
    if (dead === false) {
      throw new Error(
        `not dead-lettered after ${headersSeen.length} crashed deliveries; headers per delivery: ` +
          JSON.stringify(headersSeen),
      );
    }
    expect(firstDeath(dead)).toMatchObject({ reason: "delivery_limit", queue: REVIEWS_QUEUE });
    expect(headersSeen.length).toBeGreaterThanOrEqual(REVIEWS_DELIVERY_LIMIT);
    channel.ack(dead);
  });

  it(
    "a message in a retry queue goes back to the work queue after the TTL",
    async () => {
      const tier = REVIEW_RETRY_TIERS[0];
      const sentAt = Date.now();
      channel.sendToQueue(tier.queue, Buffer.from("{}"), { persistent: true, messageId: "retry" });

      const message = await waitForMessage(REVIEWS_QUEUE, tier.delayMs + 5_000);

      expect(Date.now() - sentAt).toBeGreaterThanOrEqual(tier.delayMs - 500);
      expect(message.properties.messageId).toBe("retry");
      expect(firstDeath(message)).toMatchObject({ reason: "expired", queue: tier.queue });
      channel.ack(message);
    },
    REVIEW_RETRY_TIERS[0].delayMs + 10_000,
  );

  it("ReviewConsumer receives the delivery and publishRetry is confirmed by the broker", async () => {
    const deliveries: ReviewDelivery[] = [];
    const consumer = new ReviewConsumer(
      async (delivery) => {
        deliveries.push(delivery);
      },
      pino({ level: "silent" }),
      { prefetch: 4 },
    );
    const consumerModel = await connect(rabbitUrl());

    try {
      await consumer.open(consumerModel);
      publishReviewRequested({ n: 4 });

      await expect.poll(() => deliveries.length, { timeout: 2_000 }).toBe(1);
      const delivery = deliveries[0] as ReviewDelivery;

      const tier = REVIEW_RETRY_TIERS[3];
      await expect(delivery.publishRetry(tier, 4)).resolves.toBe(true);
      delivery.ack();

      const copy = await waitForMessage(tier.queue, 2_000);
      expect(copy.properties.messageId).toBe("msg-int");
      expect(copy.properties.headers?.["x-review-failed-attempt"]).toBe(4);
      channel.ack(copy);
    } finally {
      await consumer.close();
      await consumerModel.close();
    }
  });
});
