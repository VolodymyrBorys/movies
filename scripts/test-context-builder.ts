const { qdrantCollectionService } =
  await import("../src/modules/rag/vector-store/qdrant-collection.service.ts");

const { qdrantSearchService } =
  await import("../src/modules/rag/vector-store/qdrant-search.service.ts");

const { contextBuilderService } =
  await import("../src/modules/rag/context/context-builder.service.ts");

async function main(): Promise<void> {
  await qdrantCollectionService.ensureTechnicalDocumentsCollection();

  const query = "How does PostgreSQL recover after a crash?";

  const results = await qdrantSearchService.search(query, {
    limit: 5,
  });

  const context = contextBuilderService.build(results, {
    maxChunks: 3,
    minScore: 0.6,
    maxContextChars: 12_000,
  });

  console.log("\n========== RETRIEVED CHUNKS ==========\n");
  console.dir(results, { depth: null });

  console.log("\n========== BUILT CONTEXT ==========\n");
  console.log(context.text);

  console.log("\n========== CONTEXT METADATA ==========\n");
  console.dir(
    {
      includedChunks: context.includedChunks,
      sources: context.sources,
    },
    { depth: null },
  );
}

main().catch((error: unknown) => {
  console.error("Context builder test failed:", error);
  process.exitCode = 1;
});
