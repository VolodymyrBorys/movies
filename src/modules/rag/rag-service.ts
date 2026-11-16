import { contextBuilderService } from "./context/context-builder.service.ts";
import { geminiGenerationService } from "./generation/gemini-generation.service.ts";
import type {
  RagAnswerInput,
  RagAnswerOptions,
  RagAnswerResult,
} from "./rag.types.ts";
import { qdrantSearchService } from "./vector-store/qdrant-search.service.ts";

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

    // 1. Retrieve relevant chunks
    const searchResults = await qdrantSearchService.search(question, {
      limit: options.retrieval?.limit ?? 5,
      ...(options.retrieval?.scoreThreshold !== undefined
        ? { scoreThreshold: options.retrieval.scoreThreshold }
        : {}),
    });

    // 2. Build context
    const context = contextBuilderService.build(searchResults, {
      maxChunks: options.context?.maxChunks ?? 5,
      minScore: options.context?.minScore ?? 0,
      maxContextChars: options.context?.maxContextChars ?? 12_000,
    });

    // 3. Do not call LLM without useful context
    if (!context.text) {
      return {
        answer: DEFAULT_INSUFFICIENT_CONTEXT_ANSWER,
        model: null,
        sources: [],
        metadata: {
          retrievedChunks: searchResults.length,
          includedChunks: 0,
          contextLength: 0,
          generationSkipped: true,
        },
      };
    }

    // 4. Generate answer
    const generation = await geminiGenerationService.generate({
      question,
      context: context.text,
    });

    return {
      answer: generation.answer,
      model: generation.model,
      sources: context.sources,
      metadata: {
        retrievedChunks: searchResults.length,
        includedChunks: context.includedChunks,
        contextLength: context.text.length,
        generationSkipped: false,
      },
    };
  }
}

export const ragService = new RagService();
