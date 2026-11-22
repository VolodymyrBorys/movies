import { describe, expect, it } from "vitest";
import { RagNotConfiguredError } from "../../config/rag.ts";
import {
  isTransientUpstreamError,
  RagInputError,
  RagUpstreamError,
  toUpstreamError,
} from "./rag.errors.ts";

const withStatus = (status: number) =>
  Object.assign(new Error(`HTTP ${status}`), { status });

const named = (name: string) => Object.assign(new Error(name), { name });

describe("isTransientUpstreamError", () => {
  it.each([429, 500, 502, 503, 504])("treats HTTP %i as transient", (status) => {
    expect(isTransientUpstreamError(withStatus(status))).toBe(true);
  });

  it.each([400, 401, 403, 404, 408])("treats HTTP %i as permanent", (status) => {
    expect(isTransientUpstreamError(withStatus(status))).toBe(false);
  });

  it("reads a numeric `code` and `response.status` too", () => {
    expect(isTransientUpstreamError({ code: 503 })).toBe(true);
    expect(isTransientUpstreamError({ response: { status: 400 } })).toBe(false);
  });

  it.each(["QdrantClientTimeoutError", "QdrantClientResourceExhaustedError"])(
    "treats %s as transient",
    (name) => {
      expect(isTransientUpstreamError(named(name))).toBe(true);
    },
  );

  it("treats a fetch network failure (TypeError) as transient", () => {
    expect(isTransientUpstreamError(new TypeError("fetch failed"))).toBe(true);
  });

  it("treats an unknown error as permanent", () => {
    expect(isTransientUpstreamError(new Error("boom"))).toBe(false);
    expect(isTransientUpstreamError("boom")).toBe(false);
  });
});

describe("toUpstreamError", () => {
  it("wraps with stage, transient flag, cause and the upstream message", () => {
    const cause = withStatus(503);
    const error = toUpstreamError("search", cause);

    expect(error).toBeInstanceOf(RagUpstreamError);
    expect(error).toMatchObject({
      stage: "search",
      retryable: true,
      cause,
      message: "search failed: HTTP 503",
    });
  });

  it("returns the original error when the caller's signal aborted", () => {
    const controller = new AbortController();
    controller.abort();
    const cause = named("AbortError");

    expect(toUpstreamError("embed", cause, controller.signal)).toBe(cause);
  });

  it.each([
    ["RagUpstreamError", new RagUpstreamError("embed", "x", { retryable: true })],
    ["RagInputError", new RagInputError("x")],
    ["RagNotConfiguredError", new RagNotConfiguredError()],
  ])("does not re-wrap %s", (_name, error) => {
    expect(toUpstreamError("generate", error)).toBe(error);
  });
});
