import { describe, expect, it } from "vitest";
import { RagNotConfiguredError } from "../../config/rag.ts";
import { AppError, badRequest } from "../../utils/errors.ts";
import {
  ClientDisconnectedError,
  RequestDeadlineExceededError,
  ServerShuttingDownError,
} from "../../utils/request-signal.ts";
import { toRagHttpError } from "./rag-http-errors.ts";
import { RagInputError, RagUpstreamError } from "./rag.errors.ts";

function abortedWith(reason: unknown): AbortSignal {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
}

const abortError = Object.assign(new Error("This operation was aborted"), {
  name: "AbortError",
});

const upstream = (retryable: boolean) =>
  new RagUpstreamError("generate", "generate failed: HTTP 503 <raw body>", {
    retryable,
  });

describe("toRagHttpError", () => {
  it.each([
    ["deadline", new RequestDeadlineExceededError(30_000), 504, "DEADLINE_EXCEEDED"],
    ["client disconnect", new ClientDisconnectedError(), 499, "CLIENT_CLOSED_REQUEST"],
    ["shutdown", new ServerShuttingDownError(), 503, "SERVICE_SHUTTING_DOWN"],
  ])("maps an aborted signal (%s) by its reason, not by the SDK error", (_name, reason, status, code) => {
    // The SDK lost our reason and threw a bare AbortError — the signal still knows why.
    const error = toRagHttpError(abortError, abortedWith(reason));

    expect(error).toMatchObject({ statusCode: status, code, cause: abortError });
  });

  it("lets the deadline win even when the SDK error looks like an upstream failure", () => {
    const error = toRagHttpError(
      upstream(true),
      abortedWith(new RequestDeadlineExceededError(30_000)),
    );

    expect(error.statusCode).toBe(504);
  });

  it("ignores a signal that did not abort", () => {
    const error = toRagHttpError(upstream(true), new AbortController().signal);

    expect(error.statusCode).toBe(503);
  });

  it.each([
    ["RagInputError", new RagInputError("Question cannot be empty"), 400, "VALIDATION_FAILED"],
    ["RagNotConfiguredError", new RagNotConfiguredError(), 503, "RAG_NOT_CONFIGURED"],
    ["retryable upstream", upstream(true), 503, "DEPENDENCY_UNAVAILABLE"],
    ["non-retryable upstream", upstream(false), 502, "DEPENDENCY_FAILED"],
    ["unknown error", new Error("boom"), 500, "INTERNAL_ERROR"],
    ["non-Error value", "boom", 500, "INTERNAL_ERROR"],
  ])("maps %s", (_name, cause, status, code) => {
    const error = toRagHttpError(cause);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ statusCode: status, code, cause });
  });

  it("exposes input messages but never upstream text", () => {
    expect(toRagHttpError(new RagInputError("Question cannot be empty")).message).toBe(
      "Question cannot be empty",
    );

    const error = toRagHttpError(upstream(true));
    expect(error.message).toBe("Upstream dependency unavailable");
    expect(error.message).not.toContain("raw body");
  });

  it("does not expose the missing env variable names to clients", () => {
    expect(toRagHttpError(new RagNotConfiguredError()).message).toBe(
      "RAG is not configured",
    );
  });

  it("marks transient failures as retryable", () => {
    expect(toRagHttpError(upstream(true)).retryable).toBe(true);
    expect(toRagHttpError(upstream(false)).retryable).toBe(false);
    expect(
      toRagHttpError(abortError, abortedWith(new RequestDeadlineExceededError(1))).retryable,
    ).toBe(true);
  });

  it("passes an existing AppError through", () => {
    const error = badRequest();
    expect(toRagHttpError(error)).toBe(error);
  });
});
