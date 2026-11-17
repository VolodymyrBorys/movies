import { PG } from "../infrastructure/postgres.ts";
import { REDIS } from "../infrastructure/redis.ts";
import { TEST_REDIS_DB } from "./integration-env.ts";

export async function startInfrastructure(): Promise<void> {
  await Promise.all([PG.start(), REDIS.start()]);
}

export async function stopInfrastructure(): Promise<void> {
  await Promise.allSettled([PG.closeConnection(), REDIS.destroy()]);
}

/**
 * Empties the test database and the test Redis DB.
 * Re-checks both targets at runtime before destroying anything.
 */
export async function resetState(): Promise<void> {
  const { rows } = await PG.writeQuery<{ db: string }>(
    "SELECT current_database() AS db",
  );
  const db = rows[0]?.db ?? "";
  if (!db.endsWith("_test")) {
    throw new Error(`Refusing to TRUNCATE: connected to "${db}", not a *_test DB`);
  }

  const clientInfo = String(await REDIS.client.sendCommand(["CLIENT", "INFO"]));
  if (!new RegExp(`\\bdb=${TEST_REDIS_DB}\\b`).test(clientInfo)) {
    throw new Error(`Refusing to FLUSHDB: Redis client is not on db ${TEST_REDIS_DB}`);
  }

  await PG.writeQuery(
    "TRUNCATE movies, cache_invalidation_outbox RESTART IDENTITY",
  );
  await REDIS.client.flushDb();
}

export interface TestMovie {
  id?: string;
  createdAt: string;
  status?: string | null;
  version?: number | null;
}

export async function insertMovie(movie: TestMovie): Promise<string> {
  const { rows } = await PG.writeQuery<{ id: string }>(
    `
      INSERT INTO movies (id, title, release_year, duration_minutes, created_at, status, version)
      VALUES (COALESCE($1::uuid, gen_random_uuid()), 'Test movie', 2000, 100, $2::timestamptz, $3, $4)
      RETURNING id
    `,
    [
      movie.id ?? null,
      movie.createdAt,
      movie.status === undefined ? "draft" : movie.status,
      movie.version === undefined ? 1 : movie.version,
    ],
  );

  const id = rows[0]?.id;
  if (id === undefined) throw new Error("insertMovie returned no id");
  return id;
}

export interface OutboxRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  attempts: number;
  locked_by: string | null;
  locked_until: Date | null;
  available_at: Date;
  processed_at: Date | null;
  dead_lettered_at: Date | null;
  last_error: string | null;
}

export async function outboxRows(): Promise<OutboxRow[]> {
  const { rows } = await PG.writeQuery<OutboxRow>(
    "SELECT * FROM cache_invalidation_outbox ORDER BY id",
  );
  return rows;
}
