import { QdrantClient } from "@qdrant/js-client-rest";
import { ragConfig, RagNotConfiguredError } from "../../config/rag.ts";

let client: QdrantClient | undefined;

/**
 * Created on first use, so importing this module never fails: the API starts
 * without RAG config, and RAG calls fail with RagNotConfiguredError instead.
 */
export function getQdrantClient(): QdrantClient {
  if (client) return client;
  if (!ragConfig) throw new RagNotConfiguredError();

  const { url, apiKey, timeoutMs } = ragConfig.qdrant;
  client = new QdrantClient({
    url,
    timeout: timeoutMs,
    ...(apiKey ? { apiKey } : {}),
  });
  return client;
}
