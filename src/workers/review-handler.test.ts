import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { REVIEW_RETRY_TIERS, type ReviewRetryTier } from "../messaging/topology.ts";
import { RagInputError, RagUpstreamError } from "../modules/rag/rag.errors.ts";
import type { ReviewGenerator } from "../modules/reviews/review-generator.ts";
import type {
  ClaimResult,
  ReviewJobProcessing,
} from "../modules/reviews/review-job-processing.repository.ts";
import {
  handleReviewDelivery,
  REVIEW_CONSUMER_SETTINGS,
  type ReviewDelivery,
} from "./review-handler.ts";

const JOB_ID = "6f1c2b9e-3a4d-4e5f-8a7b-1c2d3e4f5a6b";
const MOVIE_ID = "0b8a4c1e-9d2f-4a3b-8c5d-6e7f8091a2b3";
const WORKER_ID = "review-consumer-test";
const LEASE_TOKEN = `${WORKER_ID}:claim-1`;
const logger = pino({ level: "silent" });

const MOVIE = {
  title: "Test movie",
  description: null,
  releaseYear: 2000,
  durationMinutes: 100,
};

function body(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      jobId: JOB_ID,
      movieId: MOVIE_ID,
      movieVersion: 1,
      ...overrides,
    }),
  );
}

type Action = "ack" | "dead_letter" | "requeue" | `retry:${string}`;

class FakeDelivery implements ReviewDelivery {
  readonly actions: Action[] = [];
  readonly messageId = "msg-1";
  readonly redelivered = false;
  readonly content: Buffer;
  retryConfirmed = true;

  constructor(content: Buffer = body()) {
    this.content = content;
  }

  ack(): void {
    this.actions.push("ack");
  }
  deadLetter(): void {
    this.actions.push("dead_letter");
  }
  requeue(): void {
    this.actions.push("requeue");
  }
  async publishRetry(tier: ReviewRetryTier): Promise<boolean> {
    this.actions.push(`retry:${tier.queue}`);
    return this.retryConfirmed;
  }
}

function claimed(attempts = 1): ClaimResult {
  return { kind: "claimed", attempts, movieVersion: 1, movie: MOVIE, leaseToken: LEASE_TOKEN };
}

/** Records the call order across repository, generator and delivery. */
function setup(options: {
  claim?: ClaimResult | Error;
  generate?: { review: string; model: string } | Error;
  complete?: boolean | Error;
  release?: boolean | Error;
  fail?: boolean | Error;
} = {}) {
  const calls: string[] = [];
  const answer = <T>(name: string, value: T | Error | undefined, fallback: T) => {
    calls.push(name);
    const resolved = value ?? fallback;
    return resolved instanceof Error ? Promise.reject(resolved) : Promise.resolve(resolved);
  };

  const jobs: ReviewJobProcessing = {
    claim: vi.fn(() => answer("claim", options.claim, claimed())),
    complete: vi.fn(() => answer("complete", options.complete, true)),
    release: vi.fn(() => answer("release", options.release, true)),
    fail: vi.fn(() => answer("fail", options.fail, true)),
  };
  const generator: ReviewGenerator = {
    generate: vi.fn(() =>
      answer("generate", options.generate, { review: "A review.", model: "stub" }),
    ),
  };

  const delivery = new FakeDelivery();
  const run = async (target: FakeDelivery = delivery) => {
    const outcome = await handleReviewDelivery(target, {
      jobs,
      generator,
      workerId: WORKER_ID,
      logger,
    });
    return { outcome, actions: target.actions, calls };
  };

  return { jobs, generator, delivery, run };
}

const [tier10s, tier30s, tier2m, tier5m] = REVIEW_RETRY_TIERS;

describe("handleReviewDelivery", () => {
  it("generates, stores the review, then acks", async () => {
    const { run, jobs, generator } = setup();

    const { outcome, actions, calls } = await run();

    expect(outcome).toBe("succeeded");
    expect(actions).toEqual(["ack"]);
    expect(calls).toEqual(["claim", "generate", "complete"]);
    expect(jobs.claim).toHaveBeenCalledWith(JOB_ID, {
      workerId: WORKER_ID,
      leaseSeconds: REVIEW_CONSUMER_SETTINGS.leaseSeconds,
      maxAttempts: REVIEW_CONSUMER_SETTINGS.maxAttempts,
    });
    expect(generator.generate).toHaveBeenCalledWith(
      expect.objectContaining({ ...MOVIE, signal: expect.any(AbortSignal) }),
    );
    // The claim's token, not the process-wide worker id (two deliveries of one job in one
    // process must not pass each other's lease guard).
    expect(jobs.complete).toHaveBeenCalledWith(JOB_ID, LEASE_TOKEN, {
      review: "A review.",
      model: "stub",
    });
  });

  it.each([
    ["not JSON", Buffer.from("{oops")],
    ["wrong schemaVersion", body({ schemaVersion: 2 })],
    ["jobId not a uuid", body({ jobId: "job-1" })],
    ["movieVersion 0", body({ movieVersion: 0 })],
  ])("dead-letters an invalid message (%s) without touching the DB", async (_case, content) => {
    const { run, jobs } = setup();

    const { outcome, actions } = await run(new FakeDelivery(content));

    expect(outcome).toBe("invalid_message");
    expect(actions).toEqual(["dead_letter"]);
    expect(jobs.claim).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", { kind: "missing" }, "job_missing"],
    ["terminal", { kind: "terminal", status: "succeeded" }, "duplicate"],
    ["superseded", { kind: "superseded", jobVersion: 1, currentVersion: 2 }, "superseded"],
  ] as const)("acks without generating when the job is %s", async (_case, claim, expected) => {
    const { run, generator } = setup({ claim });

    const { outcome, actions } = await run();

    expect(outcome).toBe(expected);
    expect(actions).toEqual(["ack"]);
    expect(generator.generate).not.toHaveBeenCalled();
  });

  it("dead-letters when attempts were exhausted before this delivery", async () => {
    const { run, generator } = setup({ claim: { kind: "exhausted", attempts: 5 } });

    const { outcome, actions } = await run();

    expect(outcome).toBe("exhausted");
    expect(actions).toEqual(["dead_letter"]);
    expect(generator.generate).not.toHaveBeenCalled();
  });

  it("defers a job held under a live lease to the 30 s retry queue, then acks", async () => {
    const { run, generator } = setup({ claim: { kind: "lease_busy", attempts: 2 } });

    const { outcome, actions } = await run();

    expect(outcome).toBe("lease_busy");
    // Retry copy confirmed BEFORE the original is acked: a crash in between duplicates,
    // never loses.
    expect(actions).toEqual([`retry:${tier30s?.queue}`, "ack"]);
    expect(generator.generate).not.toHaveBeenCalled();
  });

  it.each([
    [1, tier10s],
    [2, tier30s],
    [3, tier2m],
    [4, tier5m],
  ])(
    "transient error on attempt %i → release the job, retry copy in %o, then ack",
    async (attempts, tier) => {
      const { run } = setup({
        claim: claimed(attempts),
        generate: new RagUpstreamError("generate", "503", { retryable: true }),
      });

      const { outcome, actions, calls } = await run();

      expect(outcome).toBe("retry_scheduled");
      expect(calls).toEqual(["claim", "generate", "release"]);
      expect(actions).toEqual([`retry:${tier?.queue}`, "ack"]);
    },
  );

  it("treats an unknown error (e.g. deadline abort) as transient", async () => {
    const abort = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const { run } = setup({ generate: abort });

    const { outcome, calls } = await run();

    expect(outcome).toBe("retry_scheduled");
    expect(calls).toEqual(["claim", "generate", "release"]);
  });

  it("marks the job failed and dead-letters after a transient error on the last attempt", async () => {
    const { run, jobs } = setup({
      claim: claimed(REVIEW_CONSUMER_SETTINGS.maxAttempts),
      generate: new RagUpstreamError("generate", "503", { retryable: true }),
    });

    const { outcome, actions } = await run();

    expect(outcome).toBe("exhausted");
    expect(jobs.release).not.toHaveBeenCalled();
    expect(jobs.fail).toHaveBeenCalledWith(JOB_ID, LEASE_TOKEN, "503");
    expect(actions).toEqual(["dead_letter"]);
  });

  it.each([
    ["RagInputError", new RagInputError("Movie title cannot be empty")],
    ["non-retryable upstream", new RagUpstreamError("generate", "bad", { retryable: false })],
  ])("permanent error (%s) → failed + DLQ on the first attempt", async (_case, error) => {
    const { run, jobs } = setup({ generate: error });

    const { outcome, actions } = await run();

    expect(outcome).toBe("failed");
    expect(jobs.fail).toHaveBeenCalledWith(JOB_ID, LEASE_TOKEN, error.message);
    expect(actions).toEqual(["dead_letter"]);
  });

  it.each([
    ["complete", { complete: false }],
    ["release", { generate: new Error("503"), release: false }],
    ["fail", { generate: new RagInputError("bad"), fail: false }],
  ] as const)(
    "acks without claiming an outcome when %s finds the lease lost",
    async (_case, options) => {
      const { run } = setup(options);

      const { outcome, actions } = await run();

      expect(outcome).toBe("lease_lost");
      expect(actions).toEqual(["ack"]);
    },
  );

  it("PostgreSQL down at claim → 10 s retry copy, no attempt counted, then ack", async () => {
    const { run, generator } = setup({ claim: new Error("connect ECONNREFUSED") });

    const { outcome, actions } = await run();

    expect(outcome).toBe("infrastructure_retry");
    expect(actions).toEqual([`retry:${tier10s?.queue}`, "ack"]);
    expect(generator.generate).not.toHaveBeenCalled();
  });

  it("PostgreSQL down while storing the result → retry copy (lease takes it over later)", async () => {
    const { run } = setup({ complete: new Error("connection terminated") });

    const { outcome, actions } = await run();

    expect(outcome).toBe("infrastructure_retry");
    expect(actions).toEqual([`retry:${tier10s?.queue}`, "ack"]);
  });

  it.each([
    ["release", { generate: new Error("503"), release: new Error("connection terminated") }],
    ["fail", { generate: new RagInputError("bad"), fail: new Error("connection terminated") }],
  ] as const)(
    "PostgreSQL down while recording a generation error (%s) → retry copy, then ack",
    async (_case, options) => {
      // Guards the `return await handleGenerationError(...)`: without the await the rejection
      // would skip the outer catch and end in the consumer's handler-threw fallback.
      const { run } = setup(options);

      const { outcome, actions } = await run();

      expect(outcome).toBe("infrastructure_retry");
      expect(actions).toEqual([`retry:${tier10s?.queue}`, "ack"]);
    },
  );

  it("requeues (and does not ack) only after a pause when the retry copy is not confirmed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const { run, delivery } = setup({ generate: new Error("503") });
      delivery.retryConfirmed = false;

      const pending = run();
      // Explicit requeues don't count towards the delivery-limit: no pause = hot loop.
      await vi.advanceTimersByTimeAsync(REVIEW_CONSUMER_SETTINGS.requeueDelayMs - 1);
      expect(delivery.actions).toEqual([`retry:${tier10s?.queue}`]);

      await vi.advanceTimersByTimeAsync(1);
      const { outcome, actions } = await pending;

      expect(outcome).toBe("requeued");
      expect(actions).toEqual([`retry:${tier10s?.queue}`, "requeue"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
