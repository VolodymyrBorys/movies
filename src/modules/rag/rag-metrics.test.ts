import { describe, expect, it } from "vitest";
import { ragStageDuration } from "../../infrastructure/metrics.ts";
import { metricValue } from "../../test/metric-value.ts";
import { timeStage } from "./rag-metrics.ts";

const count = (stage: string, operation: string, outcome: string) =>
  metricValue(ragStageDuration, { stage, operation, outcome }, "_count");

describe("timeStage", () => {
  it("pre-creates exactly the existing stage/operation series for every outcome", async () => {
    const { values } = await ragStageDuration.get();
    const series = new Set(
      values
        .filter((v) => (v as { metricName?: string }).metricName?.endsWith("_count"))
        .map((v) => `${v.labels["stage"]}/${v.labels["operation"]}/${v.labels["outcome"]}`),
    );

    const expected = [
      ["embed", "retrieval"],
      ["search", "retrieval"],
      ["generate", "answer"],
      ["generate", "review"],
    ].flatMap(([stage, operation]) =>
      ["ok", "error", "cancelled"].map((outcome) => `${stage}/${operation}/${outcome}`),
    );
    expect([...series].sort()).toEqual(expected.sort());
  });

  it("records ok and returns the result", async () => {
    const before = await count("embed", "retrieval", "ok");

    await expect(
      timeStage({ stage: "embed", operation: "retrieval" }, undefined, async () => 42),
    ).resolves.toBe(42);

    expect(await count("embed", "retrieval", "ok")).toBe(before + 1);
  });

  it("records error and rethrows the same error", async () => {
    const before = await count("search", "retrieval", "error");
    const error = new Error("boom");

    await expect(
      timeStage({ stage: "search", operation: "retrieval" }, undefined, () =>
        Promise.reject(error),
      ),
    ).rejects.toBe(error);

    expect(await count("search", "retrieval", "error")).toBe(before + 1);
  });

  it("records cancelled when the caller's signal aborted", async () => {
    const controller = new AbortController();
    const beforeCancelled = await count("generate", "review", "cancelled");
    const beforeError = await count("generate", "review", "error");

    await expect(
      timeStage({ stage: "generate", operation: "review" }, controller.signal, async () => {
        controller.abort();
        throw new Error("aborted");
      }),
    ).rejects.toThrow("aborted");

    expect(await count("generate", "review", "cancelled")).toBe(beforeCancelled + 1);
    expect(await count("generate", "review", "error")).toBe(beforeError);
  });
});
