import { Router } from "express";
import { answerQuestion, searchKnowledgeBase } from "../modules/rag/rag.controller.ts";
import { knowledgeBaseSearchBodySchema } from "../modules/rag/validation/knowledge-base-search.ts";
import { ragAnswerBodySchema } from "../modules/rag/validation/rag-answer.ts";
import { asyncHandler } from "../utils/errors.ts";
import { validate } from "../utils/validate-query.ts";

// Always mounted: without RAG config the handlers answer 503 RAG_NOT_CONFIGURED
// (stable route labels in metrics; clearer than a 404).
export const router = Router();

router.post(
  "/knowledge-base/search",
  validate("body", knowledgeBaseSearchBodySchema),
  asyncHandler(searchKnowledgeBase),
);

router.post(
  "/rag/answer",
  validate("body", ragAnswerBodySchema),
  asyncHandler(answerQuestion),
);
