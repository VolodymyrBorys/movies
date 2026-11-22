// Run: node --env-file-if-exists=.env scripts/create-qdrant-collection.ts
import { qdrantCollectionService } from "../src/modules/rag/vector-store/qdrant-collection.service.ts";

async function main(): Promise<void> {
  await qdrantCollectionService.ensureTechnicalDocumentsCollection();

  console.log("Qdrant collection is ready");
}

main().catch((error: unknown) => {
  console.error("Collection creation failed:", error);
  process.exitCode = 1;
});
