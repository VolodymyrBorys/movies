import { REDIS } from "../../infrastructure/redis.ts";
import { decodeMovieCursor } from "./cursor.ts";
import { moviesRepository } from "./movies.repository.ts";

export class InvalidMoviesQueryError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "InvalidMoviesQueryError";
  }
}

export class MovieService {
  async getMovies(query: {
    limit: number;
    cursor?: string;
    sort: "asc" | "desc";
  }) {
    const { limit, sort } = query;

    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new InvalidMoviesQueryError(
        "limit must be an integer between 1 and 100",
      );
    }

    let cursor: string | null;

    try {
      cursor = decodeMovieCursor(query.cursor);
    } catch {
      throw new InvalidMoviesQueryError("sort must be asc or desc");
    }

    let cacheAvailable = true;
    let cacheKey: string | null = null;

    // if we need strong consistency await moviesRepository.getMovies(limit, cursor, sort, 'strong');
    // it need to call this method before cache layer because redis has stale data from replica

    try {
      const listVersion = await REDIS.getMoviesListVersion();
      cacheKey = `movies:v1:list:v${listVersion}:limit:${limit}:sort:${sort}:cursor:${cursor ?? "first"}`;
      const cached = await REDIS.get(cacheKey);
      if (cached !== null) return cached;
    } catch (error) {
      cacheAvailable = false;
      cacheKey = null;

      console.error("Movies cache read failed; using PostgreSQL", error);
    }

    const page = await moviesRepository.getMovies(limit, cursor, sort);

    if (cacheAvailable && cacheKey !== null) {
      try {
        const jitter = Math.floor(Math.random() * 16);
        await REDIS.set(page, cacheKey, 60 + jitter);
      } catch (error) {
        // Не робимо успішний GET невдалим через запис у кеш.
        console.error("Movies cache write failed", error);
      }
    }

    return page;
  }

  async deleteMovie(id: string) {
    const movie = await moviesRepository.deleteMovie(id);

    if (!movie) {
      return null;
    }

    // Best effort: зменшує звичайне вікно застарілого кешу.
    // Надійне повторення забезпечує outbox worker.
    try {
      await REDIS.invalidateMoviesList();
    } catch (error) {
      console.error(
        "Immediate movies cache invalidation failed; outbox will retry",
        { movieId: id, error },
      );
    }

    return movie;
  }

  async updateMovie(id: string, body: { status: string }) {
    const movie = await moviesRepository.updateMovie(id, body.status);

    if (!movie) {
      return null;
    }

    // Best effort: зменшує звичайне вікно застарілого кешу.
    // Надійне повторення забезпечує outbox worker.
    try {
      await REDIS.invalidateMoviesList();
    } catch (error) {
      console.error(
        "Immediate movies cache invalidation failed; outbox will retry",
        { movieId: id, error },
      );
    }

    return movie;
  }
}
