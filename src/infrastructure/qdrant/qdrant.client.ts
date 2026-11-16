import { QdrantClient } from "@qdrant/js-client-rest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile } from "node:process";

const envFile = join(import.meta.dirname, "../../../.env");

if (existsSync(envFile)) {
  loadEnvFile(envFile);
}

const url = process.env.QDRANT_URL!;
const apiKey = process.env.QDRANT_API_KEY;

export const qdrantClient = new QdrantClient({
  url,
  ...(apiKey ? { apiKey } : {}),
});
