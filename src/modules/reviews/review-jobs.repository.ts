import type { PoolClient, QueryResultRow } from "pg";
import { PG } from "../../infrastructure/postgres.ts";
import { utcTimestampSql } from "../../utils/sql-dates.ts";
import {
  REVIEW_REQUESTED_ROUTING_KEY,
  type ReviewRequestedMessage,
} from "./review-messages.ts";

// Must match the DB CHECK review_jobs_status_valid
// (migrations/1795432527618_review_jobs_message_outbox.sql).
export const REVIEW_JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "superseded",
] as const;

export type ReviewJobStatus = (typeof REVIEW_JOB_STATUSES)[number];

export interface ReviewJobRow extends QueryResultRow {
  id: string;
  movie_id: string;
  movie_version: number;
  status: ReviewJobStatus;
  attempts: number;
  review: string | null;
  model: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export type RequestReviewResult =
  | { kind: "created"; job: ReviewJobRow }
  | { kind: "existing"; job: ReviewJobRow }
  | { kind: "movie_not_found" };

// last_error / lease columns are internal and never selected for the API.
const REVIEW_JOB_COLUMNS = [
  "id",
  "movie_id",
  "movie_version",
  "status",
  "attempts",
  "review",
  "model",
  `${utcTimestampSql("created_at")} AS created_at`,
  `${utcTimestampSql("started_at")} AS started_at`,
  `${utcTimestampSql("finished_at")} AS finished_at`,
].join(", ");

// Literal on purpose: ON CONFLICT infers the partial unique index
// review_jobs_movie_version_active_uq only if this predicate implies the index predicate.
const ACTIVE_STATUSES_SQL = "status IN ('queued', 'running', 'succeeded')";

const PG_FOREIGN_KEY_VIOLATION = "23503";
const MOVIE_FK = "review_jobs_movie_fk";

function isMovieFkViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === PG_FOREIGN_KEY_VIOLATION &&
    "constraint" in error &&
    error.constraint === MOVIE_FK
  );
}

class ReviewJobsRepository {
  /**
   * Returns the job for the movie's CURRENT version: a new one (+ `review.requested` in
   * message_outbox, same transaction) or the existing queued/running/succeeded one.
   */
  async requestReview(movieId: string): Promise<RequestReviewResult> {
    try {
      return await PG.transaction((client) => this.requestInTransaction(client, movieId));
    } catch (error: unknown) {
      // The movie was deleted between our SELECT and the INSERT (FK check sees the commit).
      if (isMovieFkViolation(error)) return { kind: "movie_not_found" };
      throw error;
    }
  }

  private async requestInTransaction(
    client: PoolClient,
    movieId: string,
  ): Promise<RequestReviewResult> {
    const movie = await client.query<{ version: number }>(
      "SELECT version FROM movies WHERE id = $1",
      [movieId],
    );
    const movieVersion = movie.rows[0]?.version;

    if (movieVersion === undefined) return { kind: "movie_not_found" };

    // A concurrent PATCH after this SELECT creates a job for the old version; the consumer
    // marks it superseded without a billable call (P5.4).

    // Two rounds at most: the conflicting job can leave the active set (e.g. running →
    // failed) between our INSERT and SELECT; then a new job is allowed, so insert again.
    for (let round = 0; round < 2; round++) {
      // Under READ COMMITTED a conflicting row from an in-flight transaction makes this
      // wait; after its commit → DO NOTHING (0 rows), after its rollback → we insert.
      const inserted = await client.query<ReviewJobRow>(
        `
          INSERT INTO review_jobs (movie_id, movie_version)
          VALUES ($1, $2)
          ON CONFLICT (movie_id, movie_version) WHERE ${ACTIVE_STATUSES_SQL}
          DO NOTHING
          RETURNING ${REVIEW_JOB_COLUMNS}
        `,
        [movieId, movieVersion],
      );
      const job = inserted.rows[0];

      if (job) {
        await this.enqueueReviewRequested(client, job);
        return { kind: "created", job };
      }

      // New statement → new snapshot: sees the job that won the conflict.
      const existing = await client.query<ReviewJobRow>(
        `
          SELECT ${REVIEW_JOB_COLUMNS}
          FROM review_jobs
          WHERE movie_id = $1
            AND movie_version = $2
            AND ${ACTIVE_STATUSES_SQL}
        `,
        [movieId, movieVersion],
      );
      const existingJob = existing.rows[0];

      if (existingJob) return { kind: "existing", job: existingJob };
    }

    throw new Error("review job conflict did not resolve after 2 rounds");
  }

  private async enqueueReviewRequested(
    client: PoolClient,
    job: ReviewJobRow,
  ): Promise<void> {
    const message: ReviewRequestedMessage = {
      schemaVersion: 1,
      jobId: job.id,
      movieId: job.movie_id,
      movieVersion: job.movie_version,
    };

    await client.query(
      `
        INSERT INTO message_outbox (aggregate_type, aggregate_id, routing_key, payload)
        VALUES ($1, $2, $3, $4::jsonb)
      `,
      ["review_job", job.id, REVIEW_REQUESTED_ROUTING_KEY, JSON.stringify(message)],
    );
  }

  async getJobById(id: string): Promise<ReviewJobRow | null> {
    // Primary: clients poll the Location right after POST (read-after-write).
    const result = await PG.writeQuery<ReviewJobRow>(
      `
        SELECT ${REVIEW_JOB_COLUMNS}
        FROM review_jobs
        WHERE id = $1
      `,
      [id],
    );

    return result.rows[0] ?? null;
  }
}

export const reviewJobsRepository = new ReviewJobsRepository();
