import { geminiGenerationService } from "./generation/gemini-generation.service.ts";
import { knowledgeBaseSearchService } from "./knowledge-base-search.service.ts";
import type {
  RagAnswerInput,
  RagAnswerOptions,
  RagAnswerResult,
} from "./rag.types.ts";

const DEFAULT_INSUFFICIENT_CONTEXT_ANSWER =
  "I don't have enough relevant information in the provided documents to answer this question.";

export class RagService {
  async answer(
    input: RagAnswerInput,
    options: RagAnswerOptions = {},
  ): Promise<RagAnswerResult> {
    const question = input.question.trim();

    if (!question) {
      throw new Error("Question cannot be empty");
    }

    // 1. Retrieve knowledge and build context.
    const searchResult = await knowledgeBaseSearchService.search(
      { query: question },
      options,
    );

    const { context, retrievedChunks } = searchResult;

    // 2. Handle empty context without calling Gemini.
    if (!context.text) {
      return {
        answer: DEFAULT_INSUFFICIENT_CONTEXT_ANSWER,
        model: null,
        sources: [],
        metadata: {
          retrievedChunks,
          includedChunks: 0,
          contextLength: 0,
          generationSkipped: true,
        },
      };
    }

    // 3. Generate answer using retrieved context.
    const generation = await geminiGenerationService.generate({
      question,
      context: context.text,
    });

    // 4. Return answer, sources and metadata.
    return {
      answer: generation.answer,
      model: generation.model,
      sources: context.sources,
      metadata: {
        retrievedChunks,
        includedChunks: context.includedChunks,
        contextLength: context.text.length,
        generationSkipped: false,
      },
    };
  }
}

export const ragService = new RagService();
