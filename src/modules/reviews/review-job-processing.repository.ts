import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { PG } from "../../infrastructure/postgres.ts";
import type { ReviewJobStatus } from "./review-jobs.repository.ts";

// Worker side of review_jobs (P5.4): state transitions driven by the review consumer.
// The API side (create job, read job) is review-jobs.repository.ts.
//
// The DB row is authoritative, not the broker message: every delivery re-reads the job under
// a row lock, so duplicates and redeliveries resolve to "already done" / "someone else has it".
// Every transition out of `running` is guarded by `locked_by = $leaseToken`: the holder of an
// expired lease that was taken over can't overwrite the new owner's outcome.
//
// The token is per CLAIM (`<workerId>:<uuid>`), not per process: one process handles several
// deliveries at once (prefetch), and two deliveries of the same job in the same process must
// not pass each other's guard after a lease takeover. The worker id prefix is for operators.

export interface MovieForReview {
  title: string;
  description: string | null;
  releaseYear: number;
  durationMinutes: number;
}

export type ClaimResult =
  | { kind: "missing" }
  | { kind: "terminal"; status: ReviewJobStatus }
  | { kind: "lease_busy"; attempts: number }
  | { kind: "superseded"; jobVersion: number; currentVersion: number }
  | { kind: "exhausted"; attempts: number }
  | {
      kind: "claimed";
      attempts: number;
      movieVersion: number;
      movie: MovieForReview;
      /** Pass to complete/release/fail: proves this claim still holds the lease. */
      leaseToken: string;
    };

export interface ClaimOptions {
  workerId: string;
  leaseSeconds: number;
  maxAttempts: number;
}

interface JobForClaimRow extends QueryResultRow {
  status: ReviewJobStatus;
  attempts: number;
  movie_version: number;
  lease_active: boolean;
  current_version: number;
  title: string;
  description: string | null;
  release_year: number;
  duration_minutes: number;
}

const TERMINAL_STATUSES: ReadonlySet<ReviewJobStatus> = new Set([
  "succeeded",
  "failed",
  "superseded",
]);

const MAX_ERROR_LENGTH = 4_000;

function truncateError(error: string): string {
  return error.slice(0, MAX_ERROR_LENGTH);
}

class ReviewJobProcessingRepository {
  /**
   * Decides what to do with a delivery for `jobId` and, when the job is processable, moves it
   * to `running` with a lease and one more attempt — all under a row lock on the job.
   */
  async claim(jobId: string, options: ClaimOptions): Promise<ClaimResult> {
    return PG.transaction((client) => this.claimInTransaction(client, jobId, options));
  }

  private async claimInTransaction(
    client: PoolClient,
    jobId: string,
    options: ClaimOptions,
  ): Promise<ClaimResult> {
    // FOR UPDATE OF j: serializes concurrent deliveries of the same job (duplicates,
    // redelivery racing a retry copy). The movie row is NOT locked: a PATCH right after this
    // read produces a review for the version the job was created for — the job is
    // version-specific, so that is still a correct result.
    const { rows } = await client.query<JobForClaimRow>(
      `
        SELECT j.status,
               j.attempts,
               j.movie_version,
               (j.locked_until IS NOT NULL AND j.locked_until > now()) AS lease_active,
               m.version AS current_version,
               m.title,
               m.description,
               m.release_year,
               m.duration_minutes
        FROM review_jobs AS j
        JOIN movies AS m ON m.id = j.movie_id
        WHERE j.id = $1
        FOR UPDATE OF j
      `,
      [jobId],
    );
    const job = rows[0];

    // Movie deleted → job deleted by ON DELETE CASCADE.
    if (job === undefined) return { kind: "missing" };

    if (TERMINAL_STATUSES.has(job.status)) return { kind: "terminal", status: job.status };

    // Running and the lease is live: another consumer is on it (or crashed recently).
    // An expired lease falls through and is taken over — there is no separate sweeper.
    if (job.status === "running" && job.lease_active) {
      return { kind: "lease_busy", attempts: job.attempts };
    }

    if (job.current_version !== job.movie_version) {
      await client.query(
        `
          UPDATE review_jobs
          SET status = 'superseded',
              finished_at = now(),
              locked_by = NULL,
              locked_until = NULL,
              last_error = $2
          WHERE id = $1
        `,
        [jobId, `movie version changed: ${job.movie_version} → ${job.current_version}`],
      );
      return {
        kind: "superseded",
        jobVersion: job.movie_version,
        currentVersion: job.current_version,
      };
    }

    // Covers crash loops: attempts are counted at claim time, so a worker that dies during
    // generation still burns one.
    if (job.attempts >= options.maxAttempts) {
      await client.query(
        `
          UPDATE review_jobs
          SET status = 'failed',
              finished_at = now(),
              locked_by = NULL,
              locked_until = NULL,
              last_error = $2
          WHERE id = $1
        `,
        [jobId, `attempts exhausted (${job.attempts}/${options.maxAttempts})`],
      );
      return { kind: "exhausted", attempts: job.attempts };
    }

    const leaseToken = `${options.workerId}:${randomUUID()}`;
    const claimed = await client.query<{ attempts: number }>(
      `
        UPDATE review_jobs
        SET status = 'running',
            attempts = attempts + 1,
            locked_by = $2,
            locked_until = now() + ($3 * interval '1 second'),
            started_at = COALESCE(started_at, now())
        WHERE id = $1
        RETURNING attempts
      `,
      [jobId, leaseToken, options.leaseSeconds],
    );
    const attempts = claimed.rows[0]?.attempts;
    if (attempts === undefined) throw new Error("review job claim UPDATE returned no row");

    return {
      kind: "claimed",
      attempts,
      leaseToken,
      movieVersion: job.movie_version,
      movie: {
        title: job.title,
        description: job.description,
        releaseYear: job.release_year,
        durationMinutes: job.duration_minutes,
      },
    };
  }

  /** `false`: the lease was lost (taken over or finalized elsewhere); nothing written. */
  async complete(
    jobId: string,
    leaseToken: string,
    result: { review: string; model: string },
  ): Promise<boolean> {
    const { rowCount } = await PG.writeQuery(
      `
        UPDATE review_jobs
        SET status = 'succeeded',
            review = $3,
            model = $4,
            finished_at = now(),
            locked_by = NULL,
            locked_until = NULL,
            last_error = NULL
        WHERE id = $1
          AND locked_by = $2
          AND status = 'running'
      `,
      [jobId, leaseToken, result.review, result.model],
    );
    return rowCount === 1;
  }

  /** Back to `queued` for a later delivery (retry queue). `false`: lease lost. */
  async release(jobId: string, leaseToken: string, error: string): Promise<boolean> {
    const { rowCount } = await PG.writeQuery(
      `
        UPDATE review_jobs
        SET status = 'queued',
            locked_by = NULL,
            locked_until = NULL,
            last_error = $3
        WHERE id = $1
          AND locked_by = $2
          AND status = 'running'
      `,
      [jobId, leaseToken, truncateError(error)],
    );
    return rowCount === 1;
  }

  /**
   * Back to `queued` after a graceful-shutdown abort (P5.6), refunding the attempt counted at
   * claim: a deploy is not a generation failure. `last_error` is kept. `false`: lease lost.
   * LAB: simplified — the refund trusts the caller; a crash (no refund) is indistinguishable
   * in the row from a shutdown, and repeated aborted shutdowns never exhaust the job.
   */
  async releaseForShutdown(jobId: string, leaseToken: string): Promise<boolean> {
    const { rowCount } = await PG.writeQuery(
      `
        UPDATE review_jobs
        SET status = 'queued',
            locked_by = NULL,
            locked_until = NULL,
            attempts = GREATEST(attempts - 1, 0)
        WHERE id = $1
          AND locked_by = $2
          AND status = 'running'
      `,
      [jobId, leaseToken],
    );
    return rowCount === 1;
  }

  /** Terminal failure. `false`: lease lost. */
  async fail(jobId: string, leaseToken: string, error: string): Promise<boolean> {
    const { rowCount } = await PG.writeQuery(
      `
        UPDATE review_jobs
        SET status = 'failed',
            finished_at = now(),
            locked_by = NULL,
            locked_until = NULL,
            last_error = $3
        WHERE id = $1
          AND locked_by = $2
          AND status = 'running'
      `,
      [jobId, leaseToken, truncateError(error)],
    );
    return rowCount === 1;
  }
}

export type ReviewJobProcessing = Pick<
  ReviewJobProcessingRepository,
  "claim" | "complete" | "release" | "releaseForShutdown" | "fail"
>;

export const reviewJobProcessingRepository = new ReviewJobProcessingRepository();
