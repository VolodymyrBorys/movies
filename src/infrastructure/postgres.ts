import {
  Pool,
  type PoolClient,
  type PoolConfig,
  type QueryResult,
  type QueryResultRow,
} from "pg";

export const pgOptionsMaster: PoolConfig = {
  host: "localhost",
  port: 5432,
  user: "volodymyr",
  database: "nebula",
  password: "nebula",
  max: 10,
  options: "--statement_timeout=2000",
};

export const pgOptionsReplica: PoolConfig = {
  host: "localhost",
  port: 5433,
  user: "volodymyr",
  database: "nebula",
  password: "nebula",
  max: 10,
  options: "--statement_timeout=2000",
};

export type MovieSort = "asc" | "desc";

export class PgService {
  private writePool!: Pool;
  private readPool!: Pool;

  async start(): Promise<void> {
    this.writePool = new Pool(pgOptionsMaster);
    this.readPool = new Pool(pgOptionsReplica);
    await this.writePool.query("select 1 + 1");
    await this.readPool.query("select 1 + 1");
    console.log("[Postgres] connected");
  }

  async closeConnection(): Promise<void> {
    if (!this.writePool.ended) {
      await this.writePool.end();
      console.log("[Postgres] write connection closed");
    }
    if (!this.readPool.ended) {
      await this.readPool.end();
      console.log("[Postgres] read connection closed");
    }
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
          // Замінити на logger твого проєкту.
          console.error("PostgreSQL rollback failed", rollbackError);
        }
      }

      throw error;
    } finally {
      client.release();
    }
  }
}

export const PG = new PgService();
