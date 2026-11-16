import { contextBuilderService } from "../src/modules/rag/context/context-builder.service.ts";
import { geminiGenerationService } from "../src/modules/rag/generation/gemini-generation.service.ts";
import { qdrantCollectionService } from "../src/modules/rag/vector-store/qdrant-collection.service.ts";
import { qdrantSearchService } from "../src/modules/rag/vector-store/qdrant-search.service.ts";

async function main(): Promise<void> {
  const question = "How does PostgreSQL recover after a crash?";

  console.time("Total RAG pipeline");

  try {
    // 1. Ensure collection exists
    console.time("Ensure collection");

    await qdrantCollectionService.ensureTechnicalDocumentsCollection();

    console.timeEnd("Ensure collection");

    // 2. Retrieve documents
    console.time("Qdrant search + embeddings");

    const searchResults = await qdrantSearchService.search(question, {
      limit: 5,
    });

    console.timeEnd("Qdrant search + embeddings");

    console.log("\n--- Retrieved chunks ---");

    for (const result of searchResults) {
      console.log({
        documentId: result.payload.documentId,
        chunkIndex: result.payload.chunkIndex,
        score: result.score,
      });
    }

    // 3. Build context
    console.time("Context building");

    const context = contextBuilderService.build(searchResults, {
      maxChunks: 3,
      minScore: 0.6,
      maxContextChars: 12_000,
    });

    console.timeEnd("Context building");

    console.log("\n--- Context statistics ---");
    console.log({
      includedChunks: context.includedChunks,
      contextLength: context.text.length,
      sources: context.sources,
    });

    if (!context.text) {
      throw new Error("No relevant context found. Gemini generation skipped.");
    }

    // 4. Generate answer
    console.time("Gemini generation");

    const result = await geminiGenerationService.generate({
      question,
      context: context.text,
    });

    console.timeEnd("Gemini generation");

    console.log("\n--- Generated answer ---");
    console.log(result.answer);

    console.log("\n--- Model ---");
    console.log(result.model);

    console.log("\n--- Sources ---");
    console.log(context.sources);
  } finally {
    console.timeEnd("Total RAG pipeline");
  }
}

main().catch((error: unknown) => {
  console.error("\nRAG generation test failed:", error);
  process.exitCode = 1;
});
