import { setTimeout as sleep } from "node:timers/promises";
import type { GenerateContentResponseUsageMetadata } from "@google/genai";
import { getGeminiClient } from "../../../infrastructure/gemini/gemini.client.ts";
import { logger } from "../../../infrastructure/logger.ts";
import {
  ragGenerationAttemptsTotal,
  ragTokensTotal,
  type RagGenerationOperation,
  type RagTokenType,
} from "../../../infrastructure/metrics.ts";
import { timeStage } from "../rag-metrics.ts";
import {
  getHttpStatus,
  RagUpstreamError,
  toUpstreamError,
} from "../rag.errors.ts";

// The single Gemini generateContent call site (CLAUDE.md: Gemini calls only in
// rag/generation/ and rag/embedding/). Shared by RAG answers and movie reviews so both
// get the same retry policy, timeouts, cancellation, metrics and log hygiene.

export const GENERATION_MODEL = "gemini-3.8-flash";

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;
const INITIAL_RETRY_DELAY_MS = 1_000;

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export interface GeminiGenerateRequest {
  /** Metrics label: what the generation is for. */
  operation: RagGenerationOperation;
  prompt: string;
  systemInstruction: string;
  temperature: number;
  maxOutputTokens: number;
  signal?: AbortSignal;
}

export interface GeminiGenerateResult {
  /** Trimmed, non-empty model output. */
  text: string;
  model: string;
}

// Retry policy (unchanged): only these HTTP statuses are retried here.
// Classification for callers (503 vs 502) is isTransientUpstreamError in rag.errors.ts.
function isRetryableError(error: unknown): boolean {
  const status = getHttpStatus(error);
  return status !== undefined && RETRYABLE_STATUSES.has(status);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const log = logger.child({ component: "gemini-generation" });

// Field names verified against @google/genai 3.0.0 types only (no live response observed).
function recordTokenUsage(
  operation: RagGenerationOperation,
  usage: GenerateContentResponseUsageMetadata | undefined,
): void {
  if (!usage) return;

  const counts: Array<[RagTokenType, number | undefined]> = [
    ["prompt", usage.promptTokenCount],
    ["output", usage.candidatesTokenCount],
    ["thoughts", usage.thoughtsTokenCount],
  ];

  for (const [type, count] of counts) {
    if (count !== undefined && Number.isFinite(count) && count > 0) {
      ragTokensTotal.inc({ operation, type }, count);
    }
  }
}

/**
 * Stage "generate" = all attempts + backoff: the time the caller actually waited.
 * Errors: RagUpstreamError (stage "generate") or, when the caller's signal aborted, the
 * error the SDK threw (the caller decides by `signal.reason`).
 */
export function generateWithRetries(
  request: GeminiGenerateRequest,
): Promise<GeminiGenerateResult> {
  return timeStage(
    { stage: "generate", operation: request.operation },
    request.signal,
    () => runAttempts(request),
  );
}

async function runAttempts({
  operation,
  prompt,
  systemInstruction,
  temperature,
  maxOutputTokens,
  signal: callerSignal,
}: GeminiGenerateRequest): Promise<GeminiGenerateResult> {
  // Retries are done here only: SDK @google/genai 3.x retries HTTP calls
  // solely when httpOptions.retryOptions is set, and our client doesn't set it.
  // Note: aborting is client-side only; Gemini may still bill the request.
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    callerSignal?.throwIfAborted();

    // Per-attempt timeout, combined with the caller's cancellation signal.
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;

    try {
      log.debug(
        { operation, attempt, maxAttempts: MAX_ATTEMPTS },
        "Gemini generation attempt",
      );

      const startedAt = Date.now();

      const response = await getGeminiClient().models.generateContent({
        model: GENERATION_MODEL,
        contents: prompt,
        config: {
          systemInstruction,
          temperature,
          maxOutputTokens,
          abortSignal: signal,
        },
      });

      // Any response is billed, even one with an empty answer.
      recordTokenUsage(operation, response.usageMetadata);

      const durationMs = Date.now() - startedAt;
      const text = response.text?.trim();

      if (!text) {
        // Not retried (known issue #8 in docs/progress/rag.md).
        throw new RagUpstreamError(
          "generate",
          "Gemini returned an empty response",
          { retryable: false },
        );
      }

      ragGenerationAttemptsTotal.inc({ operation, outcome: "ok" });
      log.debug({ operation, attempt, durationMs }, "Gemini generation completed");

      return { text, model: GENERATION_MODEL };
    } catch (error: unknown) {
      // Cancelled by the caller: never retry.
      if (callerSignal?.aborted) {
        ragGenerationAttemptsTotal.inc({ operation, outcome: "cancelled" });
        throw error;
      }

      if (controller.signal.aborted) {
        ragGenerationAttemptsTotal.inc({ operation, outcome: "timeout" });
        throw new RagUpstreamError(
          "generate",
          `Gemini request timed out after ${REQUEST_TIMEOUT_MS}ms`,
          { retryable: true, cause: error },
        );
      }

      const retryable = isRetryableError(error);
      const isLastAttempt = attempt === MAX_ATTEMPTS;

      ragGenerationAttemptsTotal.inc({
        operation,
        outcome: retryable ? "retryable_error" : "error",
      });

      if (!retryable || isLastAttempt) {
        throw toUpstreamError("generate", error);
      }

      const exponentialDelay = INITIAL_RETRY_DELAY_MS * 2 ** (attempt - 1);

      const jitter = Math.floor(Math.random() * 250);
      const retryDelay = exponentialDelay + jitter;

      // Status + SDK message only; never the prompt, retrieved context or movie data.
      log.warn(
        {
          operation,
          attempt,
          status: getHttpStatus(error),
          error: getErrorMessage(error),
          retryDelayMs: retryDelay,
        },
        "Gemini generation failed; retrying",
      );

      // Backoff wait is cancellable by the caller as well.
      await sleep(
        retryDelay,
        undefined,
        callerSignal ? { signal: callerSignal } : undefined,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("Gemini generation failed");
}
