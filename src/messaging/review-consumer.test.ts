import { EventEmitter } from "node:events";
import type { ChannelModel, ConsumeMessage, Options } from "amqplib";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewDelivery } from "../workers/review-handler.ts";
import { ReviewConsumer } from "./review-consumer.ts";
import { REVIEW_RETRY_TIERS, REVIEWS_QUEUE } from "./topology.ts";

type ConfirmCallback = (err: unknown) => void;
type OnMessage = (message: ConsumeMessage | null) => void;

class FakeChannel extends EventEmitter {
  onMessage: OnMessage | null = null;
  readonly acked: ConsumeMessage[] = [];
  readonly nacked: { message: ConsumeMessage; requeue: boolean }[] = [];
  readonly published: { exchange: string; routingKey: string; options: Options.Publish }[] = [];
  /** How the "broker" answers a publish. */
  publishBehavior: "ack" | "nack" | "return" | "never" | "throw" = "ack";
  closed = false;

  assertExchange = vi.fn(async () => ({}));
  assertQueue = vi.fn(async () => ({}));
  bindQueue = vi.fn(async () => ({}));
  prefetch = vi.fn(async () => ({}));
  consume = vi.fn(async (_queue: string, onMessage: OnMessage) => {
    this.onMessage = onMessage;
    return { consumerTag: "ctag" };
  });
  close = vi.fn(async () => {
    this.closed = true;
    this.emit("close");
  });

  ack(message: ConsumeMessage): void {
    if (this.closed) throw new Error("Channel closed");
    this.acked.push(message);
  }

  nack(message: ConsumeMessage, _allUpTo: boolean, requeue: boolean): void {
    if (this.closed) throw new Error("Channel closed");
    this.nacked.push({ message, requeue });
  }

  publish(
    exchange: string,
    routingKey: string,
    _content: Buffer,
    options: Options.Publish,
    callback: ConfirmCallback,
  ): boolean {
    if (this.publishBehavior === "throw") throw new Error("Channel closed");
    this.published.push({ exchange, routingKey, options });
    const behavior = this.publishBehavior;
    setImmediate(() => {
      if (behavior === "nack") callback(new Error("message nacked"));
      else if (behavior === "return") {
        this.emit("return", { properties: { headers: options.headers } });
        callback(null);
      } else if (behavior === "ack") callback(null);
    });
    return true;
  }

  deliver(messageId = "msg-1"): ConsumeMessage {
    const message = {
      content: Buffer.from("{}"),
      fields: { deliveryTag: 1, redelivered: false },
      properties: { messageId, type: "review.requested", headers: {} },
    } as unknown as ConsumeMessage;
    this.onMessage?.(message);
    return message;
  }
}

class FakeModel extends EventEmitter {
  readonly channels: FakeChannel[] = [];
  createConfirmChannel = vi.fn(async () => {
    const channel = new FakeChannel();
    this.channels.push(channel);
    return channel;
  });

  asModel(): ChannelModel {
    return this as unknown as ChannelModel;
  }
}

const logger = pino({ level: "silent" });
const REOPEN_MS = 100;
const REQUEUE_MS = 500;
const tier = REVIEW_RETRY_TIERS[0];

/** Handler that hands each delivery to the test. */
function capturingHandler() {
  const deliveries: ReviewDelivery[] = [];
  const handler = vi.fn(async (delivery: ReviewDelivery) => {
    deliveries.push(delivery);
  });
  return { handler, deliveries };
}

async function openConsumer(handler = capturingHandler().handler) {
  const consumer = new ReviewConsumer(handler, logger, {
    prefetch: 4,
    reopenDelayMs: REOPEN_MS,
    retryPublishTimeoutMs: 1_000,
    requeueDelayMs: REQUEUE_MS,
  });
  const model = new FakeModel();
  await consumer.open(model.asModel());
  const channel = model.channels[0];
  if (channel === undefined) throw new Error("no channel");
  return { consumer, model, channel };
}

describe("ReviewConsumer", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => vi.useRealTimers());

  it("declares the topology, sets prefetch, then consumes with manual ack", async () => {
    const { channel } = await openConsumer();

    expect(channel.assertQueue).toHaveBeenCalledWith(REVIEWS_QUEUE, expect.anything());
    expect(channel.prefetch).toHaveBeenCalledWith(4);
    expect(channel.consume).toHaveBeenCalledWith(REVIEWS_QUEUE, expect.any(Function), {
      noAck: false,
    });
    expect(channel.prefetch.mock.invocationCallOrder[0]).toBeLessThan(
      channel.consume.mock.invocationCallOrder[0] ?? 0,
    );
    expect(channel.listenerCount("error")).toBe(1);
  });

  it("rejects (so recovery retries) when the topology fails", async () => {
    const consumer = new ReviewConsumer(capturingHandler().handler, logger, { prefetch: 4 });
    const model = new FakeModel();
    model.createConfirmChannel.mockImplementationOnce(async () => {
      const channel = new FakeChannel();
      channel.assertQueue.mockRejectedValueOnce(new Error("PRECONDITION_FAILED"));
      return channel;
    });

    await expect(consumer.open(model.asModel())).rejects.toThrow("PRECONDITION_FAILED");
  });

  it("settles each delivery once, on the channel it arrived on", async () => {
    const { handler, deliveries } = capturingHandler();
    const { channel } = await openConsumer(handler);

    const message = channel.deliver();
    await vi.waitFor(() => expect(deliveries).toHaveLength(1));
    const delivery = deliveries[0];

    delivery?.ack();
    delivery?.ack();
    delivery?.requeue();

    expect(channel.acked).toEqual([message]);
    expect(channel.nacked).toEqual([]);
  });

  it("maps deadLetter to nack(requeue=false) and requeue to nack(requeue=true)", async () => {
    const { handler, deliveries } = capturingHandler();
    const { channel } = await openConsumer(handler);

    channel.deliver("a");
    channel.deliver("b");
    await vi.waitFor(() => expect(deliveries).toHaveLength(2));
    deliveries[0]?.deadLetter();
    deliveries[1]?.requeue();

    expect(channel.nacked.map((n) => n.requeue)).toEqual([false, true]);
  });

  it("does not throw when settling on a channel that has closed meanwhile", async () => {
    const { handler, deliveries } = capturingHandler();
    const { channel } = await openConsumer(handler);
    channel.deliver();
    await vi.waitFor(() => expect(deliveries).toHaveLength(1));

    await channel.close();

    expect(() => deliveries[0]?.ack()).not.toThrow();
  });

  it("requeues a delivery whose handler throws, only after a pause", async () => {
    const handler = vi.fn(async () => {
      throw new Error("bug");
    });
    const { channel, consumer } = await openConsumer(handler);

    channel.deliver();

    // Explicit requeues aren't counted by the delivery-limit: no pause = hot loop.
    await vi.advanceTimersByTimeAsync(REQUEUE_MS - 1);
    expect(channel.nacked).toEqual([]);
    expect(consumer.inFlightCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(channel.nacked.map((n) => n.requeue)).toEqual([true]);
    expect(consumer.inFlightCount()).toBe(0);
  });

  describe("start (recovery setup shared with the outbox relay)", () => {
    function failingModel(fail: (channel: FakeChannel) => void) {
      const model = new FakeModel();
      model.createConfirmChannel.mockImplementationOnce(async () => {
        const channel = new FakeChannel();
        fail(channel);
        model.channels.push(channel);
        return channel;
      });
      const consumer = new ReviewConsumer(capturingHandler().handler, logger, {
        prefetch: 4,
        reopenDelayMs: REOPEN_MS,
      });
      return { model, consumer };
    }

    it("does not reject on a topology failure; closes the channel and retries on the same connection", async () => {
      const { model, consumer } = failingModel((channel) =>
        channel.assertQueue.mockRejectedValueOnce(new Error("PRECONDITION_FAILED")),
      );

      await expect(consumer.start(model.asModel())).resolves.toBeUndefined();
      expect(model.channels[0]?.close).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(REOPEN_MS);
      expect(model.channels).toHaveLength(2);
      expect(model.channels[1]?.consume).toHaveBeenCalledTimes(1);
    });

    it("retries once after a failed consume (half-opened channel closed, no second reopen)", async () => {
      const { model, consumer } = failingModel((channel) =>
        channel.consume.mockRejectedValueOnce(new Error("NOT_FOUND")),
      );

      await consumer.start(model.asModel());
      await vi.advanceTimersByTimeAsync(REOPEN_MS * 3);

      expect(model.channels).toHaveLength(2);
    });
  });

  describe("publishRetry", () => {
    async function retryWith(behavior: FakeChannel["publishBehavior"]) {
      const { handler, deliveries } = capturingHandler();
      const { channel } = await openConsumer(handler);
      channel.publishBehavior = behavior;
      channel.deliver();
      await vi.waitFor(() => expect(deliveries).toHaveLength(1));
      const result = deliveries[0]?.publishRetry(tier, 3);
      return { channel, result };
    }

    it("publishes a persistent, mandatory copy to the retry queue via the default exchange", async () => {
      const { channel, result } = await retryWith("ack");

      await expect(result).resolves.toBe(true);
      expect(channel.published).toHaveLength(1);
      const published = channel.published[0];
      expect(published?.exchange).toBe("");
      expect(published?.routingKey).toBe(tier.queue);
      expect(published?.options).toMatchObject({
        persistent: true,
        mandatory: true,
        messageId: "msg-1",
        type: "review.requested",
        headers: { "x-review-failed-attempt": 3, "x-retry-id": expect.any(String) },
      });
    });

    it.each(["nack", "return", "throw"] as const)("resolves false on %s", async (behavior) => {
      const { result } = await retryWith(behavior);

      await expect(result).resolves.toBe(false);
    });

    it("resolves false when no confirm arrives before the timeout", async () => {
      const { result } = await retryWith("never");

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(result).resolves.toBe(false);
    });

    it("ignores a basic.return that belongs to another publish", async () => {
      const { channel, result } = await retryWith("ack");
      channel.emit("return", { properties: { headers: { "x-retry-id": "someone-else" } } });

      await expect(result).resolves.toBe(true);
    });
  });

  it("reopens and consumes again after a channel-level close", async () => {
    const { model, channel } = await openConsumer();

    channel.emit("close");
    await vi.advanceTimersByTimeAsync(REOPEN_MS);

    expect(model.channels).toHaveLength(2);
    expect(model.channels[1]?.consume).toHaveBeenCalledTimes(1);
  });

  it("closes the channel when the broker cancels the consumer, which triggers the reopen", async () => {
    const { model, channel } = await openConsumer();

    channel.onMessage?.(null);
    await vi.waitFor(() => expect(channel.close).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(REOPEN_MS);

    expect(model.channels).toHaveLength(2);
  });

  it("does not reopen after close()", async () => {
    const { consumer, model, channel } = await openConsumer();

    await consumer.close();
    await vi.advanceTimersByTimeAsync(REOPEN_MS * 2);

    expect(channel.close).toHaveBeenCalled();
    expect(model.channels).toHaveLength(1);
  });

  it("skips the reopen when the connection has closed (recovery takes over)", async () => {
    const { model, channel } = await openConsumer();

    channel.emit("close");
    model.emit("close");
    await vi.advanceTimersByTimeAsync(REOPEN_MS);

    expect(model.channels).toHaveLength(1);
  });
});
