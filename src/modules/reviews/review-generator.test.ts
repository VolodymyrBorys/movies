import { describe, expect, it, vi } from "vitest";

// The review service's import chain reaches the logger, which needs PG_* otherwise.
vi.mock("../../infrastructure/logger.ts", async () => {
  const { pino } = await import("pino");
  return { logger: pino({ level: "silent" }) };
});

import { movieReviewGenerationService } from "../rag/generation/movie-review-generation.service.ts";
import { RagUpstreamError } from "../rag/rag.errors.ts";
import {
  createReviewGenerator,
  FAKE_REVIEW_MODEL,
  FakeReviewGenerator,
} from "./review-generator.ts";

const MOVIE = { title: "Heat", description: null, releaseYear: 1995, durationMinutes: 170 };

describe("FakeReviewGenerator", () => {
  it("returns a fake review when the draw is above the failure rate", async () => {
    const generator = new FakeReviewGenerator({ latencyMs: 0, failureRate: 0.5, random: () => 0.9 });

    await expect(generator.generate(MOVIE)).resolves.toEqual({
      review: 'Fake review of "Heat" (1995).',
      model: FAKE_REVIEW_MODEL,
    });
  });

  it("fails like a retryable Gemini 503 when the draw is below the failure rate", async () => {
    const generator = new FakeReviewGenerator({ latencyMs: 0, failureRate: 0.5, random: () => 0.1 });

    const error = await generator.generate(MOVIE).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RagUpstreamError);
    expect((error as RagUpstreamError).retryable).toBe(true);
  });

  it("rejects when the caller's signal aborts during the latency", async () => {
    const generator = new FakeReviewGenerator({ latencyMs: 10_000, failureRate: 0 });
    const controller = new AbortController();

    const pending = generator.generate({ ...MOVIE, signal: controller.signal });
    controller.abort(new Error("deadline"));

    await expect(pending).rejects.toThrow();
  });
});

describe("createReviewGenerator", () => {
  it("stub → the real review service (Gemini stub on)", () => {
    expect(createReviewGenerator({ kind: "stub" })).toBe(movieReviewGenerationService);
  });

  it("fake → FakeReviewGenerator", () => {
    expect(
      createReviewGenerator({ kind: "fake", latencyMs: 0, failureRate: 0 }),
    ).toBeInstanceOf(FakeReviewGenerator);
  });
});
