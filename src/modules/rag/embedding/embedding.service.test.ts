import { beforeEach, describe, expect, it, vi } from "vitest";

// Only the Gemini client (external I/O) is replaced.
const { embedContent } = vi.hoisted(() => ({ embedContent: vi.fn() }));

vi.mock("../../../infrastructure/gemini/gemini.client.ts", () => ({
  getGeminiClient: () => ({ models: { embedContent } }),
}));

const { EmbeddingService } = await import("./embedding.service.ts");
const { RagInputError, RagUpstreamError } = await import("../rag.errors.ts");
const { RagNotConfiguredError } = await import("../../../config/rag.ts");

type EmbedArgs = {
  model: string;
  contents: string;
  config: Record<string, unknown>;
};

const DIMENSIONS = 768;

function embeddingResponse(values: number[]) {
  return { embeddings: [{ values }] };
}

function lastConfig(): Record<string, unknown> {
  const [args] = embedContent.mock.lastCall as [EmbedArgs];
  return args.config;
}

describe("EmbeddingService", () => {
  // The real Gemini path (client mocked); the stub has its own describe below.
  const service = new EmbeddingService({ geminiStub: false });
  const vector = Array.from({ length: DIMENSIONS }, () => 0.1);

  beforeEach(() => {
    embedContent.mockReset();
    embedContent.mockResolvedValue(embeddingResponse(vector));
  });

  it("embeds a query with RETRIEVAL_QUERY and the fixed dimensionality", async () => {
    await expect(service.embedQuery("question")).resolves.toEqual(vector);

    expect(lastConfig()).toMatchObject({
      taskType: "RETRIEVAL_QUERY",
      outputDimensionality: DIMENSIONS,
    });
  });

  it("embeds a document with RETRIEVAL_DOCUMENT", async () => {
    await service.embedDocument("document text");

    expect(lastConfig()).toMatchObject({ taskType: "RETRIEVAL_DOCUMENT" });
  });

  it("omits abortSignal when no signal is given (exactOptionalPropertyTypes)", async () => {
    await service.embedQuery("question");

    expect(lastConfig()).not.toHaveProperty("abortSignal");
  });

  it("forwards the caller signal as abortSignal", async () => {
    const controller = new AbortController();

    await service.embedQuery("question", controller.signal);

    expect(lastConfig()["abortSignal"]).toBe(controller.signal);
  });

  it("rejects empty text without calling Gemini", async () => {
    await expect(service.embedQuery("   ")).rejects.toThrow(
      "Text cannot be empty",
    );
    expect(embedContent).not.toHaveBeenCalled();
  });

  it.each([
    ["no embeddings", {}],
    ["wrong dimensionality", embeddingResponse([0.1, 0.2])],
  ])("rejects a response with %s", async (_name, response) => {
    embedContent.mockResolvedValue(response);

    await expect(service.embedQuery("question")).rejects.toThrow(
      "Invalid embedding response",
    );
  });

  it("rejects non-finite vector values", async () => {
    const bad = [...vector];
    bad[10] = Number.NaN;
    embedContent.mockResolvedValue(embeddingResponse(bad));

    await expect(service.embedQuery("question")).rejects.toThrow(
      "Embedding contains invalid values",
    );
  });

  it("rejects empty text with RagInputError", async () => {
    await expect(service.embedQuery("   ")).rejects.toBeInstanceOf(RagInputError);
  });

  it.each([
    ["no embeddings", {}],
    ["NaN values", embeddingResponse(vector.map(() => Number.NaN))],
  ])("reports a response with %s as a non-retryable embed failure", async (_name, response) => {
    embedContent.mockResolvedValue(response);

    await expect(service.embedQuery("question")).rejects.toMatchObject({
      name: "RagUpstreamError",
      stage: "embed",
      retryable: false,
    });
  });

  it.each([
    ["HTTP 503", Object.assign(new Error("HTTP 503"), { status: 503 }), true],
    ["network error", new TypeError("fetch failed"), true],
    ["HTTP 400", Object.assign(new Error("HTTP 400"), { status: 400 }), false],
  ])("wraps an SDK %s as an embed failure, keeping the cause", async (_name, error, retryable) => {
    embedContent.mockRejectedValue(error);

    const rejection = await service.embedQuery("question").catch((e: unknown) => e);

    expect(rejection).toBeInstanceOf(RagUpstreamError);
    expect(rejection).toMatchObject({ stage: "embed", retryable, cause: error });
  });

  it("passes an SDK error through unchanged when the caller's signal aborted", async () => {
    const controller = new AbortController();
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    embedContent.mockImplementation(() => {
      controller.abort();
      return Promise.reject(abortError);
    });

    await expect(
      service.embedQuery("question", controller.signal),
    ).rejects.toBe(abortError);
  });

  it("passes RagNotConfiguredError through unchanged", async () => {
    const error = new RagNotConfiguredError();
    embedContent.mockRejectedValue(error);

    await expect(service.embedQuery("question")).rejects.toBe(error);
  });
});

describe("EmbeddingService Gemini stub (default)", () => {
  beforeEach(() => {
    embedContent.mockReset();
  });

  it("embeds a query as a constant unit vector without calling Gemini", async () => {
    const vector = await new EmbeddingService().embedQuery("question");

    expect(vector).toHaveLength(DIMENSIONS);
    expect(Math.hypot(...vector)).toBeCloseTo(1, 10);
    expect(embedContent).not.toHaveBeenCalled();
  });

  it("refuses to embed documents (stub vectors must not reach Qdrant)", async () => {
    await expect(new EmbeddingService().embedDocument("document text")).rejects.toThrow(
      /refusing to embed documents/,
    );
    expect(embedContent).not.toHaveBeenCalled();
  });

  it("still validates the input before the stub", async () => {
    await expect(new EmbeddingService().embedQuery("   ")).rejects.toBeInstanceOf(
      RagInputError,
    );
  });

  it("rejects an already aborted caller like the real call", async () => {
    const controller = new AbortController();
    controller.abort(new Error("deadline"));

    await expect(
      new EmbeddingService().embedQuery("question", controller.signal),
    ).rejects.toThrow("deadline");
  });
});
