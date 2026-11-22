import { ServerShuttingDownError } from "../utils/request-signal.ts";

// Process-wide signal for long-running request work (RAG upstream calls).
// Aborted by server.ts right before server.close(), NOT at markShuttingDown(): requests that
// still arrive during SHUTDOWN_DELAY_MS (load balancer not yet updated) must be served normally.
// After that, in-flight work is aborted so server.close() finishes before the 15 s forced exit
// instead of the client getting a connection reset.
const controller = new AbortController();

export const shutdownSignal: AbortSignal = controller.signal;

export function abortInFlightRequests(): void {
  controller.abort(new ServerShuttingDownError());
}
