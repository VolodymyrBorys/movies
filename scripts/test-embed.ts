import { embeddingService } from "../src/modules/rag/embedding/embedding.service.ts";

async function main(): Promise<void> {
  const text = `
    PostgreSQL uses Write-Ahead Logging (WAL).
    WAL ensures that changes are written to durable storage
    before modified data pages are written to disk.
  `;

  const vector = await embeddingService.embedDocument(text);

  console.log({
    dimensions: vector.length,
    sample: vector.slice(0, 10),
    min: Math.min(...vector),
    max: Math.max(...vector),
  });

  const query = await embeddingService.embedQuery(
    "How does PostgreSQL WAL work?",
  );

  console.log({
    queryDimensions: query.length,
    querySample: query.slice(0, 10),
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
