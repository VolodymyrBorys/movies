import type { QueryResultRow } from "pg";

export const MOVIES = "movies";
export const MOVIE = "movie";

export type MovieStatus = "draft" | "published" | "archived";

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
  // Nullable until a migration tightens them (roadmap P3, step C4).
  status: string | null;
  version: number | null;
}

export interface MoviePage {
  data: MovieRow[];
  hasMore: boolean;
  nextCursor: string | null;
}
