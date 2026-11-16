import { createServer } from "node:http";
import { loadEnvFile } from "node:process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { logger } from "./infrastructure/logger.ts";
import { PG } from "./infrastructure/postgres.ts";
import { REDIS } from "./infrastructure/redis.ts";
import {
  startCacheInvalidationWorker,
  stopCacheInvalidationWorker,
} from "./workers/cache-invalidation-runner.ts";
// import { logger } from "./logging/logger.ts";
// import { pool } from "./infra/db/postgres.ts";
// import { cpuPool } from "./services/cpu-pool.ts";

/*  */

const envFile = join(import.meta.dirname, "../.env");

if (existsSync(envFile)) {
  loadEnvFile(envFile);
}

// const { env } = await import("./config/env.ts");
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
    server.listen(process.env.PORT);
  });
}

async function start(): Promise<void> {
  // Якщо будь-який критичний сервіс не стартував,
  // застосунок не починає приймати HTTP-запити.
  await Promise.all([PG.start(), REDIS.start()]);
  startCacheInvalidationWorker();
  await listen();
  console.info({
    event: "server_started",
    // host: env.HOST,
    // port: env.PORT,
    // environment: env.NODE_ENV,
  });
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
    // 1. Перестати приймати нові HTTP-з'єднання.
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
