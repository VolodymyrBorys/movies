// Points integration tests at DISPOSABLE resources. Must run before anything imports
// src/config/env.ts (it reads process.env once, at import time).
//
// Connection details (host/user/password) come from `.env` like for the app; only the
// database name, Redis logical DB and replica settings are overridden here.
//
//   TEST_PG_DATABASE  default "movies_test"; must end with "_test" (tests TRUNCATE tables)
//   TEST_REDIS_URL    default REDIS_URL; the logical DB is always forced to 15 (tests FLUSHDB)
//   TEST_LOG_LEVEL    default "silent"

export const TEST_REDIS_DB = 15;

export function applyIntegrationEnv(): void {
  const database = process.env.TEST_PG_DATABASE ?? "movies_test";

  if (!database.endsWith("_test")) {
    throw new Error(
      `Refusing to run integration tests: PostgreSQL database "${database}" must end with "_test"`,
    );
  }

  process.env.PG_DATABASE = database;

  // Reads go to the primary: tests do read-after-write and must not depend on replica lag.
  delete process.env.PG_REPLICA_HOST;
  delete process.env.PG_REPLICA_USER;
  delete process.env.PG_REPLICA_PASSWORD;

  const redisUrl = new URL(
    process.env.TEST_REDIS_URL ??
      process.env.REDIS_URL ??
      "redis://localhost:6379",
  );
  redisUrl.pathname = `/${TEST_REDIS_DB}`;
  process.env.REDIS_URL = redisUrl.toString();

  process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? "silent";
  process.env.NODE_ENV = "test";
}
