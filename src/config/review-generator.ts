import { z } from "zod";

// Review generator selection for the worker process (P5.4). Separate from env.ts: only the
// worker reads it. Like env.ts, this module does NOT load `.env`.
//
//   REVIEW_GENERATOR             stub (default) | fake
//   REVIEW_FAKE_LATENCY_MS       fake only: delay per generation, default 2000
//   REVIEW_FAKE_FAILURE_RATE     fake only: share of transient 503 failures (0..1), default 0
//
// No value here turns on real Gemini calls: "stub" runs the real review service with the
// Gemini stub (src/modules/rag/gemini-stub.ts); real calls need `{ geminiStub: false }` in code.

const ReviewGeneratorEnvSchema = z.object({
  REVIEW_GENERATOR: z.enum(["stub", "fake"]).default("stub"),
  REVIEW_FAKE_LATENCY_MS: z.coerce.number().int().min(0).max(120_000).default(2_000),
  REVIEW_FAKE_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
});

export type ReviewGeneratorConfig =
  | { readonly kind: "stub" }
  | { readonly kind: "fake"; readonly latencyMs: number; readonly failureRate: number };

export function loadReviewGeneratorConfig(source: NodeJS.ProcessEnv): ReviewGeneratorConfig {
  const result = ReviewGeneratorEnvSchema.safeParse(source);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid review generator configuration: ${details}`);
  }

  const env = result.data;

  if (env.REVIEW_GENERATOR === "stub") {
    return Object.freeze({ kind: "stub" });
  }

  // LAB: the fake generator exists for local exercises (P5.7) only.
  if (source.NODE_ENV === "production") {
    throw new Error("Invalid review generator configuration: REVIEW_GENERATOR=fake is dev-only");
  }

  return Object.freeze({
    kind: "fake",
    latencyMs: env.REVIEW_FAKE_LATENCY_MS,
    failureRate: env.REVIEW_FAKE_FAILURE_RATE,
  });
}
