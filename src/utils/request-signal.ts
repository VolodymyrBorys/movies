// Request-scoped cancellation for slow handlers (RAG: embed → search → generate).
//
// One AbortSignal per request, aborted by whichever happens first:
//   - deadline:   the request's total time budget ran out → 504
//   - disconnect: the client closed the connection before the response finished → no one to answer
//   - shutdown:   the server is closing and won't wait for slow upstream calls → 503
// `signal.reason` is one of the classes below, so callers decide by the reason and not by the
// error the SDK threw (Gemini SDK aborts with its own controller and loses our reason).
//
// LAB: simplified — production would also propagate the remaining deadline to upstreams
// (e.g. gRPC deadline / header) instead of only aborting locally; aborting is client-side
// only and Gemini may still bill a request already sent.

export class RequestDeadlineExceededError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Request deadline of ${timeoutMs}ms exceeded`);
    this.name = "RequestDeadlineExceededError";
    this.timeoutMs = timeoutMs;
  }
}

export class ClientDisconnectedError extends Error {
  constructor() {
    super("Client closed the connection before the response was sent");
    this.name = "ClientDisconnectedError";
  }
}

export class ServerShuttingDownError extends Error {
  constructor() {
    super("Server is shutting down");
    this.name = "ServerShuttingDownError";
  }
}

/** The part of http.ServerResponse this helper needs (keeps tests free of real sockets). */
export interface ResponseLike {
  readonly writableFinished: boolean;
  once(event: "close", listener: () => void): unknown;
}

export interface RequestSignalOptions {
  timeoutMs: number;
  /** Process-wide signal aborted when the server starts closing (see shutdown-signal.ts). */
  shutdownSignal?: AbortSignal;
}

export function createRequestSignal(
  res: ResponseLike,
  { timeoutMs, shutdownSignal }: RequestSignalOptions,
): AbortSignal {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive integer");
  }

  const controller = new AbortController();

  // abort() is a no-op once aborted: the first reason wins.
  const timer = setTimeout(() => {
    controller.abort(new RequestDeadlineExceededError(timeoutMs));
  }, timeoutMs);

  const onShutdown = () => {
    controller.abort(new ServerShuttingDownError());
  };

  // 'close' fires both after a completed response and when the client goes away;
  // writableFinished tells them apart. It is also the cleanup point, so callers need
  // no dispose(): no timer or listener on the long-lived shutdown signal outlives the request.
  res.once("close", () => {
    if (!res.writableFinished) {
      controller.abort(new ClientDisconnectedError());
    }
    clearTimeout(timer);
    shutdownSignal?.removeEventListener("abort", onShutdown);
  });

  if (shutdownSignal?.aborted) {
    onShutdown();
  } else {
    shutdownSignal?.addEventListener("abort", onShutdown, { once: true });
  }

  return controller.signal;
}
