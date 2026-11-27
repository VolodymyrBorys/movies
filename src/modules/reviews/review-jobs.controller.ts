import type { Request, Response } from "express";
import type { MovieIdParams } from "../movies/validation/movie-id-params.ts";
import {
  reviewJobsRepository,
  type ReviewJobRow,
  type ReviewJobStatus,
} from "./review-jobs.repository.ts";
import type { ReviewJobIdParams } from "./validation/review-job-id-params.ts";

export interface ReviewJob {
  id: string;
  movieId: string;
  /** Movie version the review is (or will be) generated from — same value as its ETag. */
  movieVersion: number;
  status: ReviewJobStatus;
  attempts: number;
  /** Non-null only when status is "succeeded". */
  review: string | null;
  model: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ReviewJobResponse {
  data: ReviewJob;
}

function toReviewJob(row: ReviewJobRow): ReviewJob {
  return {
    id: row.id,
    movieId: row.movie_id,
    movieVersion: row.movie_version,
    status: row.status,
    attempts: row.attempts,
    review: row.review,
    model: row.model,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function jobLocation(id: string): string {
  return `/v1/review-jobs/${id}`;
}

/**
 * POST /v1/movies/:id/review — asynchronous review (P5.2): records a job for the movie's
 * current version and returns it. No Gemini call here; the worker generates (P5.4).
 * 202 = new or still in progress (poll Location); 200 = already succeeded for this version.
 * Repeating the POST for the same version returns the same job (no new billable work).
 */
export const requestMovieReview = async (_req: Request, res: Response) => {
  const { id } = res.locals.validatedParams as MovieIdParams;

  const result = await reviewJobsRepository.requestReview(id);

  if (result.kind === "movie_not_found") {
    res.status(404).json({
      error: {
        code: "MOVIE_NOT_FOUND",
        message: "Movie not found",
      },
    });
    return;
  }

  // LAB: simplified — no rate limit: every failed job allows a new (billable) one.
  const body: ReviewJobResponse = { data: toReviewJob(result.job) };

  res
    .location(jobLocation(result.job.id))
    .status(result.job.status === "succeeded" ? 200 : 202)
    .json(body);
};

/** GET /v1/review-jobs/:id */
export const getReviewJob = async (_req: Request, res: Response) => {
  const { id } = res.locals.validatedParams as ReviewJobIdParams;

  const job = await reviewJobsRepository.getJobById(id);

  if (!job) {
    res.status(404).json({
      error: {
        code: "REVIEW_JOB_NOT_FOUND",
        message: "Review job not found",
      },
    });
    return;
  }

  const body: ReviewJobResponse = { data: toReviewJob(job) };
  res.status(200).json(body);
};
