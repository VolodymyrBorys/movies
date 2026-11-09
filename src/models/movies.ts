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

export interface MoviePage {
  data: MovieRow[];
  hasMore: boolean;
  nextCursor: string | null;
}
