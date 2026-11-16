import { ragService } from "../src/modules/rag/rag-service.ts";
import { qdrantCollectionService } from "../src/modules/rag/vector-store/qdrant-collection.service.ts";

async function main(): Promise<void> {
  await qdrantCollectionService.ensureTechnicalDocumentsCollection();

  const result = await ragService.answer(
    {
      question: "How does PostgreSQL recover after a crash?",
    },
    {
      retrieval: {
        limit: 5,
      },
      context: {
        maxChunks: 3,
        minScore: 0.6,
        maxContextChars: 12_000,
      },
    },
  );

  console.log("\n--- Answer ---");
  console.log(result.answer);

  console.log("\n--- Sources ---");
  console.dir(result.sources, { depth: null });

  console.log("\n--- Metadata ---");
  console.dir(result.metadata, { depth: null });

  console.log("\n--- Model ---");
  console.log(result.model);
}

main().catch((error: unknown) => {
  console.error("RAG test failed:", error);
  process.exitCode = 1;
});
