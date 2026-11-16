import { qdrantClient } from "../../../infrastructure/qdrant/qdrant.client.ts";
import { embeddingService } from "../embedding/embedding.service.ts";
import type {
  QdrantDocumentPayload,
  QdrantSearchOptions,
  QdrantSearchResult,
} from "./qdrant.types.ts";

const COLLECTION_NAME = "technical_documents";
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 50;

function validatePayload(
  payload: Record<string, unknown> | null,
): QdrantDocumentPayload {
  if (!payload) {
    throw new Error("Qdrant returned a point without payload");
  }

  const { documentId, content, source, chunkIndex, indexedAt } = payload;

  if (
    typeof documentId !== "string" ||
    typeof content !== "string" ||
    typeof source !== "string" ||
    typeof chunkIndex !== "number" ||
    typeof indexedAt !== "string"
  ) {
    throw new Error("Qdrant returned an invalid document payload");
  }

  return {
    documentId,
    content,
    source,
    chunkIndex,
    indexedAt,
  };
}

// @qdrant/js-client-rest 1.20 has no per-request AbortSignal (its timeout
// middleware overwrites init.signal). This is a soft cancel: the caller is
// released immediately, the HTTP request itself runs until it completes or hits
// the client timeout. Acceptable for a read-only, idempotent search.
function raceWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) {
    return promise;
  }

  if (signal.aborted) {
    // Already-started promise must not become an unhandled rejection.
    promise.catch(() => {});
    return Promise.reject(signal.reason);
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });

    // Both branches are handled, so a late rejection never becomes unhandled.
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function validateOptions(options: QdrantSearchOptions): void {
  const { limit = DEFAULT_LIMIT, scoreThreshold } = options;

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }

  if (
    scoreThreshold !== undefined &&
    (!Number.isFinite(scoreThreshold) ||
      scoreThreshold < -1 ||
      scoreThreshold > 1)
  ) {
    throw new Error("scoreThreshold must be a number between -1 and 1");
  }
}

export class QdrantSearchService {
  async search(
    query: string,
    options: QdrantSearchOptions = {},
    signal?: AbortSignal,
  ): Promise<QdrantSearchResult[]> {
    signal?.throwIfAborted();

    const normalizedQuery = query.trim();

    if (!normalizedQuery) {
      throw new Error("Search query cannot be empty");
    }

    validateOptions(options);

    const {
      limit = DEFAULT_LIMIT,
      scoreThreshold,
      documentId,
      source,
    } = options;

    // 1. Convert user query into an embedding.
    const queryVector = await embeddingService.embedQuery(
      normalizedQuery,
      signal,
    );

    // 2. Build optional metadata filters.
    const must: Array<{
      key: string;
      match: { value: string };
    }> = [];

    if (documentId) {
      must.push({
        key: "documentId",
        match: { value: documentId },
      });
    }

    if (source) {
      must.push({
        key: "source",
        match: { value: source },
      });
    }

    // 3. Execute vector search (not started if cancelled during embedding).
    // Must be checked here: the query() argument below is evaluated before
    // raceWithSignal runs, so a check inside it would come too late.
    signal?.throwIfAborted();

    const response = await raceWithSignal(
      qdrantClient.query(COLLECTION_NAME, {
        query: queryVector,
        limit,
        with_payload: true,
        ...(scoreThreshold !== undefined
          ? { score_threshold: scoreThreshold }
          : {}),
        ...(must.length > 0 ? { filter: { must } } : {}),
      }),
      signal,
    );

    // 4. Convert Qdrant response into our domain result.
    return response.points.map((point) => ({
      id: point.id,
      score: point.score,
      payload: validatePayload(point.payload as Record<string, unknown> | null),
    }));
  }
}

export const qdrantSearchService = new QdrantSearchService();
