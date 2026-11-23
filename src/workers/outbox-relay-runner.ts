import { setTimeout as sleep } from "node:timers/promises";
import { runOutboxRelayBatch, type RelayChannel } from "./outbox-relay.ts";
import { logger as rootLogger } from "../infrastructure/logger.ts";

const logger = rootLogger.child({ component: "outbox-relay" });

const pollIntervalMs = 1_000;

let stopping = false;
let runnerPromise: Promise<void> | null = null;

async function runLoop(getChannel: () => RelayChannel | null): Promise<void> {
  while (!stopping) {
    try {
      // Channel read per batch: after a reconnect the holder has a new one.
      const count = await runOutboxRelayBatch(getChannel());
      if (count === 0) await sleep(pollIntervalMs);
    } catch (error) {
      logger.error({ err: error }, "Outbox relay batch failed");
      await sleep(pollIntervalMs);
    }
  }
}

export function startOutboxRelay(getChannel: () => RelayChannel | null): void {
  if (runnerPromise !== null) return;

  stopping = false;
  runnerPromise = runLoop(getChannel);
}

/** Stops after the current batch (its confirms or deadline) has finished. */
export async function stopOutboxRelay(): Promise<void> {
  stopping = true;

  if (runnerPromise !== null) {
    await runnerPromise;
    runnerPromise = null;
  }
}
