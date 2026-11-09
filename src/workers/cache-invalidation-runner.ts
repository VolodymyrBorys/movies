import { runCacheInvalidationBatch } from "./cache-invalidation.ts";

const pollIntervalMs = 1_000;

let stopping = false;
let runnerPromise: Promise<void> | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runLoop(): Promise<void> {
  while (!stopping) {
    try {
      const count = await runCacheInvalidationBatch();

      if (count === 0) {
        await sleep(pollIntervalMs);
      }
    } catch (error) {
      console.error("Cache invalidation batch failed", error);
      await sleep(pollIntervalMs);
    }
  }
}

export function startCacheInvalidationWorker(): void {
  if (runnerPromise !== null) {
    return;
  }

  stopping = false;
  runnerPromise = runLoop();
}

export async function stopCacheInvalidationWorker(): Promise<void> {
  stopping = true;

  if (runnerPromise !== null) {
    await runnerPromise;
    runnerPromise = null;
  }
}
