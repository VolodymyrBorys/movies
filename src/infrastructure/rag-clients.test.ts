import { afterEach, describe, expect, it, vi } from "vitest";

// The SDK constructors are replaced (no network). config/rag.ts stays real: each case
// stubs process.env and re-imports the modules, so `ragConfig` and the client cache
// are fresh per test.
const { GoogleGenAI, QdrantClient } = vi.hoisted(() => ({
  GoogleGenAI: vi.fn(),
  QdrantClient: vi.fn(),
}));

vi.mock("@google/genai", () => ({ GoogleGenAI }));
vi.mock("@qdrant/js-client-rest", () => ({ QdrantClient }));

const RAG_KEYS = [
  "GEMINI_API_KEY",
  "QDRANT_URL",
  "QDRANT_API_KEY",
  "QDRANT_TIMEOUT_MS",
] as const;

const config = {
  GEMINI_API_KEY: "gemini-secret",
  QDRANT_URL: "http://localhost:6333",
};

async function loadClients(env: Partial<Record<(typeof RAG_KEYS)[number], string>>) {
  for (const key of RAG_KEYS) vi.stubEnv(key, env[key]);
  vi.resetModules();
  const [{ getGeminiClient }, { getQdrantClient }, { RagNotConfiguredError }] =
    await Promise.all([
      import("./gemini/gemini.client.ts"),
      import("./qdrant/qdrant.client.ts"),
      import("../config/rag.ts"),
    ]);
  return { getGeminiClient, getQdrantClient, RagNotConfiguredError };
}

afterEach(() => {
  GoogleGenAI.mockReset();
  QdrantClient.mockReset();
  vi.unstubAllEnvs();
});

describe("RAG clients without config", () => {
  it("import without throwing and fail on first use with RagNotConfiguredError", async () => {
    const { getGeminiClient, getQdrantClient, RagNotConfiguredError } =
      await loadClients({});

    expect(() => getGeminiClient()).toThrow(RagNotConfiguredError);
    expect(() => getQdrantClient()).toThrow(RagNotConfiguredError);
    expect(GoogleGenAI).not.toHaveBeenCalled();
    expect(QdrantClient).not.toHaveBeenCalled();
  });
});

describe("RAG clients with config", () => {
  it("create each client once, lazily, from the config", async () => {
    const { getGeminiClient, getQdrantClient } = await loadClients(config);

    expect(GoogleGenAI).not.toHaveBeenCalled();
    expect(QdrantClient).not.toHaveBeenCalled();

    expect(getGeminiClient()).toBe(getGeminiClient());
    expect(getQdrantClient()).toBe(getQdrantClient());

    expect(GoogleGenAI).toHaveBeenCalledTimes(1);
    expect(GoogleGenAI).toHaveBeenCalledWith({ apiKey: "gemini-secret" });
    expect(QdrantClient).toHaveBeenCalledTimes(1);
    expect(QdrantClient).toHaveBeenCalledWith({
      url: "http://localhost:6333",
      timeout: 5_000,
    });
  });

  it("passes the Qdrant API key only when set", async () => {
    const { getQdrantClient } = await loadClients({
      ...config,
      QDRANT_API_KEY: "qdrant-secret",
    });

    getQdrantClient();

    expect(QdrantClient).toHaveBeenCalledWith({
      url: "http://localhost:6333",
      timeout: 5_000,
      apiKey: "qdrant-secret",
    });
  });
});
