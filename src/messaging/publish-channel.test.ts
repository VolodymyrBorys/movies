import { EventEmitter } from "node:events";
import type { ChannelModel } from "amqplib";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublishChannel } from "./publish-channel.ts";
import { EVENTS_EXCHANGE } from "./topology.ts";

class FakeChannel extends EventEmitter {
  assertExchange = vi.fn(async () => ({ exchange: EVENTS_EXCHANGE }));
  close = vi.fn(async () => {
    this.emit("close");
  });
}

class FakeModel extends EventEmitter {
  readonly channels: FakeChannel[] = [];
  failNext = false;

  createConfirmChannel = vi.fn(async () => {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("Connection closed");
    }
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

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("PublishChannel", () => {
  it("opens a confirm channel and declares the durable topic exchange", async () => {
    const holder = new PublishChannel(logger, REOPEN_MS);
    const model = new FakeModel();

    await holder.open(model.asModel());

    expect(holder.current()).toBe(model.channels[0]);
    expect(model.channels[0]?.assertExchange).toHaveBeenCalledWith(EVENTS_EXCHANGE, "topic", {
      durable: true,
    });
    expect(model.channels[0]?.listenerCount("error")).toBe(1);
  });

  it("rejects (so recovery retries) and exposes no channel when the topology fails", async () => {
    const holder = new PublishChannel(logger, REOPEN_MS);
    const model = new FakeModel();
    model.createConfirmChannel.mockImplementationOnce(async () => {
      const channel = new FakeChannel();
      channel.assertExchange.mockRejectedValueOnce(new Error("PRECONDITION_FAILED"));
      return channel;
    });

    await expect(holder.open(model.asModel())).rejects.toThrow("PRECONDITION_FAILED");
    expect(holder.current()).toBeNull();
  });

  it("reopens on the same connection after a channel-level close", async () => {
    const holder = new PublishChannel(logger, REOPEN_MS);
    const model = new FakeModel();
    await holder.open(model.asModel());

    model.channels[0]?.emit("close");
    expect(holder.current()).toBeNull();

    await vi.advanceTimersByTimeAsync(REOPEN_MS);
    expect(holder.current()).toBe(model.channels[1]);
  });

  it("keeps retrying the reopen while the connection is alive", async () => {
    const holder = new PublishChannel(logger, REOPEN_MS);
    const model = new FakeModel();
    await holder.open(model.asModel());

    model.failNext = true;
    model.channels[0]?.emit("close");
    await vi.advanceTimersByTimeAsync(REOPEN_MS);
    expect(holder.current()).toBeNull();

    await vi.advanceTimersByTimeAsync(REOPEN_MS);
    expect(holder.current()).toBe(model.channels[1]);
  });

  it("leaves reopening to recovery when the connection closed", async () => {
    const holder = new PublishChannel(logger, REOPEN_MS);
    const model = new FakeModel();
    await holder.open(model.asModel());

    // amqplib order: channels are closed first, then the connection emits 'close'.
    model.channels[0]?.emit("close");
    model.emit("close");
    await vi.advanceTimersByTimeAsync(REOPEN_MS * 3);

    expect(model.createConfirmChannel).toHaveBeenCalledTimes(1);
    expect(holder.current()).toBeNull();

    const next = new FakeModel();
    await holder.open(next.asModel());
    expect(holder.current()).toBe(next.channels[0]);
  });

  it("reopens a channel-only close on the new connection right after recovery", async () => {
    const holder = new PublishChannel(logger, REOPEN_MS);
    const first = new FakeModel();
    const second = new FakeModel();
    await holder.open(first.asModel());

    // Connection lost (amqplib order), recovery reconnects before the old reopen timer fires.
    first.channels[0]?.emit("close");
    first.emit("close");
    await holder.open(second.asModel());

    // Channel-only error on the new connection within the old timer's window.
    second.channels[0]?.emit("close");
    expect(holder.current()).toBeNull();

    await vi.advanceTimersByTimeAsync(REOPEN_MS);
    expect(holder.current()).toBe(second.channels[1]);
  });

  it("exposes no channel while the connection is blocked", async () => {
    const holder = new PublishChannel(logger, REOPEN_MS);
    const model = new FakeModel();
    await holder.open(model.asModel());

    model.emit("blocked", "low on memory");
    expect(holder.current()).toBeNull();

    model.emit("unblocked");
    expect(holder.current()).toBe(model.channels[0]);
  });

  it("starts unblocked on a new connection", async () => {
    const holder = new PublishChannel(logger, REOPEN_MS);
    const first = new FakeModel();
    const second = new FakeModel();
    await holder.open(first.asModel());
    first.emit("blocked", "low on memory");

    await holder.open(second.asModel());
    first.emit("blocked", "stale event from the old connection");

    expect(holder.current()).toBe(second.channels[0]);
  });

  it("opens nothing after close() (startup racing shutdown)", async () => {
    const holder = new PublishChannel(logger, REOPEN_MS);
    const model = new FakeModel();

    await holder.close();
    await holder.open(model.asModel());

    expect(model.createConfirmChannel).not.toHaveBeenCalled();
    expect(holder.current()).toBeNull();
  });

  it("closes a channel whose open raced close()", async () => {
    const holder = new PublishChannel(logger, REOPEN_MS);
    const model = new FakeModel();
    model.createConfirmChannel.mockImplementationOnce(async () => {
      const channel = new FakeChannel();
      model.channels.push(channel);
      channel.assertExchange.mockImplementationOnce(async () => {
        await holder.close();
        return { exchange: EVENTS_EXCHANGE };
      });
      return channel;
    });

    await holder.open(model.asModel());

    expect(model.channels[0]?.close).toHaveBeenCalledOnce();
    expect(holder.current()).toBeNull();
  });

  it("ignores the close of a replaced channel", async () => {
    const holder = new PublishChannel(logger, REOPEN_MS);
    const first = new FakeModel();
    const second = new FakeModel();
    await holder.open(first.asModel());
    await holder.open(second.asModel());

    first.channels[0]?.emit("close");

    expect(holder.current()).toBe(second.channels[0]);
  });

  it("does not reopen after close()", async () => {
    const holder = new PublishChannel(logger, REOPEN_MS);
    const model = new FakeModel();
    await holder.open(model.asModel());

    await holder.close();
    await vi.advanceTimersByTimeAsync(REOPEN_MS * 3);

    expect(model.channels[0]?.close).toHaveBeenCalledOnce();
    expect(model.createConfirmChannel).toHaveBeenCalledTimes(1);
    expect(holder.current()).toBeNull();
  });
});
