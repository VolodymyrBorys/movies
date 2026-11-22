import {
  ragStageDuration,
  type RagStageOperation,
} from "../../infrastructure/metrics.ts";
import type { RagStage } from "./rag.errors.ts";

/**
 * Runs one pipeline stage and records its wall time. Outcome "cancelled" when the
 * caller's signal aborted (the stage itself didn't fail), "error" otherwise.
 */
export async function timeStage<T>(
  labels: { stage: RagStage; operation: RagStageOperation },
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const end = ragStageDuration.startTimer(labels);

  try {
    const result = await run();
    end({ outcome: "ok" });
    return result;
  } catch (error: unknown) {
    end({ outcome: signal?.aborted ? "cancelled" : "error" });
    throw error;
  }
}
