import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { config } from "./config/env.ts";
import { logger } from "./infrastructure/logger.ts";
import { markShuttingDown } from "./infrastructure/health.ts";
import { abortInFlightRequests } from "./infrastructure/shutdown-signal.ts";
import { PG } from "./infrastructure/postgres.ts";
import { REDIS } from "./infrastructure/redis.ts";
import {
  startCacheInvalidationWorker,
  stopCacheInvalidationWorker,
} from "./workers/cache-invalidation-runner.ts";
// import { logger } from "./logging/logger.ts";
// import { pool } from "./infra/db/postgres.ts";
// import { cpuPool } from "./services/cpu-pool.ts";

// `.env` is loaded by `node --env-file-if-exists=.env` (npm run dev), before any import
// runs; src/config/env.ts validates it. Running `node src/server.ts` directly without
// --env-file no longer reads .env.
const { app } = await import("./app.ts");
const server = createServer(app);

function listen(): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };

    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.server.port);
  });
}

async function start(): Promise<void> {
  // Якщо будь-який критичний сервіс не стартував,
  // застосунок не починає приймати HTTP-запити.
  await Promise.all([PG.start(), REDIS.start()]);
  startCacheInvalidationWorker();
  await listen();
  logger.info(
    { port: config.server.port, environment: config.nodeEnv },
    "Server started",
  );
}

let isShuttingDown = false;

async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.fatal({ reason }, "Server shutting down");

  const forceExitTimer = setTimeout(() => {
    logger.fatal("Graceful shutdown timed out");
    process.exit(1);
  }, 15_000);

  forceExitTimer.unref();

  try {
    // 0. /readyz → 503, then give the load balancer / Kubernetes endpoints time to stop
    //    routing new requests here while the server still accepts them.
    //    The delay counts toward the 15 s force-exit timer (env.ts caps it at 10 s).
    markShuttingDown();

    if (config.server.shutdownDelayMs > 0) {
      logger.info(
        { delayMs: config.server.shutdownDelayMs },
        "Not ready; waiting before closing HTTP server",
      );
      await sleep(config.server.shutdownDelayMs);
    }

    // 1. Перестати приймати нові HTTP-з'єднання. Before that, abort slow in-flight work
    //    (RAG upstream calls) so close() doesn't wait for it up to the forced exit.
    abortInFlightRequests();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    await stopCacheInvalidationWorker();
    await Promise.allSettled([PG.closeConnection(), REDIS.destroy()]);

    // 2. Закрити worker pool.
    // await cpuPool.close();

    // 3. Закрити PostgreSQL pool.
    // await pool.end();

    process.exitCode = exitCode;
  } catch (error) {
    logger.fatal({ err: error }, "Error during shutdown");
    process.exitCode = 1;
  } finally {
    clearTimeout(forceExitTimer);
  }
}

process.on("SIGTERM", () => {
  shutdown("SIGTERM", 0);
});

process.on("SIGINT", () => {
  shutdown("SIGINT", 0);
});

process.on("uncaughtExceptionMonitor", (error, origin) => {
  logger.fatal(
    { err: error, origin },
    "Uncaught exception; process will terminate",
  );
});

// Власний listener змінює стандартну поведінку Node.js,
// тому ми самі ініціюємо завершення.
process.on("unhandledRejection", (reason) => {
  logger.fatal(
    {
      reason: reason instanceof Error ? reason : String(reason),
    },
    "Unhandled promise rejection",
  );

  shutdown("unhandledRejection", 1);
});

await start();
