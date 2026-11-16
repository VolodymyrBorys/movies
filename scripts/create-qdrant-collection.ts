import { qdrantCollectionService } from "../src/modules/rag/vector-store/qdrant-collection.service.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile } from "node:process";

const envFile = join(import.meta.dirname, "../.env");

if (existsSync(envFile)) {
  loadEnvFile(envFile);
}

async function main(): Promise<void> {
  await qdrantCollectionService.ensureTechnicalDocumentsCollection();

  console.log("Qdrant collection is ready");
}

main().catch((error: unknown) => {
  console.error("Collection creation failed:", error);
  process.exitCode = 1;
});
