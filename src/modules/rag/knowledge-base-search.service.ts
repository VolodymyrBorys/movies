import { contextBuilderService } from "./context/context-builder.service.ts";
import type {
  KnowledgeBaseSearchInput,
  KnowledgeBaseSearchOptions,
  KnowledgeBaseSearchResult,
} from "./knowledge-base-search.types.ts";
import { RagInputError } from "./rag.errors.ts";
import { qdrantSearchService } from "./vector-store/qdrant-search.service.ts";

export class KnowledgeBaseSearchService {
  async search(
    input: KnowledgeBaseSearchInput,
    options: KnowledgeBaseSearchOptions = {},
  ): Promise<KnowledgeBaseSearchResult> {
    const query = input.query.trim();

    if (!query) {
      throw new RagInputError("Search query cannot be empty");
    }

    // 1. Retrieve relevant chunks from Qdrant (defaults + validation inside).
    const searchResults = await qdrantSearchService.search(
      query,
      options.retrieval,
      options.signal,
    );

    // 2. Build context from retrieved chunks (defaults + validation inside).
    const context = contextBuilderService.build(searchResults, options.context);

    // 3. Return prepared context and retrieval metadata.
    return {
      context,
      retrievedChunks: searchResults.length,
    };
  }
}

export const knowledgeBaseSearchService = new KnowledgeBaseSearchService();
