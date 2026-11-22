import { z } from "zod";

// Upper bounds are cost/abuse controls, not Qdrant limits: the query is embedded
// (billable, per input token), `limit` caps both retrieval and the returned chunks.
export const MAX_QUERY_LENGTH = 1_000;
export const MAX_SEARCH_LIMIT = 20;

export const knowledgeBaseSearchBodySchema = z
  .object({
    query: z.string().trim().min(1).max(MAX_QUERY_LENGTH),
    limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional(),
  })
  .strict();

export type KnowledgeBaseSearchBody = z.infer<typeof knowledgeBaseSearchBodySchema>;
