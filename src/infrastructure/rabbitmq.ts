import { connect, type ChannelModel, type RecoveringChannelModel } from "amqplib";
import type { Logger } from "pino";

// RabbitMQ connection for the worker process (P5). Reconnect is amqplib's built-in
// recovery (2.x): exponential backoff with jitter, `setup` re-run after every (re)connect.
//
// What recovery does NOT do: channels, consumers and unconfirmed publishes die with the old
// connection. Everything stateful must be (re)created inside `setup`, and the broker
// redelivers unacked messages to the new consumer — handlers must be idempotent.
//
// A `setup` that fails (e.g. a queue declared with different arguments → PRECONDITION_FAILED)
// counts as a failed connect and is retried forever once connected: a permanent topology
// error shows up as an endless reconnect loop in the logs, not as a crash.

// Startup: 5 retries ≈ 0.5 + 1 + 2 + 4 + 8 s (± jitter) → a misconfigured or unreachable
// broker fails the process start in ~15 s. Once connected: retry forever, capped at 30 s.
export const RABBITMQ_RECOVERY = Object.freeze({
  initialDelay: 500,
  maxDelay: 30_000,
  factor: 2,
  jitter: 0.2,
  initialMaxRetries: 5,
  maxRetries: Number.POSITIVE_INFINITY,
});

export type RabbitMqSetup = (model: ChannelModel) => Promise<void>;

export interface RabbitMqConnectOptions {
  /** May contain credentials: never logged. */
  url: string;
  /** Shown in the management UI (Connections → client properties). */
  connectionName: string;
  /** (Re)creates channels, topology and consumers after every successful connect. */
  setup?: RabbitMqSetup;
  /**
   * Required, not defaulted to the root logger: that one imports env.ts, which requires
   * PG_* — a broker-only script (scripts/rabbitmq-ping.ts) must not need PostgreSQL config.
   */
  logger: Logger;
  /** Test seam; defaults to amqplib's `connect`. */
  connectFn?: typeof connect;
}

/**
 * Opens a recovering connection and resolves after the first successful connect (including
 * `setup`). Rejects when the initial retry budget is exhausted. Listeners are attached
 * before the first attempt, so failed attempts are logged too.
 */
export async function connectRabbitMq(
  options: RabbitMqConnectOptions,
): Promise<RecoveringChannelModel> {
  const log = options.logger.child({
    component: "rabbitmq",
    connectionName: options.connectionName,
  });
  const connectFn = options.connectFn ?? connect;

  const connection = await connectFn(options.url, {
    clientProperties: { connection_name: options.connectionName },
    recovery: {
      ...RABBITMQ_RECOVERY,
      waitForConnect: false,
      ...(options.setup ? { setup: options.setup } : {}),
    },
  });

  attachConnectionLogging(connection, log);

  await connection.waitForConnect();
  return connection;
}

// An `error` listener is mandatory: without one, a socket error is an uncaught exception
// and the process exits even though recovery would have reconnected (amqplib README).
export function attachConnectionLogging(
  connection: RecoveringChannelModel,
  log: Logger,
): void {
  connection.on("connect", () => log.info("RabbitMQ connected"));
  connection.on("error", (err) => log.warn({ err }, "RabbitMQ connection error"));
  connection.on("disconnect", (err) => log.warn({ err }, "RabbitMQ disconnected"));
  connection.on("connect-failed", (err) =>
    log.warn({ err }, "RabbitMQ connect attempt failed"),
  );
  connection.on("reconnect-scheduled", ({ attempt, delay }) =>
    log.info({ attempt, delayMs: delay }, "RabbitMQ reconnect scheduled"),
  );
  connection.on("reconnect-failed", (err) =>
    log.error({ err }, "RabbitMQ recovery gave up"),
  );
  // Broker memory/disk alarm: publishes block until it clears (consumers keep working).
  connection.on("blocked", (reason) => log.warn({ reason }, "RabbitMQ connection blocked"));
  connection.on("unblocked", () => log.info("RabbitMQ connection unblocked"));
  connection.on("handler-error", (err, event) =>
    log.error({ err, event }, "RabbitMQ event listener threw"),
  );
}
