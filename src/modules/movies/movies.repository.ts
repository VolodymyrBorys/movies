import type { PoolClient, QueryResultRow } from "pg";
import type { MovieRow, MovieSort } from "../../models/movies.ts";
import { PG } from "../../infrastructure/postgres.ts";
import { encodeMovieCursor, type MovieCursor } from "./cursor.ts";

export interface MoviePage {
  data: MovieRow[];
  hasMore: boolean;
  nextCursor: string | null;
}

type Consistency = "eventual" | "strong";

interface MovieListRow extends MovieRow {
  /** created_at as UTC text with microseconds; used only to build the cursor. */
  cursor_created_at: string;
}

// Microsecond-precision UTC text, independent of session TimeZone/DateStyle.
const CURSOR_CREATED_AT_SQL = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

class MoviesRepository {
  private async enqueueListInvalidation(
    client: PoolClient,
    movieId: string,
  ): Promise<void> {
    await client.query(
      `
        INSERT INTO cache_invalidation_outbox (
          aggregate_type,
          aggregate_id,
          event_type
        )
        VALUES ($1, $2, $3)
      `,
      ["movie", movieId, "movies.list.invalidate"],
    );
  }

  async getMovies(
    limit: number,
    cursor: MovieCursor | null,
    sort: MovieSort,
    consistency: Consistency = "eventual",
  ): Promise<MoviePage> {
    // Keyset on (created_at, id): id breaks ties between equal created_at values.
    // Both columns use the same direction, so the row comparison matches
    // movies_created_at_id_idx (created_at DESC, id DESC); ASC scans it backward.
    const direction = sort === "asc" ? "ASC" : "DESC";
    const operator = sort === "asc" ? ">" : "<";

    const sql =
      cursor === null
        ? `
          SELECT id, status, version, ${CURSOR_CREATED_AT_SQL} AS cursor_created_at
          FROM movies
          ORDER BY created_at ${direction}, id ${direction}
          LIMIT $1
        `
        : `
          SELECT id, status, version, ${CURSOR_CREATED_AT_SQL} AS cursor_created_at
          FROM movies
          WHERE (created_at, id) ${operator} ($1::timestamptz, $2::uuid)
          ORDER BY created_at ${direction}, id ${direction}
          LIMIT $3
        `;

    const params =
      cursor === null
        ? [limit + 1]
        : [cursor.createdAt, cursor.id, limit + 1];

    const result =
      consistency === "eventual"
        ? await PG.readQuery<MovieListRow>(sql, params)
        : await PG.writeQuery<MovieListRow>(sql, params);

    const hasMore = result.rows.length > limit;
    const page = result.rows.slice(0, limit);
    const last = page[page.length - 1];

    return {
      // Response shape unchanged: the cursor helper column is not exposed.
      data: page.map(({ cursor_created_at: _omit, ...movie }) => movie),
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeMovieCursor({ createdAt: last.cursor_created_at, id: last.id })
          : null,
    };
  }

  async updateMovie(id: string, status: string): Promise<MovieRow | null> {
    return PG.transaction(async (client) => {
      const result = await client.query<MovieRow>(
        `
          UPDATE movies
          SET status = $2,
              version = version + 1
          WHERE id = $1
          RETURNING id, status, version
        `,
        [id, status],
      );

      const movie = result.rows[0];

      if (!movie) {
        return null;
      }

      await this.enqueueListInvalidation(client, id);

      return movie;
    });
  }

  async deleteMovie(id: string): Promise<string | null> {
    return PG.transaction(async (client) => {
      const result = await client.query<{ id: string }>(
        `
          DELETE FROM movies
          WHERE id = $1
          RETURNING id
        `,
        [id],
      );

      const deleted = result.rows[0];

      if (!deleted) {
        return null;
      }

      await this.enqueueListInvalidation(client, deleted.id);

      return deleted.id;
    });
  }
}

export const moviesRepository = new MoviesRepository();
