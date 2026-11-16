import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile } from "node:process";

const envFile = join(import.meta.dirname, "../.env");

if (existsSync(envFile)) {
  loadEnvFile(envFile);
}

const [
  { qdrantClient },
  { qdrantCollectionService },
  { qdrantDocumentService },
  { TECHNICAL_DOCUMENTS_COLLECTION },
] = await Promise.all([
  import("../src/infrastructure/qdrant/qdrant.client.ts"),
  import("../src/modules/rag/vector-store/qdrant-collection.service.ts"),
  import("../src/modules/rag/vector-store/qdrant-document.service.ts"),
  import("../src/modules/rag/vector-store/qdrant-collection.service.ts"),
]);

const documents = [
  {
    documentId: "postgresql-internals",
    chunkIndex: 0,
    source: "postgresql-documentation",
    content:
      "PostgreSQL uses Write-Ahead Logging (WAL) to ensure data durability. " +
      "Before modifying the actual data files, PostgreSQL writes changes to the WAL.",
  },
  {
    documentId: "postgresql-internals",
    chunkIndex: 1,
    source: "postgresql-documentation",
    content:
      "PostgreSQL uses MVCC (Multi-Version Concurrency Control) to manage " +
      "concurrent transactions without requiring readers to block writers.",
  },
  {
    documentId: "postgresql-internals",
    chunkIndex: 2,
    source: "postgresql-documentation",
    content:
      "A PostgreSQL index allows the database to find rows without scanning " +
      "the entire table. B-tree is the default index type.",
  },
  {
    documentId: "nodejs-internals",
    chunkIndex: 0,
    source: "nodejs-documentation",
    content:
      "Node.js uses the event loop to handle asynchronous operations. " +
      "The event loop coordinates callbacks, timers, and I/O operations.",
  },
  {
    documentId: "redis-internals",
    chunkIndex: 0,
    source: "redis-documentation",
    content:
      "Redis is an in-memory data store that supports strings, hashes, lists, " +
      "sets, sorted sets, streams, and other data structures.",
  },
];

async function main(): Promise<void> {
  try {
    // 1. Ensure collection exists.
    await qdrantCollectionService.ensureTechnicalDocumentsCollection();

    // 2. Generate embeddings and upsert documents.
    console.log("Starting document indexing...");

    const result = await qdrantDocumentService.upsertDocuments(documents);

    console.log("Upsert result:", {
      upsertedCount: result.upsertedCount,
      pointIds: result.pointIds,
    });

    // 3. Verify points in Qdrant.
    const retrieved = await qdrantClient.retrieve(
      TECHNICAL_DOCUMENTS_COLLECTION,
      {
        ids: result.pointIds,
        with_payload: true,
        with_vector: false,
      },
    );

    console.log("Retrieved points:", retrieved.length);

    for (const point of retrieved) {
      console.log({
        id: point.id,
        documentId: point.payload?.documentId,
        chunkIndex: point.payload?.chunkIndex,
        source: point.payload?.source,
        content: point.payload?.content,
      });
    }

    if (retrieved.length !== documents.length) {
      throw new Error(
        `Expected ${documents.length} points, received ${retrieved.length}`,
      );
    }

    console.log("Document indexing test passed");
  } catch (error) {
    console.error("Document indexing test failed:", error);
    process.exitCode = 1;
  }
}

await main();
