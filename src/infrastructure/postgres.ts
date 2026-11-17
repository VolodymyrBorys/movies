import {
  Pool,
  type PoolClient,
  type PoolConfig,
  type QueryResult,
  type QueryResultRow,
} from "pg";
import {
  config,
  type PgConnectionConfig,
  type PostgresConfig,
} from "../config/env.ts";
import { Gauge } from "prom-client";
import { logger as rootLogger } from "./logger.ts";
import { metricsRegistry } from "./metrics.ts";

const logger = rootLogger.child({ component: "postgres" });

export interface PoolStats {
  total: number;
  idle: number;
  waiting: number;
}

type PgRole = "primary" | "replica";

function toPoolConfig(
  conn: PgConnectionConfig,
  pg: PostgresConfig,
  role: PgRole,
): PoolConfig {
  return {
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: pg.database,
    max: pg.poolMax,
    connectionTimeoutMillis: pg.connectTimeoutMs,
    options: `--statement_timeout=${pg.statementTimeoutMs}`,
    // Visible in pg_stat_activity: which pool a connection belongs to.
    application_name: `movies-api:${role}`,
    // Spread instead of `ssl: undefined` because of exactOptionalPropertyTypes.
    ...(pg.ssl === "verify-full" ? { ssl: { rejectUnauthorized: true } } : {}),
  };
}

const pg = config.postgres;

export const pgOptionsMaster: PoolConfig = toPoolConfig(
  pg.primary,
  pg,
  "primary",
);

// No replica configured => reads go to primary (no replication lag possible).
export const pgOptionsReplica: PoolConfig = pg.replica
  ? toPoolConfig(pg.replica, pg, "replica")
  : toPoolConfig(pg.primary, pg, "primary");

export type MovieSort = "asc" | "desc";

export class PgService {
  private writePool!: Pool;
  private readPool!: Pool;

  async start(): Promise<void> {
    this.writePool = new Pool(pgOptionsMaster);
    this.readPool = new Pool(pgOptionsReplica);
    await this.writePool.query("select 1 + 1");
    await this.readPool.query("select 1 + 1");
    logger.info("PostgreSQL connected");
  }

  async closeConnection(): Promise<void> {
    if (!this.writePool.ended) {
      await this.writePool.end();
      logger.info({ pool: "write" }, "PostgreSQL pool closed");
    }
    if (!this.readPool.ended) {
      await this.readPool.end();
      logger.info({ pool: "read" }, "PostgreSQL pool closed");
    }
  }

  /** Snapshot of client-side pool state; null before start(). */
  poolStats(): { write: PoolStats; read: PoolStats } | null {
    if (this.writePool === undefined || this.readPool === undefined) return null;

    const stats = (pool: Pool): PoolStats => ({
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    });

    return { write: stats(this.writePool), read: stats(this.readPool) };
  }

  /** Readiness check. Goes through the pool, so pool exhaustion also shows up as "down". */
  async ping(pool: "write" | "read"): Promise<void> {
    await (pool === "write" ? this.writePool : this.readPool).query("SELECT 1");
  }

  async writeQuery<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: any[],
  ): Promise<QueryResult<R>> {
    return this.writePool.query<R>(sql, params);
  }

  async readQuery<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: any[],
  ): Promise<QueryResult<R>> {
    return this.readPool.query<R>(sql, params);
  }

  async transaction<T>(
    callback: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.writePool.connect();
    let transactionStarted = false;

    try {
      await client.query("BEGIN");
      transactionStarted = true;

      const result = await callback(client);

      await client.query("COMMIT");
      transactionStarted = false;

      return result;
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          logger.error({ err: rollbackError }, "PostgreSQL rollback failed");
        }
      }

      throw error;
    } finally {
      client.release();
    }
  }
}

export const PG = new PgService();

// Sampled on each scrape from in-memory pool counters (no DB round-trip).
// `waiting > 0` sustained = requests queue for a connection: pool saturation.
// LAB: simplified — this is the client-side view of ONE process; the server-side view
// (pg_stat_activity, max_connections) comes from postgres_exporter in P1.
new Gauge({
  name: "pg_pool_connections",
  help: "node-postgres pool clients by state (total, idle, waiting requests)",
  labelNames: ["pool", "state"] as const,
  registers: [metricsRegistry],
  collect() {
    this.reset();
    const stats = PG.poolStats();
    if (stats === null) return;

    for (const pool of ["write", "read"] as const) {
      for (const state of ["total", "idle", "waiting"] as const) {
        this.set({ pool, state }, stats[pool][state]);
      }
    }
  },
});
