import type { QueryResultRow } from "pg";

export const MOVIES = "movies";
export const MOVIE = "movie";

// Must match the DB constraint movies_status_valid (migrations/*_movies_status_version_backfill.sql).
export const MOVIE_STATUSES = ["draft", "published", "archived"] as const;

export type MovieStatus = (typeof MOVIE_STATUSES)[number];

export interface UpdateMovieInput {
  id: string;
  body: UpdateMovieBody;
}

export interface UpdateMovieBody {
  status?: string;
}

export type MovieSort = "asc" | "desc";

export interface MovieRow extends QueryResultRow {
  id: string;
  title: string;
  description: string;
  release_year: string;
  duration_minutes: string;
  created_at: string;
  status: string;
  version: number;
}

/** Full movie row as node-pg returns it (smallint → number). */
export interface MovieDetailsRow extends QueryResultRow {
  id: string;
  title: string;
  description: string | null;
  release_year: number;
  duration_minutes: number;
  /** RFC 3339 UTC with microseconds, formatted in SQL ("2026-11-19T10:00:00.123456Z"). */
  created_at: string;
  // NOT NULL since migration *_movies_status_version_not_null.sql.
  status: MovieStatus;
  version: number;
}

export interface MoviePage {
  data: MovieRow[];
  hasMore: boolean;
  nextCursor: string | null;
}
