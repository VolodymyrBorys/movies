import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import type { connect, RecoveringChannelModel } from "amqplib";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
// No env/logger mocks needed: the module must not import env.ts (PG_*) at all.
import { connectRabbitMq, RABBITMQ_RECOVERY } from "./rabbitmq.ts";

const URL_WITH_PASSWORD = "amqp://app:top-secret@localhost:5672";

function captureLogger(): { logger: pino.Logger; lines: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  return { logger: pino({ level: "debug" }, stream), lines: () => chunks.join("") };
}

// Minimal stand-in for a recovering connection: an EventEmitter with waitForConnect().
function fakeConnection(firstConnect: Promise<void>): RecoveringChannelModel {
  const emitter = new EventEmitter() as unknown as RecoveringChannelModel;
  const model = emitter as unknown as { waitForConnect: () => Promise<unknown> };
  model.waitForConnect = () => firstConnect.then(() => emitter);
  return emitter;
}

function fakeConnect(connection: RecoveringChannelModel) {
  return vi.fn(async () => connection) as unknown as typeof connect & ReturnType<typeof vi.fn>;
}

describe("connectRabbitMq", () => {
  it("opts into recovery with bounded startup retries and unbounded steady-state retries", async () => {
    const connection = fakeConnection(Promise.resolve());
    const connectFn = fakeConnect(connection);
    const setup = vi.fn(async () => undefined);

    const result = await connectRabbitMq({
      url: URL_WITH_PASSWORD,
      connectionName: "movies-worker",
      setup,
      logger: captureLogger().logger,
      connectFn,
    });

    expect(result).toBe(connection);
    expect(connectFn).toHaveBeenCalledWith(URL_WITH_PASSWORD, {
      clientProperties: { connection_name: "movies-worker" },
      recovery: { ...RABBITMQ_RECOVERY, waitForConnect: false, setup },
    });
    expect(RABBITMQ_RECOVERY.initialMaxRetries).toBe(5);
    expect(RABBITMQ_RECOVERY.maxRetries).toBe(Number.POSITIVE_INFINITY);
  });

  it("omits setup when none is given (exactOptionalPropertyTypes)", async () => {
    const connectFn = fakeConnect(fakeConnection(Promise.resolve()));

    await connectRabbitMq({
      url: URL_WITH_PASSWORD,
      connectionName: "x",
      logger: captureLogger().logger,
      connectFn,
    });

    const recovery = (connectFn.mock.calls[0] as unknown as [string, { recovery: object }])[1]
      .recovery;
    expect(recovery).not.toHaveProperty("setup");
  });

  it("has an error listener before the first connect, so an early socket error does not crash", async () => {
    let finishConnect!: () => void;
    const connection = fakeConnection(new Promise<void>((resolve) => (finishConnect = resolve)));
    const { logger, lines } = captureLogger();

    const pending = connectRabbitMq({
      url: URL_WITH_PASSWORD,
      connectionName: "x",
      logger,
      connectFn: fakeConnect(connection),
    });
    await vi.waitFor(() => expect(connection.listenerCount("error")).toBe(1));

    // EventEmitter throws on an 'error' event without listeners.
    expect(() => connection.emit("error", new Error("ECONNRESET"))).not.toThrow();
    connection.emit("reconnect-scheduled", { attempt: 1, delay: 512, error: new Error("x") });
    finishConnect();
    await pending;

    expect(lines()).toContain("RabbitMQ connection error");
    expect(lines()).toContain('"delayMs":512');
  });

  it("rejects when the initial retry budget is exhausted", async () => {
    const connection = fakeConnection(Promise.reject(new Error("ECONNREFUSED")));

    await expect(
      connectRabbitMq({
        url: URL_WITH_PASSWORD,
        connectionName: "x",
        logger: captureLogger().logger,
        connectFn: fakeConnect(connection),
      }),
    ).rejects.toThrow("ECONNREFUSED");
  });

  it("logs every lifecycle event without the URL (it carries the password)", async () => {
    const connection = fakeConnection(Promise.resolve());
    const { logger, lines } = captureLogger();

    await connectRabbitMq({
      url: URL_WITH_PASSWORD,
      connectionName: "movies-worker",
      logger,
      connectFn: fakeConnect(connection),
    });

    connection.emit("connect", {});
    connection.emit("disconnect", new Error("CONNECTION_FORCED"));
    connection.emit("connect-failed", new Error("ECONNREFUSED"));
    connection.emit("reconnect-failed", new Error("gave up"));
    connection.emit("blocked", "low on memory");
    connection.emit("unblocked");
    connection.emit("handler-error", new Error("listener bug"), "connect");

    const output = lines();
    for (const message of [
      "RabbitMQ connected",
      "RabbitMQ disconnected",
      "RabbitMQ connect attempt failed",
      "RabbitMQ recovery gave up",
      "RabbitMQ connection blocked",
      "RabbitMQ connection unblocked",
      "RabbitMQ event listener threw",
    ]) {
      expect(output).toContain(message);
    }
    expect(output).toContain('"connectionName":"movies-worker"');
    expect(output).not.toContain("top-secret");
    expect(output).not.toContain(URL_WITH_PASSWORD);
  });
});
