import type { Request, Response } from "express";
import { shutdownSignal } from "../../infrastructure/shutdown-signal.ts";
import { createRequestSignal } from "../../utils/request-signal.ts";
import type { ContextChunk } from "./context/context.types.ts";
import { knowledgeBaseSearchService } from "./knowledge-base-search.service.ts";
import { SEARCH_DEADLINE_MS } from "./rag-deadlines.ts";
import { toRagHttpError } from "./rag-http-errors.ts";
import type { KnowledgeBaseSearchBody } from "./validation/knowledge-base-search.ts";

export interface KnowledgeBaseSearchResponse {
  data: {
    chunks: ContextChunk[];
    retrievedChunks: number;
    includedChunks: number;
  };
}

export const searchKnowledgeBase = async (_req: Request, res: Response) => {
  const { query, limit } = res.locals.validatedBody as KnowledgeBaseSearchBody;
  const signal = createRequestSignal(res, {
    timeoutMs: SEARCH_DEADLINE_MS,
    shutdownSignal,
  });

  try {
    // Already aborted (shutdown started): don't start billable work at all.
    signal.throwIfAborted();

    const { context, retrievedChunks } = await knowledgeBaseSearchService.search(
      { query },
      {
        // One knob for the client: how many chunks to retrieve and return.
        ...(limit !== undefined
          ? { retrieval: { limit }, context: { maxChunks: limit } }
          : {}),
        signal,
      },
    );

    const body: KnowledgeBaseSearchResponse = {
      data: {
        chunks: context.chunks,
        retrievedChunks,
        includedChunks: context.includedChunks,
      },
    };
    res.status(200).json(body);
  } catch (error: unknown) {
    throw toRagHttpError(error, signal);
  }
};
