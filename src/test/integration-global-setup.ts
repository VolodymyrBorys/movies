// Runs once in the main Vitest process: brings the test database schema up to date
// with the same migrations the app uses. The test DB itself must already exist
// (createdb movies_test) — tests never create or drop databases.

import { runner } from "node-pg-migrate";
import { applyIntegrationEnv } from "./integration-env.ts";

export default async function setup(): Promise<void> {
  applyIntegrationEnv();

  const { config } = await import("../config/env.ts");
  const pg = config.postgres;

  await runner({
    databaseUrl: {
      host: pg.primary.host,
      port: pg.primary.port,
      user: pg.primary.user,
      password: pg.primary.password,
      database: pg.database,
      connectionTimeoutMillis: pg.connectTimeoutMs,
      application_name: "movies-integration-tests",
      ...(pg.ssl === "verify-full" ? { ssl: { rejectUnauthorized: true } } : {}),
    },
    dir: "migrations",
    migrationsTable: "pgmigrations",
    direction: "up",
    count: Infinity,
    checkOrder: true,
    // Same transaction mode as scripts/migrate.ts (one transaction per migration).
    singleTransaction: false,
    log: () => {},
  });
}
