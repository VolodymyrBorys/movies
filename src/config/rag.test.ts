import { describe, expect, it } from "vitest";
import { loadRagConfig, RagNotConfiguredError } from "./rag.ts";

const full = {
  GEMINI_API_KEY: "gemini-secret",
  QDRANT_URL: "http://localhost:6333",
};

describe("loadRagConfig", () => {
  it("returns null when no RAG variable is set", () => {
    expect(loadRagConfig({})).toBeNull();
  });

  it("returns null when only QDRANT_TIMEOUT_MS is set (it has a default)", () => {
    expect(loadRagConfig({ QDRANT_TIMEOUT_MS: "1000" })).toBeNull();
  });

  it("applies defaults for a minimal section", () => {
    expect(loadRagConfig(full)).toEqual({
      gemini: { apiKey: "gemini-secret" },
      qdrant: {
        url: "http://localhost:6333",
        apiKey: undefined,
        timeoutMs: 5_000,
      },
    });
  });

  it("reads explicit values and returns a frozen config", () => {
    const config = loadRagConfig({
      ...full,
      QDRANT_URL: "https://qdrant.internal:6333",
      QDRANT_API_KEY: "qdrant-secret",
      QDRANT_TIMEOUT_MS: "2500",
    });

    expect(config?.qdrant).toEqual({
      url: "https://qdrant.internal:6333",
      apiKey: "qdrant-secret",
      timeoutMs: 2_500,
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config?.qdrant)).toBe(true);
    expect(Object.isFrozen(config?.gemini)).toBe(true);
  });

  it.each([
    ["only GEMINI_API_KEY", { GEMINI_API_KEY: "gemini-secret" }, "QDRANT_URL"],
    ["only QDRANT_URL", { QDRANT_URL: "http://localhost:6333" }, "GEMINI_API_KEY"],
    ["only QDRANT_API_KEY", { QDRANT_API_KEY: "qdrant-secret" }, "GEMINI_API_KEY"],
    ["empty GEMINI_API_KEY", { ...full, GEMINI_API_KEY: "" }, "GEMINI_API_KEY"],
    ["non-http QDRANT_URL", { ...full, QDRANT_URL: "grpc://localhost:6334" }, "QDRANT_URL"],
    ["invalid QDRANT_URL", { ...full, QDRANT_URL: "not a url" }, "QDRANT_URL"],
    ["zero QDRANT_TIMEOUT_MS", { ...full, QDRANT_TIMEOUT_MS: "0" }, "QDRANT_TIMEOUT_MS"],
    ["non-numeric QDRANT_TIMEOUT_MS", { ...full, QDRANT_TIMEOUT_MS: "abc" }, "QDRANT_TIMEOUT_MS"],
  ])("fails fast on a partial or invalid section: %s", (_case, source, key) => {
    expect(() => loadRagConfig(source)).toThrow(key);
  });

  it("never includes values in the error message", () => {
    const source = { GEMINI_API_KEY: "gemini-secret", QDRANT_URL: "bad-url-value" };

    expect(() => loadRagConfig(source)).toThrow(/Invalid RAG configuration/);
    try {
      loadRagConfig(source);
    } catch (error) {
      expect(String(error)).not.toContain("gemini-secret");
      expect(String(error)).not.toContain("bad-url-value");
    }
  });
});

describe("RagNotConfiguredError", () => {
  it("names the variables to set", () => {
    const error = new RagNotConfiguredError();
    expect(error.name).toBe("RagNotConfiguredError");
    expect(error.message).toContain("GEMINI_API_KEY");
    expect(error.message).toContain("QDRANT_URL");
  });
});
