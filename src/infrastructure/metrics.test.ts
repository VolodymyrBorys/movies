import { describe, expect, it } from "vitest";
import { metricsRegistry } from "./metrics.ts";

// Runs before any test resets the registry: checks the state right after import.
describe("metrics registry at startup", () => {
  it("pre-creates counter series at 0 so increase() sees the first event", async () => {
    const text = await metricsRegistry.metrics();

    for (const result of [
      "processed",
      "retry_scheduled",
      "dead_lettered",
      "reschedule_failed",
    ]) {
      expect(text).toContain(
        `outbox_events_total{result="${result}",service="movies-api"} 0`,
      );
    }
    for (const result of ["hit", "miss", "error"]) {
      expect(text).toContain(
        `cache_requests_total{cache="movies_list",result="${result}",service="movies-api"} 0`,
      );
    }
  });
});
