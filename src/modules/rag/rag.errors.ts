import { RagNotConfiguredError } from "../../config/rag.ts";

// Domain errors of the RAG pipeline. Not coupled to HTTP: the mapping to status codes
// lives in rag-http-errors.ts, so the same services can back an Agent tool (P8).
//
// Cancellation is NOT an error type here: when the caller's signal aborts, services
// rethrow whatever the SDK threw (often a bare AbortError) and the caller decides by
// `signal.reason` (deadline vs client disconnect vs shutdown).

export type RagStage = "embed" | "search" | "generate";

/** Invalid input that reached a service (normally stopped earlier by Zod). */
export class RagInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RagInputError";
  }
}

/** Gemini / Qdrant failed or returned something unusable at a given stage. */
export class RagUpstreamError extends Error {
  readonly stage: RagStage;
  /** true: transient (5xx, 429, network, timeout) — worth retrying later. */
  readonly retryable: boolean;

  constructor(
    stage: RagStage,
    message: string,
    options: { retryable: boolean; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = "RagUpstreamError";
    this.stage = stage;
    this.retryable = options.retryable;
  }
}

const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

// Client-side timeouts / rate limiting of @qdrant/js-client-rest 1.20 (no status field).
const TRANSIENT_ERROR_NAMES = new Set([
  "QdrantClientTimeoutError",
  "QdrantClientResourceExhaustedError",
]);

/** HTTP status of an SDK error: Gemini ApiError `status`, Qdrant ApiError `status`, or `code`. */
export function getHttpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const candidate = error as {
    status?: unknown;
    code?: unknown;
    response?: { status?: unknown };
  };

  const status = candidate.status ?? candidate.response?.status;

  if (typeof status === "number") {
    return status;
  }

  if (typeof candidate.code === "number") {
    return candidate.code;
  }

  return undefined;
}

export function isTransientUpstreamError(error: unknown): boolean {
  const status = getHttpStatus(error);

  if (status !== undefined) {
    return TRANSIENT_STATUSES.has(status);
  }

  if (error instanceof Error && TRANSIENT_ERROR_NAMES.has(error.name)) {
    return true;
  }

  // undici's fetch rejects with TypeError("fetch failed") on DNS/connect/reset errors.
  return error instanceof TypeError;
}

/**
 * Converts an error thrown at a stage boundary into a RagUpstreamError.
 * Left untouched: cancellation by the caller (decided by `signal.reason`) and errors
 * that are already typed (RagInputError, RagUpstreamError, RagNotConfiguredError, ...).
 */
export function toUpstreamError(
  stage: RagStage,
  error: unknown,
  signal?: AbortSignal,
): unknown {
  if (signal?.aborted) {
    return error;
  }

  if (
    error instanceof RagUpstreamError ||
    error instanceof RagInputError ||
    error instanceof RagNotConfiguredError
  ) {
    return error;
  }

  const detail = error instanceof Error ? error.message : String(error);

  return new RagUpstreamError(stage, `${stage} failed: ${detail}`, {
    retryable: isTransientUpstreamError(error),
    cause: error,
  });
}
