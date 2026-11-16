import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile } from "node:process";

const envFile = join(import.meta.dirname, "../.env");

if (existsSync(envFile)) {
  loadEnvFile(envFile);
}

const { qdrantCollectionService } =
  await import("../src/modules/rag/vector-store/qdrant-collection.service.ts");

const { qdrantSearchService } =
  await import("../src/modules/rag/vector-store/qdrant-search.service.ts");

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
