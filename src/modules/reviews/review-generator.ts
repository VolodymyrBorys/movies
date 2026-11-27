import { setTimeout as sleep } from "node:timers/promises";
import type { ReviewGeneratorConfig } from "../../config/review-generator.ts";
import {
  movieReviewGenerationService,
  type MovieReviewInput,
  type MovieReviewResult,
} from "../rag/generation/movie-review-generation.service.ts";
import { RagUpstreamError } from "../rag/rag.errors.ts";

// Seam between the review consumer and whatever writes the review (P5.4).

export interface ReviewGenerator {
  /** Rejects with RagUpstreamError (retryable or not), RagInputError, or an abort error. */
  generate(input: MovieReviewInput): Promise<MovieReviewResult>;
}

export const FAKE_REVIEW_MODEL = "fake";

export interface FakeReviewGeneratorOptions {
  latencyMs: number;
  /** 0..1: share of calls that fail like a Gemini 503 (retryable). */
  failureRate: number;
  /** Test seam. */
  random?: () => number;
}

// LAB: dev-only stand-in for a slow, flaky upstream (REVIEW_GENERATOR=fake) — lets the retry,
// DLQ and prefetch exercises (P5.7) run without billable calls. Production has no such mode.
export class FakeReviewGenerator implements ReviewGenerator {
  private readonly latencyMs: number;
  private readonly failureRate: number;
  private readonly random: () => number;

  constructor(options: FakeReviewGeneratorOptions) {
    this.latencyMs = options.latencyMs;
    this.failureRate = options.failureRate;
    this.random = options.random ?? Math.random;
  }

  async generate(input: MovieReviewInput): Promise<MovieReviewResult> {
    // Rejects with the abort reason when the caller's deadline fires mid-"call".
    await sleep(this.latencyMs, undefined, input.signal ? { signal: input.signal } : {});

    if (this.random() < this.failureRate) {
      throw new RagUpstreamError("generate", "Fake Gemini 503 (REVIEW_GENERATOR=fake)", {
        retryable: true,
      });
    }

    return {
      review: `Fake review of "${input.title}" (${input.releaseYear}).`,
      model: FAKE_REVIEW_MODEL,
    };
  }
}

export function createReviewGenerator(config: ReviewGeneratorConfig): ReviewGenerator {
  if (config.kind === "fake") {
    return new FakeReviewGenerator({
      latencyMs: config.latencyMs,
      failureRate: config.failureRate,
    });
  }
  // Real review service with the Gemini stub on (default of MovieReviewGenerationService).
  return movieReviewGenerationService;
}
