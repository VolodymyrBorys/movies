import type { RecoveringChannelModel } from "amqplib";
import { rabbitMqConfig, RabbitMqNotConfiguredError } from "./config/rabbitmq.ts";
import { logger as rootLogger } from "./infrastructure/logger.ts";
import { PG } from "./infrastructure/postgres.ts";
import { connectRabbitMq } from "./infrastructure/rabbitmq.ts";
import { PublishChannel } from "./messaging/publish-channel.ts";
import { startOutboxRelay, stopOutboxRelay } from "./workers/outbox-relay-runner.ts";

// Worker process (P5): the only process that talks to RabbitMQ. The API writes to
// message_outbox; this process relays it (P5.3) and, from P5.4, consumes review jobs.
//
//   npm run worker      (= node --env-file-if-exists=.env src/worker.ts)
//
// LAB: simplified shutdown — stop the relay after its current batch, close channel,
// connection and PG. Consumer draining (stop consuming, finish in-flight, ack/nack) is P5.6.
// No /metrics endpoint yet (P5.5): relay outcomes are in the logs (`result` field).

const logger = rootLogger.child({ component: "worker" });

if (rabbitMqConfig === null) {
  throw new RabbitMqNotConfiguredError();
}
const { url } = rabbitMqConfig;

const publishChannel = new PublishChannel(logger.child({ component: "publish-channel" }));
let connection: RecoveringChannelModel | null = null;

let isShuttingDown = false;
let started = false;

async function start(): Promise<void> {
  await PG.start();
  if (isShuttingDown) return;

  // Rejects after the startup retry budget (~15 s) → exit 1 below.
  connection = await connectRabbitMq({
    url,
    connectionName: "movies-worker",
    logger,
    setup: (model) => publishChannel.open(model),
  });
  if (isShuttingDown) return;

  startOutboxRelay(() => publishChannel.current());
  started = true;
  logger.info("Worker started");
}

async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  if (!started) {
    // Signal or failure during startup (PG or broker connect, up to ~15 s): nothing is in
    // flight yet, and a pending connect attempt would keep the process alive after a
    // graceful close. Release PG (may not have started) and exit right away.
    logger.warn({ reason }, "Worker stopping during startup");
    await PG.closeConnection().catch(() => undefined);
    process.exit(exitCode);
  }

  logger.info({ reason }, "Worker shutting down");

  // Relay batch deadline is 10 s; leave time for closing connections.
  const forceExitTimer = setTimeout(() => {
    logger.fatal("Worker shutdown timed out");
    process.exit(1);
  }, 15_000);
  forceExitTimer.unref();

  try {
    await stopOutboxRelay();
    await publishChannel.close();
    if (connection !== null) await connection.close();
    await PG.closeConnection();
    process.exitCode = exitCode;
  } catch (error) {
    logger.fatal({ err: error }, "Error during worker shutdown");
    process.exitCode = 1;
  } finally {
    clearTimeout(forceExitTimer);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
process.on("SIGINT", () => void shutdown("SIGINT", 0));

process.on("uncaughtExceptionMonitor", (error, origin) => {
  logger.fatal({ err: error, origin }, "Uncaught exception; worker will terminate");
});

process.on("unhandledRejection", (reason) => {
  logger.fatal(
    { reason: reason instanceof Error ? reason : String(reason) },
    "Unhandled promise rejection",
  );
  void shutdown("unhandledRejection", 1);
});

try {
  await start();
} catch (error) {
  logger.fatal({ err: error }, "Worker failed to start");
  await shutdown("startup failed", 1);
}
