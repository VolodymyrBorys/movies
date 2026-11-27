import { describe, expect, it, vi } from "vitest";
import {
  assertReviewConsumerTopology,
  DEAD_LETTER_EXCHANGE,
  EVENTS_EXCHANGE,
  REVIEW_RETRY_TIERS,
  retryTierFor,
  REVIEWS_DEAD_LETTER_QUEUE,
  REVIEWS_DELIVERY_LIMIT,
  REVIEWS_QUEUE,
  type TopologyChannel,
} from "./topology.ts";

function fakeChannel() {
  const channel = {
    assertExchange: vi.fn(async () => ({ exchange: "" })),
    assertQueue: vi.fn(async () => ({ queue: "", messageCount: 0, consumerCount: 0 })),
    bindQueue: vi.fn(async () => ({})),
  };
  return { channel, asTopology: channel as unknown as TopologyChannel };
}

function queueArgs(
  channel: ReturnType<typeof fakeChannel>["channel"],
  queue: string,
): Record<string, unknown> | undefined {
  const call = channel.assertQueue.mock.calls.find((args: unknown[]) => args[0] === queue) as
    | [string, { durable: boolean; arguments: Record<string, unknown> }]
    | undefined;
  expect(call?.[1].durable).toBe(true);
  return call?.[1].arguments;
}

const AT_LEAST_ONCE = {
  "x-dead-letter-strategy": "at-least-once",
  "x-overflow": "reject-publish",
};

describe("assertReviewConsumerTopology", () => {
  it("declares the work queue: quorum, delivery limit, at-least-once DLX, bound to review.requested", async () => {
    const { channel, asTopology } = fakeChannel();

    await assertReviewConsumerTopology(asTopology);

    expect(channel.assertExchange).toHaveBeenCalledWith(EVENTS_EXCHANGE, "topic", { durable: true });
    expect(queueArgs(channel, REVIEWS_QUEUE)).toEqual({
      "x-queue-type": "quorum",
      "x-delivery-limit": REVIEWS_DELIVERY_LIMIT,
      "x-dead-letter-exchange": DEAD_LETTER_EXCHANGE,
      "x-dead-letter-routing-key": REVIEWS_QUEUE,
      ...AT_LEAST_ONCE,
    });
    expect(channel.bindQueue).toHaveBeenCalledWith(REVIEWS_QUEUE, EVENTS_EXCHANGE, "review.requested");
  });

  it("declares the DLX and a quorum DLQ bound by the work queue name", async () => {
    const { channel, asTopology } = fakeChannel();

    await assertReviewConsumerTopology(asTopology);

    expect(channel.assertExchange).toHaveBeenCalledWith(DEAD_LETTER_EXCHANGE, "direct", {
      durable: true,
    });
    expect(queueArgs(channel, REVIEWS_DEAD_LETTER_QUEUE)).toEqual({ "x-queue-type": "quorum" });
    expect(channel.bindQueue).toHaveBeenCalledWith(
      REVIEWS_DEAD_LETTER_QUEUE,
      DEAD_LETTER_EXCHANGE,
      REVIEWS_QUEUE,
    );
  });

  it("declares one TTL retry queue per tier that dead-letters back to the work queue", async () => {
    const { channel, asTopology } = fakeChannel();

    await assertReviewConsumerTopology(asTopology);

    for (const tier of REVIEW_RETRY_TIERS) {
      expect(queueArgs(channel, tier.queue)).toEqual({
        "x-queue-type": "quorum",
        "x-message-ttl": tier.delayMs,
        "x-dead-letter-exchange": "",
        "x-dead-letter-routing-key": REVIEWS_QUEUE,
        ...AT_LEAST_ONCE,
      });
    }
  });
});

describe("retryTierFor", () => {
  it.each([
    [0, 10_000],
    [1, 10_000],
    [2, 30_000],
    [3, 120_000],
    [4, 300_000],
    [9, 300_000],
  ])("failed attempt %i → %i ms", (attempt, delayMs) => {
    expect(retryTierFor(attempt).delayMs).toBe(delayMs);
  });
});
