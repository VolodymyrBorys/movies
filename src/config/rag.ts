import { z } from "zod";

// RAG config (Gemini + Qdrant), separate from env.ts on purpose: env.ts requires PG_*
// at import time, and RAG scripts must not depend on PostgreSQL settings.
// Like env.ts, this module does NOT load `.env`: use `node --env-file-if-exists=.env`.
//
// The section is optional: with none of its variables set, RAG is "not configured"
// (ragConfig === null) and the API still starts; RAG clients then throw
// RagNotConfiguredError on first use. A partially set section fails fast.

const nonEmpty = z.string().min(1);

const httpUrl = z.string().refine(
  (value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  },
  { message: "must be an http:// or https:// URL" },
);

// Variables whose presence means "RAG is meant to be configured".
// QDRANT_TIMEOUT_MS is not one of them: it has a default.
const SECTION_KEYS = ["GEMINI_API_KEY", "QDRANT_URL", "QDRANT_API_KEY"] as const;

const RagEnvSchema = z.object({
  GEMINI_API_KEY: nonEmpty,
  QDRANT_URL: httpUrl,
  QDRANT_API_KEY: nonEmpty.optional(),
  // Client-side timeout for every Qdrant request (the client's own default is 300 s).
  // Qdrant search is soft-cancelled (see qdrant-search.service.ts), so this is what
  // bounds a stray request after the caller gave up.
  QDRANT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
});

export interface RagConfig {
  readonly gemini: {
    readonly apiKey: string;
  };
  readonly qdrant: {
    readonly url: string;
    readonly apiKey: string | undefined;
    readonly timeoutMs: number;
  };
}

export class RagNotConfiguredError extends Error {
  constructor() {
    super("RAG is not configured: set GEMINI_API_KEY and QDRANT_URL");
    this.name = "RagNotConfiguredError";
  }
}

/** Returns null when no RAG variable is set; throws when the section is invalid. */
export function loadRagConfig(source: NodeJS.ProcessEnv): RagConfig | null {
  if (SECTION_KEYS.every((key) => source[key] === undefined)) {
    return null;
  }

  const result = RagEnvSchema.safeParse(source);

  if (!result.success) {
    // Variable names and messages only. Never include values: they may be secrets.
    const details = result.error.issues
      .map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid RAG configuration: ${details}`);
  }

  const env = result.data;

  return Object.freeze({
    gemini: Object.freeze({ apiKey: env.GEMINI_API_KEY }),
    qdrant: Object.freeze({
      url: env.QDRANT_URL,
      apiKey: env.QDRANT_API_KEY,
      timeoutMs: env.QDRANT_TIMEOUT_MS,
    }),
  });
}

export const ragConfig: RagConfig | null = loadRagConfig(process.env);
