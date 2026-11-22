import { RagNotConfiguredError } from "../../config/rag.ts";
import { AppError, ErrorCode, internalError } from "../../utils/errors.ts";
import {
  ClientDisconnectedError,
  RequestDeadlineExceededError,
  ServerShuttingDownError,
} from "../../utils/request-signal.ts";
import { RagInputError, RagUpstreamError } from "./rag.errors.ts";

// Maps RAG failures to HTTP errors for errorHandler. Client-facing messages are fixed
// strings (never upstream text: it can contain response bodies); the original error is
// kept as `cause` and only logged.
//
// | Failure                                   | Status | Code                    |
// | ----------------------------------------- | ------ | ----------------------- |
// | signal: deadline                          | 504    | DEADLINE_EXCEEDED       |
// | signal: client disconnected               | 499    | CLIENT_CLOSED_REQUEST   |
// | signal: server shutting down              | 503    | SERVICE_SHUTTING_DOWN   |
// | RagInputError                             | 400    | VALIDATION_FAILED       |
// | RagNotConfiguredError                     | 503    | RAG_NOT_CONFIGURED      |
// | RagUpstreamError, retryable               | 503    | DEPENDENCY_UNAVAILABLE  |
// | RagUpstreamError, not retryable           | 502    | DEPENDENCY_FAILED       |
// | anything else                             | 500    | INTERNAL_ERROR          |
//
// 499 (nginx convention) is never seen by the client — the connection is gone; it keeps
// the log line honest instead of a misleading 5xx.

function fail(
  statusCode: number,
  code: string,
  message: string,
  cause: unknown,
  retryable = false,
): AppError {
  return new AppError(message, {
    statusCode,
    code,
    cause,
    retryable,
    expose: true,
  });
}

/**
 * The request signal is checked first: once it aborted, the SDK error (often a bare
 * AbortError) says nothing about why — the signal's reason does.
 */
export function toRagHttpError(error: unknown, signal?: AbortSignal): AppError {
  if (signal?.aborted) {
    const reason: unknown = signal.reason;

    if (reason instanceof RequestDeadlineExceededError) {
      return fail(504, ErrorCode.DEADLINE_EXCEEDED, "Request deadline exceeded", error, true);
    }
    if (reason instanceof ClientDisconnectedError) {
      return fail(499, "CLIENT_CLOSED_REQUEST", "Client closed request", error);
    }
    if (reason instanceof ServerShuttingDownError) {
      return fail(503, "SERVICE_SHUTTING_DOWN", "Server is shutting down", error, true);
    }
  }

  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof RagInputError) {
    // Our own messages (e.g. "Question cannot be empty"): safe to expose.
    return fail(400, ErrorCode.VALIDATION_FAILED, error.message, error);
  }

  if (error instanceof RagNotConfiguredError) {
    return fail(503, "RAG_NOT_CONFIGURED", "RAG is not configured", error);
  }

  if (error instanceof RagUpstreamError) {
    return error.retryable
      ? fail(503, ErrorCode.DEPENDENCY_UNAVAILABLE, "Upstream dependency unavailable", error, true)
      : fail(502, "DEPENDENCY_FAILED", "Upstream dependency failed", error);
  }

  return internalError(error);
}
