// Run: node --env-file-if-exists=.env scripts/test-qdrant.ts
import { getQdrantClient } from "../src/infrastructure/qdrant/qdrant.client.ts";
import { qdrantCollectionService } from "../src/modules/rag/vector-store/qdrant-collection.service.ts";

async function main(): Promise<void> {
  try {
    const qdrantClient = getQdrantClient();

    // 1. Check connection
    const { collections } = await qdrantClient.getCollections();

    console.log("Connected to Qdrant");
    console.log("Existing collections:", collections);

    // 2. Create collection if it does not exist
    await qdrantCollectionService.ensureTechnicalDocumentsCollection();

    // 3. Read collection information
    const info = await qdrantClient.getCollection("technical_documents");

    console.log("Collection info:", {
      status: info.status,
      pointsCount: info.points_count,
      vectors: info.config.params.vectors,
    });
  } catch (error) {
    console.error("Qdrant test failed:", error);
    process.exitCode = 1;
  }
}

await main();
