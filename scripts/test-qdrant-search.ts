// Run: node --env-file-if-exists=.env scripts/test-qdrant-search.ts
import { qdrantCollectionService } from "../src/modules/rag/vector-store/qdrant-collection.service.ts";
import { qdrantSearchService } from "../src/modules/rag/vector-store/qdrant-search.service.ts";

async function main(): Promise<void> {
  await qdrantCollectionService.ensureTechnicalDocumentsCollection();

  const query = "How does PostgreSQL recover after a crash?";

  const results = await qdrantSearchService.search(query, {
    limit: 3,
  });

  console.dir(results, { depth: null });
}

main().catch((error: unknown) => {
  console.error("Semantic search test failed:", error);
  process.exitCode = 1;
});
