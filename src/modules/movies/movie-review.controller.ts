import type { Request, Response } from "express";
import { shutdownSignal } from "../../infrastructure/shutdown-signal.ts";
import { movieReviewGenerationService } from "../rag/generation/movie-review-generation.service.ts";
import { REVIEW_DEADLINE_MS } from "../rag/rag-deadlines.ts";
import { toRagHttpError } from "../rag/rag-http-errors.ts";
import { createRequestSignal } from "../../utils/request-signal.ts";
import { MovieService } from "./movies.service.ts";
import type { MovieIdParams } from "./validation/movie-id-params.ts";

const moviesService = new MovieService();

export interface MovieReviewResponse {
  data: {
    movieId: string;
    /** Version of the movie the review was generated from (same value as its ETag). */
    movieVersion: number;
    review: string;
    model: string;
  };
}

/**
 * POST /v1/movies/:id/review — synchronous Gemini review (D4). POST: not idempotent and
 * billed per call. The review is not stored; P5 makes it async (202 + job).
 * No generatedAt: API dates come from SQL (RFC 3339 with microseconds); the response time
 * is in the HTTP Date header.
 */
export const reviewMovie = async (_req: Request, res: Response) => {
  const { id } = res.locals.validatedParams as MovieIdParams;
  const signal = createRequestSignal(res, {
    timeoutMs: REVIEW_DEADLINE_MS,
    shutdownSignal,
  });

  // Primary read (same as GET /movies/:id). A DB failure is the regular 500 path, outside
  // the RAG error mapping.
  const movie = await moviesService.getMovieById(id);

  if (!movie) {
    res.status(404).json({
      error: {
        code: "MOVIE_NOT_FOUND",
        message: "Movie not found",
      },
    });
    return;
  }

  try {
    // Deadline/disconnect/shutdown during the DB read: don't start billable work.
    signal.throwIfAborted();

    const { review, model } = await movieReviewGenerationService.generate({
      title: movie.title,
      description: movie.description,
      releaseYear: movie.release_year,
      durationMinutes: movie.duration_minutes,
      signal,
    });

    const body: MovieReviewResponse = {
      data: { movieId: movie.id, movieVersion: movie.version, review, model },
    };
    res.status(200).json(body);
  } catch (error: unknown) {
    throw toRagHttpError(error, signal);
  }
};
