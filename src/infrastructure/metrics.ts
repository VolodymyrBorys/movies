import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";
import type { Request, Response, NextFunction } from "express";

export const metricsRegistry = new Registry();

metricsRegistry.setDefaultLabels({
  service: "movies-api",
});

// ---------------------------------------------------------------------------
// Application metrics. Label values are fixed enums — never IDs, URLs or input.
// ---------------------------------------------------------------------------

/** Read path of a cache: hit, miss, or error (Redis failed → PostgreSQL fallback). */
export const cacheRequestsTotal = new Counter({
  name: "cache_requests_total",
  help: "Cache lookups by result (error = cache unavailable, served from PostgreSQL)",
  labelNames: ["cache", "result"] as const,
  registers: [metricsRegistry],
});

export type OutboxEventResult =
  | "processed"
  | "retry_scheduled"
  | "dead_lettered"
  | "reschedule_failed";

/**
 * Outcome per claimed outbox event. In-process counter: resets on restart, so alert on
 * increase(), not on the absolute value.
 */
export const outboxEventsTotal = new Counter({
  name: "outbox_events_total",
  help: "Outbox events handled by the worker, by result",
  labelNames: ["result"] as const,
  registers: [metricsRegistry],
});

/** Only non-empty batches are observed, so idle 1 s polls don't drown the distribution. */
export const outboxBatchDuration = new Histogram({
  name: "outbox_batch_duration_seconds",
  help: "Duration of non-empty outbox batches (claim + handle + mark)",
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

export const outboxPendingEvents = new Gauge({
  name: "outbox_pending_events",
  help: "Outbox events not yet processed or dead-lettered (sampled by the worker)",
  registers: [metricsRegistry],
});

export const outboxOldestPendingAge = new Gauge({
  name: "outbox_oldest_pending_age_seconds",
  help: "Age of the oldest pending outbox event since created_at (sampled by the worker)",
  registers: [metricsRegistry],
});

// Pre-create every known series at 0. A labelled counter series otherwise appears only on
// its first inc(), and increase()/rate() cannot see the jump from "absent" to 1 — the
// first dead-lettered event would never fire OutboxDeadLetters.
for (const result of ["hit", "miss", "error"] as const) {
  cacheRequestsTotal.inc({ cache: "movies_list", result }, 0);
}
for (const result of [
  "processed",
  "retry_scheduled",
  "dead_lettered",
  "reschedule_failed",
] as const satisfies readonly OutboxEventResult[]) {
  outboxEventsTotal.inc({ result }, 0);
}

// --- RAG -------------------------------------------------------------------
// Stage values mirror RagStage in src/modules/rag/rag.errors.ts (kept literal here so
// infrastructure doesn't import modules).

export type RagMetricStage = "embed" | "search" | "generate";
/** cancelled = the caller's signal aborted (deadline, client disconnect or shutdown). */
export type RagStageOutcome = "ok" | "error" | "cancelled";
export type RagGenerationAttemptOutcome =
  | "ok"
  | "retryable_error"
  | "error"
  | "timeout"
  | "cancelled";
export type RagTokenType = "prompt" | "output" | "thoughts";
/** What a Gemini generation is for, so the cost of movie reviews is visible apart from RAG. */
export type RagGenerationOperation = "answer" | "review";
/** retrieval = embed/search stages (shared by search and answer); generate = answer | review. */
export type RagStageOperation = "retrieval" | RagGenerationOperation;

const RAG_STAGE_OUTCOMES = ["ok", "error", "cancelled"] as const satisfies readonly RagStageOutcome[];
const RAG_GENERATION_OPERATIONS = ["answer", "review"] as const satisfies readonly RagGenerationOperation[];
// Only the combinations that exist; pre-created below.
const RAG_STAGE_SERIES = [
  ["embed", "retrieval"],
  ["search", "retrieval"],
  ["generate", "answer"],
  ["generate", "review"],
] as const satisfies ReadonlyArray<readonly [RagMetricStage, RagStageOperation]>;

/**
 * Wall time per pipeline stage. generate includes retries and backoff, so it is what the
 * caller waited for. Buckets go to 60 s: Gemini latency is unknown (never measured) and
 * the HTTP histogram stops at 5 s.
 */
export const ragStageDuration = new Histogram({
  name: "rag_stage_duration_seconds",
  help: "Duration of RAG pipeline stages (embed, search, generate) by operation and outcome",
  labelNames: ["stage", "operation", "outcome"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60],
  registers: [metricsRegistry],
});

export const ragGenerationSkippedTotal = new Counter({
  name: "rag_generation_skipped_total",
  help: "Answers returned without calling Gemini because the retrieved context was empty",
  registers: [metricsRegistry],
});

/** One per Gemini generateContent call; retries = everything except the final attempt. */
export const ragGenerationAttemptsTotal = new Counter({
  name: "rag_generation_attempts_total",
  help: "Gemini generation attempts by operation and outcome",
  labelNames: ["operation", "outcome"] as const,
  registers: [metricsRegistry],
});

/** From Gemini usageMetadata; thoughts are billed as output on thinking models. */
export const ragTokensTotal = new Counter({
  name: "rag_tokens_total",
  help: "Gemini generation tokens by operation and type (from response usage metadata)",
  labelNames: ["operation", "type"] as const,
  registers: [metricsRegistry],
});

for (const [stage, operation] of RAG_STAGE_SERIES) {
  for (const outcome of RAG_STAGE_OUTCOMES) {
    ragStageDuration.zero({ stage, operation, outcome });
  }
}
ragGenerationSkippedTotal.inc(0);
for (const operation of RAG_GENERATION_OPERATIONS) {
  for (const outcome of [
    "ok",
    "retryable_error",
    "error",
    "timeout",
    "cancelled",
  ] as const satisfies readonly RagGenerationAttemptOutcome[]) {
    ragGenerationAttemptsTotal.inc({ operation, outcome }, 0);
  }
  for (const type of ["prompt", "output", "thoughts"] as const satisfies readonly RagTokenType[]) {
    ragTokensTotal.inc({ operation, type }, 0);
  }
}

/**
 * When the backlog gauges were last refreshed. The two gauges above keep their last
 * value if sampling fails; alert on `time() - this > N` to catch stale backlog data.
 */
export const outboxBacklogRefreshedAt = new Gauge({
  name: "outbox_backlog_last_refresh_timestamp_seconds",
  help: "Unix time of the last successful outbox backlog sample",
  registers: [metricsRegistry],
});

collectDefaultMetrics({
  register: metricsRegistry,
  prefix: "nodejs_",
});

const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total number of completed HTTP requests",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [metricsRegistry],
});

const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
});

export function metricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.path === "/v1/metrics") {
    next();
    return;
  }

  const startedAt = process.hrtime.bigint();

  res.once("finish", () => {
    const elapsedSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;

    // Використовуємо шаблон маршруту, а не URL із конкретними ID.
    // req.baseUrl — це частина URL клієнта як є, а Express матчить без урахування регістру:
    // `/V1/movies` дав би окремий route="/V1/movies", невидимий для SLO/alerts, що фільтрують
    // route="/v1/movies". Усі mount paths у нижньому регістрі й без параметрів, тож
    // нормалізація нічого не губить. route.path — це шаблон із коду, його не чіпаємо.
    const route = req.route
      ? `${req.baseUrl.toLowerCase()}${req.route.path}`
      : "unmatched";

    const labels = {
      method: req.method,
      route,
      status_code: String(res.statusCode),
    };

    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, elapsedSeconds);
  });

  next();
}
