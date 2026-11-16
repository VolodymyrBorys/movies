import { geminiClient } from "../../../infrastructure/gemini/gemini.client.ts";

const MODEL = "gemini-embedding-001";
const DIMENSIONS = 768;

export class EmbeddingService {
  async embedDocument(text: string, signal?: AbortSignal): Promise<number[]> {
    return this.embed(text, "RETRIEVAL_DOCUMENT", signal);
  }

  async embedQuery(text: string, signal?: AbortSignal): Promise<number[]> {
    return this.embed(text, "RETRIEVAL_QUERY", signal);
  }

  private async embed(
    text: string,
    taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY",
    signal?: AbortSignal,
  ): Promise<number[]> {
    if (!text.trim()) {
      throw new Error("Text cannot be empty");
    }

    // Client-side cancellation only: Gemini may still bill a request already sent.
    const response = await geminiClient.models.embedContent({
      model: MODEL,
      contents: text,
      config: {
        taskType,
        outputDimensionality: DIMENSIONS,
        ...(signal ? { abortSignal: signal } : {}),
      },
    });

    const vector = response.embeddings?.[0]?.values;

    if (!vector || vector.length !== DIMENSIONS) {
      throw new Error("Invalid embedding response");
    }

    if (!vector.every(Number.isFinite)) {
      throw new Error("Embedding contains invalid values");
    }

    return vector;
  }
}

export const embeddingService = new EmbeddingService();
