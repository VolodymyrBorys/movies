import { randomUUID } from "node:crypto";
import type { RecoveringChannelModel } from "amqplib";
import { config } from "./config/env.ts";
import { rabbitMqConfig, RabbitMqNotConfiguredError } from "./config/rabbitmq.ts";
import { logger as rootLogger } from "./infrastructure/logger.ts";
import { metricsRegistry } from "./infrastructure/metrics.ts";
import { startMetricsServer, type MetricsServer } from "./infrastructure/metrics-server.ts";
import { PG } from "./infrastructure/postgres.ts";
import { connectRabbitMq } from "./infrastructure/rabbitmq.ts";
import { loadReviewGeneratorConfig } from "./config/review-generator.ts";
import { PublishChannel } from "./messaging/publish-channel.ts";
import { ReviewConsumer } from "./messaging/review-consumer.ts";
import { createReviewGenerator } from "./modules/reviews/review-generator.ts";
import { reviewJobProcessingRepository } from "./modules/reviews/review-job-processing.repository.ts";
import { startOutboxRelay, stopOutboxRelay } from "./workers/outbox-relay-runner.ts";
import { handleReviewDelivery, REVIEW_CONSUMER_SETTINGS } from "./workers/review-handler.ts";

// Worker process (P5): the only process that talks to RabbitMQ. The API writes to
// message_outbox; this process relays it (P5.3) and consumes review jobs (P5.4).
//
//   npm run worker      (= node --env-file-if-exists=.env src/worker.ts)
//
// Graceful shutdown (P5.6): drain the review consumer (cancel, wait for in-flight up to
// drainTimeoutMs, then abort the generations: jobs released with the attempt refunded,
// messages requeued) and, in parallel, stop the relay after its current batch; then close
// channels, connection, PG and /metrics. SIGKILL / the force-exit timer skip all of this:
// leases expire and the next delivery takes the job over (one attempt spent).
// /metrics on WORKER_METRICS_PORT (P5.5). `npm run worker` sets SERVICE_NAME=movies-worker
// (logs and the metrics `service` label); started without it, the worker warns.

const logger = rootLogger.child({ component: "worker" });

if (config.serviceName !== "movies-worker") {
  logger.warn(
    { serviceName: config.serviceName },
    "SERVICE_NAME is not movies-worker: logs and metrics are labelled as another service",
  );
}
// Applied at scrape time: also covers metrics registered by modules imported above.
metricsRegistry.setDefaultLabels({ service: config.serviceName });

if (rabbitMqConfig === null) {
  throw new RabbitMqNotConfiguredError();
}
const { url } = rabbitMqConfig;

const reviewGeneratorConfig = loadReviewGeneratorConfig(process.env);
const reviewGenerator = createReviewGenerator(reviewGeneratorConfig);
const workerId = `review-consumer-${randomUUID()}`;

const publishChannel = new PublishChannel(logger.child({ component: "publish-channel" }));
// Root-logger child: a nested child() would write `component` twice.
const reviewLogger = rootLogger.child({ component: "review-consumer" });
// Aborted when the shutdown drain times out: in-flight generations stop, jobs are released.
const shutdownController = new AbortController();
const reviewConsumer = new ReviewConsumer(
  (delivery) =>
    handleReviewDelivery(delivery, {
      jobs: reviewJobProcessingRepository,
      generator: reviewGenerator,
      workerId,
      logger: reviewLogger,
      shutdownSignal: shutdownController.signal,
    }),
  reviewLogger,
  {
    prefetch: REVIEW_CONSUMER_SETTINGS.prefetch,
    requeueDelayMs: REVIEW_CONSUMER_SETTINGS.requeueDelayMs,
  },
);
let connection: RecoveringChannelModel | null = null;
let metricsServer: MetricsServer | null = null;

let isShuttingDown = false;
let started = false;

async function start(): Promise<void> {
  // First: `up{job="movies-worker"}` should mean "the process runs", also while it is still
  // waiting for PostgreSQL or the broker. A taken port fails the startup (exit 1).
  metricsServer = await startMetricsServer(
    metricsRegistry,
    config.worker.metricsPort,
    logger.child({ component: "metrics-server" }),
  );
  if (isShuttingDown) return;

  await PG.start();
  if (isShuttingDown) return;

  // Rejects after the startup retry budget (~15 s) → exit 1 below.
  connection = await connectRabbitMq({
    url,
    connectionName: "movies-worker",
    logger,
    // Re-run after every reconnect: channels and consumers die with the connection.
    // Only the publish channel can fail the setup: a consumer topology error (e.g. 406) is
    // retried by the consumer itself, so it doesn't take the outbox relay down with it.
    setup: async (model) => {
      await publishChannel.open(model);
      await reviewConsumer.start(model);
    },
  });
  if (isShuttingDown) return;

  startOutboxRelay(() => publishChannel.current());
  started = true;
  logger.info({ reviewGenerator: reviewGeneratorConfig.kind, workerId }, "Worker started");
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
    await metricsServer?.close().catch(() => undefined);
    process.exit(exitCode);
  }

  logger.info({ reason }, "Worker shutting down");

  // Drain (25 s) + abort grace (5 s) run in parallel with the relay batch (deadline 10 s);
  // leave 10 s for closing connections.
  const forceExitMs =
    REVIEW_CONSUMER_SETTINGS.drainTimeoutMs + REVIEW_CONSUMER_SETTINGS.drainAbortGraceMs + 10_000;
  const forceExitTimer = setTimeout(() => {
    logger.fatal({ forceExitMs }, "Worker shutdown timed out");
    process.exit(1);
  }, forceExitMs);
  forceExitTimer.unref();

  try {
    // Independent: the consumer settles on its own channel, the relay on the publish channel.
    await Promise.all([
      reviewConsumer.drain({
        timeoutMs: REVIEW_CONSUMER_SETTINGS.drainTimeoutMs,
        abortGraceMs: REVIEW_CONSUMER_SETTINGS.drainAbortGraceMs,
        abortInFlight: () => shutdownController.abort(new Error("worker shutting down")),
      }),
      stopOutboxRelay(),
    ]);
    await publishChannel.close();
    if (connection !== null) await connection.close();
    await PG.closeConnection();
    // Last: scrapes keep working while the worker drains.
    if (metricsServer !== null) await metricsServer.close();
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
