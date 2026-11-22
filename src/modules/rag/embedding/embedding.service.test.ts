import { beforeEach, describe, expect, it, vi } from "vitest";

// Only the Gemini client (external I/O) is replaced.
const { embedContent } = vi.hoisted(() => ({ embedContent: vi.fn() }));

vi.mock("../../../infrastructure/gemini/gemini.client.ts", () => ({
  getGeminiClient: () => ({ models: { embedContent } }),
}));

const { EmbeddingService } = await import("./embedding.service.ts");

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
  const service = new EmbeddingService();
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

  it("propagates SDK errors unchanged", async () => {
    const error = new Error("network down");
    embedContent.mockRejectedValue(error);

    await expect(service.embedQuery("question")).rejects.toBe(error);
  });
});
