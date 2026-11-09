import type { PoolClient, QueryResultRow } from "pg";
import type { MovieRow, MovieSort } from "../../models/movies.ts";
import { PG } from "../../infrastructure/postgres.ts";
import { encodeMovieCursor } from "./cursor.ts";

export interface MoviePage {
  data: MovieRow[];
  hasMore: boolean;
  nextCursor: string | null;
}

type Consistency = "eventual" | "strong";

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
    cursor: string | null,
    sort: MovieSort,
    consistency: Consistency = "eventual",
  ): Promise<MoviePage> {
    const direction = sort === "asc" ? "ASC" : "DESC";
    const operator = sort === "asc" ? ">" : "<";

    const sql =
      cursor === null
        ? `
          SELECT id, status, version
          FROM movie
          ORDER BY id ${direction}
          LIMIT $1
        `
        : `
          SELECT id, status, version
          FROM movie
          WHERE id ${operator} $1
          ORDER BY id ${direction}
          LIMIT $2
        `;

    const params = cursor === null ? [limit + 1] : [cursor, limit + 1];

    const result =
      consistency === "eventual"
        ? await PG.readQuery<MovieRow>(sql, params)
        : await PG.writeQuery<MovieRow>(sql, params);

    const hasMore = result.rows.length > limit;
    const data = result.rows.slice(0, limit);
    const lastMovie = data[data.length - 1];

    return {
      data,
      hasMore,
      nextCursor: hasMore && lastMovie ? encodeMovieCursor(lastMovie.id) : null,
    };
  }

  async updateMovie(id: string, status: string): Promise<MovieRow | null> {
    return PG.transaction(async (client) => {
      const result = await client.query<MovieRow>(
        `
          UPDATE movie
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
          DELETE FROM movie
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
