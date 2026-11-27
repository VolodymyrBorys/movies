import { describe, expect, it } from "vitest";
import { loadReviewGeneratorConfig } from "./review-generator.ts";

describe("loadReviewGeneratorConfig", () => {
  it("defaults to the stub", () => {
    expect(loadReviewGeneratorConfig({})).toEqual({ kind: "stub" });
  });

  it("ignores fake settings when the stub is selected", () => {
    expect(
      loadReviewGeneratorConfig({ REVIEW_GENERATOR: "stub", REVIEW_FAKE_FAILURE_RATE: "1" }),
    ).toEqual({ kind: "stub" });
  });

  it("reads the fake settings with defaults", () => {
    expect(loadReviewGeneratorConfig({ REVIEW_GENERATOR: "fake" })).toEqual({
      kind: "fake",
      latencyMs: 2_000,
      failureRate: 0,
    });
    expect(
      loadReviewGeneratorConfig({
        REVIEW_GENERATOR: "fake",
        REVIEW_FAKE_LATENCY_MS: "50",
        REVIEW_FAKE_FAILURE_RATE: "0.25",
      }),
    ).toEqual({ kind: "fake", latencyMs: 50, failureRate: 0.25 });
  });

  it.each([
    ["unknown generator", { REVIEW_GENERATOR: "gemini" }, /REVIEW_GENERATOR/],
    ["failure rate > 1", { REVIEW_GENERATOR: "fake", REVIEW_FAKE_FAILURE_RATE: "1.5" }, /REVIEW_FAKE_FAILURE_RATE/],
    ["negative latency", { REVIEW_GENERATOR: "fake", REVIEW_FAKE_LATENCY_MS: "-1" }, /REVIEW_FAKE_LATENCY_MS/],
    ["latency not a number", { REVIEW_GENERATOR: "fake", REVIEW_FAKE_LATENCY_MS: "abc" }, /REVIEW_FAKE_LATENCY_MS/],
  ])("fails fast on %s", (_case, env, message) => {
    expect(() => loadReviewGeneratorConfig(env)).toThrow(message);
  });

  it("refuses the fake generator in production", () => {
    expect(() =>
      loadReviewGeneratorConfig({ REVIEW_GENERATOR: "fake", NODE_ENV: "production" }),
    ).toThrow(/dev-only/);
  });
});
