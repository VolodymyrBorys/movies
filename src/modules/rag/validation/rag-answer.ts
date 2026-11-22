import { z } from "zod";

// Cost/abuse control: the question is embedded and sent to Gemini (billed per token).
// Retrieval options are deliberately not exposed to clients yet (small surface; defaults
// owned by the services). LAB: simplified — production would also need a rate limit and a
// per-client token budget.
export const MAX_QUESTION_LENGTH = 1_000;

export const ragAnswerBodySchema = z
  .object({
    question: z.string().trim().min(1).max(MAX_QUESTION_LENGTH),
  })
  .strict();

export type RagAnswerBody = z.infer<typeof ragAnswerBodySchema>;
