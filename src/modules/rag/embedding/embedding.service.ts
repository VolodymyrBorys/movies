import type { EmbedContentResponse } from "@google/genai";
import { getGeminiClient } from "../../../infrastructure/gemini/gemini.client.ts";
import {
  RagInputError,
  RagUpstreamError,
  toUpstreamError,
} from "../rag.errors.ts";
import { timeStage } from "../rag-metrics.ts";

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
      throw new RagInputError("Text cannot be empty");
    }

    return timeStage({ stage: "embed", operation: "retrieval" }, signal, () =>
      this.requestEmbedding(text, taskType, signal),
    );
  }

  private async requestEmbedding(
    text: string,
    taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY",
    signal?: AbortSignal,
  ): Promise<number[]> {
    // Client-side cancellation only: Gemini may still bill a request already sent.
    let response: EmbedContentResponse;
    try {
      response = await getGeminiClient().models.embedContent({
        model: MODEL,
        contents: text,
        config: {
          taskType,
          outputDimensionality: DIMENSIONS,
          ...(signal ? { abortSignal: signal } : {}),
        },
      });
    } catch (error: unknown) {
      throw toUpstreamError("embed", error, signal);
    }

    const vector = response.embeddings?.[0]?.values;

    if (!vector || vector.length !== DIMENSIONS) {
      throw new RagUpstreamError("embed", "Invalid embedding response", {
        retryable: false,
      });
    }

    if (!vector.every(Number.isFinite)) {
      throw new RagUpstreamError("embed", "Embedding contains invalid values", {
        retryable: false,
      });
    }

    return vector;
  }
}

export const embeddingService = new EmbeddingService();
