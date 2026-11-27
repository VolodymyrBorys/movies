import type { Logger } from "pino";
import {
  reviewDeliveriesTotal,
  reviewGenerationDuration,
  type ReviewDeliveryOutcome,
} from "../infrastructure/metrics.ts";
import { retryTierFor, type ReviewRetryTier } from "../messaging/topology.ts";
import { RagInputError, RagUpstreamError } from "../modules/rag/rag.errors.ts";
import type { MovieReviewResult } from "../modules/rag/generation/movie-review-generation.service.ts";
import type { ReviewGenerator } from "../modules/reviews/review-generator.ts";
import type {
  ClaimResult,
  ReviewJobProcessing,
} from "../modules/reviews/review-job-processing.repository.ts";
import { parseReviewRequestedMessage } from "../modules/reviews/review-messages.ts";

// Review consumer logic (P5.4): one `review.requested` delivery → job state + ack decision.
//
// Rules:
// - The job row decides (status, lease, attempts, movie version); the message only names it.
// - DB first, then broker: a crash between the two leaves the message unacked → redelivered →
//   the next delivery sees the DB state. Cost: an extra attempt (possibly a billable
//   duplicate), never a lost job.
// - Generation runs outside any transaction; the lease (DB) marks the job as taken.
// - A retry is a NEW copy in a TTL retry queue (published with confirm) and only then the
//   original is acked. `nack(requeue=true)` is only the fallback when that publish fails, and
//   only after a pause: an explicit requeue does NOT count towards the quorum delivery-limit
//   (observed 2026-11-25 on RabbitMQ 4.x: 13 requeues, no x-delivery-count, never
//   dead-lettered), so without the pause a persistent publish failure is a hot redelivery
//   loop. The count is bounded by DB attempts on the main path; the pause bounds the rate.

export const REVIEW_CONSUMER_SETTINGS = Object.freeze({
  /** Unacked deliveries per consumer = concurrent generations (bounds billable parallelism). */
  prefetch: 4,
  maxAttempts: 5,
  /** Whole generation incl. the generator's own in-process retries. */
  generationDeadlineMs: 90_000,
  /** > deadline + time to write the result; otherwise a slow success loses its lease. */
  leaseSeconds: 120,
  /** Delay before looking again at a job another consumer holds. */
  leaseBusyTier: retryTierFor(2),
  /** Delay after an infrastructure error (PostgreSQL) — no attempt is counted. */
  infrastructureTier: retryTierFor(1),
  /**
   * Pause before the nack(requeue=true) fallback (holds one prefetch slot meanwhile).
   * LAB: simplified — rate-limits, doesn't bound: with PostgreSQL AND the retry publish
   * failing, the message cycles every few seconds until one of them recovers.
   */
  requeueDelayMs: 5_000,
});

/** One broker delivery, bound to the channel it arrived on. */
export interface ReviewDelivery {
  readonly content: Buffer;
  readonly messageId: string | undefined;
  readonly redelivered: boolean;
  ack(): void;
  /** nack(requeue=false): dead-lettered to the DLQ. */
  deadLetter(): void;
  /** nack(requeue=true): immediate redelivery; fallback only. */
  requeue(): void;
  /** Publishes a copy into the retry queue; true only when the broker confirmed and routed it. */
  publishRetry(tier: ReviewRetryTier, failedAttempt: number): Promise<boolean>;
}

export interface ReviewHandlerDeps {
  jobs: ReviewJobProcessing;
  generator: ReviewGenerator;
  workerId: string;
  logger: Logger;
  settings?: typeof REVIEW_CONSUMER_SETTINGS;
}

/**
 * duplicate = job already terminal; job_missing = movie (and job) deleted; failed = permanent
 * generation error; exhausted = attempts used up; requeued = retry publish failed →
 * nack(requeue=true). The list lives in metrics.ts (`review_deliveries_total` labels);
 * `handler_threw` is recorded by the consumer, never returned.
 */
export type ReviewOutcome = Exclude<ReviewDeliveryOutcome, "handler_threw">;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Permanent: retrying can't help (bad input, non-retryable upstream answer). */
function isPermanent(error: unknown): boolean {
  if (error instanceof RagInputError) return true;
  if (error instanceof RagUpstreamError) return !error.retryable;
  // Unknown errors (deadline abort, network, bugs) count as transient: attempts bound them.
  return false;
}

/** Handles one delivery and counts its outcome (a throw is counted by the consumer). */
export async function handleReviewDelivery(
  delivery: ReviewDelivery,
  deps: ReviewHandlerDeps,
): Promise<ReviewOutcome> {
  const outcome = await processReviewDelivery(delivery, deps);
  reviewDeliveriesTotal.inc({ outcome });
  return outcome;
}

async function processReviewDelivery(
  delivery: ReviewDelivery,
  deps: ReviewHandlerDeps,
): Promise<ReviewOutcome> {
  const settings = deps.settings ?? REVIEW_CONSUMER_SETTINGS;
  const parsed = parseReviewRequestedMessage(delivery.content);

  if (!parsed.ok) {
    deps.logger.error(
      { messageId: delivery.messageId, error: parsed.error, result: "invalid_message" },
      "Review message rejected to the DLQ",
    );
    delivery.deadLetter();
    return "invalid_message";
  }

  const { jobId } = parsed.message;
  const log = deps.logger.child({ jobId, messageId: delivery.messageId });

  /** Retry copy → ack, or requeue when the copy can't be published. */
  const retryLater = async (
    tier: ReviewRetryTier,
    failedAttempt: number,
    outcome: ReviewOutcome,
    context: Record<string, unknown>,
  ): Promise<ReviewOutcome> => {
    if (await delivery.publishRetry(tier, failedAttempt)) {
      delivery.ack();
      log.warn({ ...context, result: outcome, retryQueue: tier.queue }, "Review retry scheduled");
      return outcome;
    }
    await new Promise((resolve) => setTimeout(resolve, settings.requeueDelayMs));
    delivery.requeue();
    log.warn(
      { ...context, result: "requeued", delayMs: settings.requeueDelayMs },
      "Review retry publish failed; message requeued after a pause",
    );
    return "requeued";
  };

  let claim: ClaimResult;
  try {
    claim = await deps.jobs.claim(jobId, {
      workerId: deps.workerId,
      leaseSeconds: settings.leaseSeconds,
      maxAttempts: settings.maxAttempts,
    });
  } catch (error) {
    // PostgreSQL unavailable: nothing was written, so no attempt is counted.
    return retryLater(settings.infrastructureTier, 0, "infrastructure_retry", {
      err: error,
    });
  }

  switch (claim.kind) {
    case "missing":
      delivery.ack();
      log.info({ result: "job_missing" }, "Review job no longer exists; message acked");
      return "job_missing";

    case "terminal":
      delivery.ack();
      log.info({ status: claim.status, result: "duplicate" }, "Review job already finished");
      return "duplicate";

    case "lease_busy":
      return retryLater(settings.leaseBusyTier, claim.attempts, "lease_busy", {
        attempts: claim.attempts,
      });

    case "superseded":
      delivery.ack();
      log.info(
        { jobVersion: claim.jobVersion, currentVersion: claim.currentVersion, result: "superseded" },
        "Review job superseded by a newer movie version",
      );
      return "superseded";

    case "exhausted":
      delivery.deadLetter();
      log.error({ attempts: claim.attempts, result: "exhausted" }, "Review job failed: attempts exhausted");
      return "exhausted";

    case "claimed":
      break;
  }

  const { attempts, leaseToken } = claim;

  try {
    let result: MovieReviewResult;
    const endGeneration = reviewGenerationDuration.startTimer();
    try {
      result = await deps.generator.generate({
        ...claim.movie,
        signal: AbortSignal.timeout(settings.generationDeadlineMs),
      });
      endGeneration({ outcome: "ok" });
    } catch (error) {
      endGeneration({ outcome: "error" });
      return await handleGenerationError(error);
    }

    if (await deps.jobs.complete(jobId, leaseToken, result)) {
      delivery.ack();
      log.info({ attempts, model: result.model, result: "succeeded" }, "Review generated");
      return "succeeded";
    }

    // Our lease expired and another consumer took the job over: its outcome counts.
    delivery.ack();
    log.warn({ attempts, result: "lease_lost" }, "Review result discarded: lease lost");
    return "lease_lost";
  } catch (error) {
    // Writing the outcome failed (PostgreSQL). The job stays `running` with our lease; the
    // retry copy finds it lease_busy until the lease expires, then takes it over (one more
    // attempt, a billable duplicate if generation had succeeded).
    return retryLater(settings.infrastructureTier, 0, "infrastructure_retry", {
      attempts,
      err: error,
    });
  }

  async function handleGenerationError(error: unknown): Promise<ReviewOutcome> {
    const message = errorMessage(error);

    if (isPermanent(error) || attempts >= settings.maxAttempts) {
      const outcome: ReviewOutcome = isPermanent(error) ? "failed" : "exhausted";
      if (!(await deps.jobs.fail(jobId, leaseToken, message))) {
        delivery.ack();
        log.warn({ attempts, result: "lease_lost" }, "Review failure not recorded: lease lost");
        return "lease_lost";
      }
      delivery.deadLetter();
      log.error({ attempts, err: error, result: outcome }, "Review job failed");
      return outcome;
    }

    if (!(await deps.jobs.release(jobId, leaseToken, message))) {
      delivery.ack();
      log.warn({ attempts, result: "lease_lost" }, "Review retry not recorded: lease lost");
      return "lease_lost";
    }

    return retryLater(retryTierFor(attempts), attempts, "retry_scheduled", {
      attempts,
      err: error,
    });
  }
}
