import { describe, expect, it } from "vitest";
import { ragStageDuration } from "../../infrastructure/metrics.ts";
import { metricValue } from "../../test/metric-value.ts";
import { timeStage } from "./rag-metrics.ts";

const count = (stage: string, outcome: string) =>
  metricValue(ragStageDuration, { stage, outcome }, "_count");

describe("timeStage", () => {
  it("pre-creates every stage/outcome series at 0", async () => {
    const { values } = await ragStageDuration.get();
    const series = new Set(
      values
        .filter((v) => (v as { metricName?: string }).metricName?.endsWith("_count"))
        .map((v) => `${v.labels["stage"]}/${v.labels["outcome"]}`),
    );

    for (const stage of ["embed", "search", "generate"]) {
      for (const outcome of ["ok", "error", "cancelled"]) {
        expect(series).toContain(`${stage}/${outcome}`);
      }
    }
  });

  it("records ok and returns the result", async () => {
    const before = await count("embed", "ok");

    await expect(timeStage("embed", undefined, async () => 42)).resolves.toBe(42);

    expect(await count("embed", "ok")).toBe(before + 1);
  });

  it("records error and rethrows the same error", async () => {
    const before = await count("search", "error");
    const error = new Error("boom");

    await expect(
      timeStage("search", undefined, () => Promise.reject(error)),
    ).rejects.toBe(error);

    expect(await count("search", "error")).toBe(before + 1);
  });

  it("records cancelled when the caller's signal aborted", async () => {
    const controller = new AbortController();
    const beforeCancelled = await count("generate", "cancelled");
    const beforeError = await count("generate", "error");

    await expect(
      timeStage("generate", controller.signal, async () => {
        controller.abort();
        throw new Error("aborted");
      }),
    ).rejects.toThrow("aborted");

    expect(await count("generate", "cancelled")).toBe(beforeCancelled + 1);
    expect(await count("generate", "error")).toBe(beforeError);
  });
});
