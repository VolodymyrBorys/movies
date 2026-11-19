// Runs SQL migrations from ./migrations against the PostgreSQL PRIMARY.
//
// Usage (via npm scripts):
//   npm run migrate:up                  apply all pending
//   npm run migrate:up -- 1             apply next 1
//   npm run migrate:down                roll back last 1
//   npm run migrate:up -- --fake        mark pending as applied WITHOUT running SQL
//                                       (one-time baseline for a DB that already has the schema)
//   npm run migrate:up -- --dry-run     print what would run
//
// Connection comes from the validated `config.postgres` (src/config/env.ts), not DATABASE_URL.

import { runner, type RunnerOption } from "node-pg-migrate";
import type { ClientConfig } from "pg";
import { config } from "../src/config/env.ts";

type Direction = "up" | "down";

function parseArgs(argv: string[]): {
  direction: Direction;
  count: number;
  fake: boolean;
  dryRun: boolean;
} {
  const [direction, ...rest] = argv;

  if (direction !== "up" && direction !== "down") {
    throw new Error("first argument must be 'up' or 'down'");
  }

  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const positional = rest.filter((a) => !a.startsWith("--"));

  for (const flag of flags) {
    if (flag !== "--fake" && flag !== "--dry-run") {
      throw new Error(`unknown flag: ${flag}`);
    }
  }

  // Same defaults as the node-pg-migrate CLI: up = all pending, down = last one.
  let count = direction === "up" ? Infinity : 1;

  if (positional.length > 1) {
    throw new Error("expected at most one positional argument (count)");
  }
  if (positional[0] !== undefined) {
    if (!/^[1-9]\d*$/.test(positional[0])) {
      throw new Error("count must be a positive integer");
    }
    count = Number(positional[0]);
  }

  return {
    direction,
    count,
    fake: flags.has("--fake"),
    dryRun: flags.has("--dry-run"),
  };
}

const args = parseArgs(process.argv.slice(2));
const pg = config.postgres;

// Migrations always target the primary. No statement_timeout here (the app's 2 s would
// abort index builds), but a lock_timeout: DDL waiting for an ACCESS EXCLUSIVE lock
// queues every later query on that table behind it, so fail fast instead of stalling traffic.
// LAB: simplified — production would also tune per migration (e.g. CREATE INDEX CONCURRENTLY
// outside a transaction) and run this as a one-off job before the app rollout.
const databaseUrl: ClientConfig = {
  host: pg.primary.host,
  port: pg.primary.port,
  user: pg.primary.user,
  password: pg.primary.password,
  database: pg.database,
  connectionTimeoutMillis: pg.connectTimeoutMs,
  application_name: "movies-migrate",
  options: "-c lock_timeout=5s",
  ...(pg.ssl === "verify-full" ? { ssl: { rejectUnauthorized: true } } : {}),
};

const options: RunnerOption = {
  databaseUrl,
  dir: "migrations",
  migrationsTable: "pgmigrations",
  direction: args.direction,
  count: args.count,
  fake: args.fake,
  dryRun: args.dryRun,
  checkOrder: true,
  // One transaction PER migration (library default: all pending in ONE transaction).
  // Expand/contract relies on it: with a single transaction the ACCESS EXCLUSIVE lock taken
  // by an earlier migration (e.g. ADD CONSTRAINT ... NOT VALID) would be held while a later
  // one scans the table (VALIDATE CONSTRAINT), defeating the split. Trade-off: if a later
  // migration fails, earlier ones stay applied — rerun after fixing the cause.
  singleTransaction: false,
  // Advisory lock: two concurrent runners (e.g. two deploy jobs) cannot migrate at once.
  advisoryLockMode: "fail",
};

try {
  const applied = await runner(options);
  console.log(
    `[migrate] ${args.direction}${args.fake ? " (fake)" : ""}${args.dryRun ? " (dry-run)" : ""}: ` +
      (applied.length === 0
        ? "nothing to do"
        : applied.map((m) => m.name).join(", ")),
  );
} catch (error) {
  console.error("[migrate] failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
