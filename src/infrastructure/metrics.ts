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

// --- Worker process (P5.5): message_outbox relay and review consumer ---------
// Recorded only in the worker (service="movies-worker"); the API exposes them at 0.
// Value lists mirror src/workers/outbox-relay.ts and src/workers/review-handler.ts (kept
// literal here so infrastructure doesn't import workers; those files type-check against them).

export const MESSAGE_OUTBOX_PUBLISH_RESULTS = [
  "published",
  "returned",
  "publish_failed",
  "timeout",
] as const;
export type MessageOutboxPublishResult = (typeof MESSAGE_OUTBOX_PUBLISH_RESULTS)[number];

/** Broker answer per publish attempt (one claimed row = one attempt). */
export const messageOutboxPublishTotal = new Counter({
  name: "message_outbox_publish_total",
  help: "Outbox relay publish attempts by broker result",
  labelNames: ["result"] as const,
  registers: [metricsRegistry],
});

export const MESSAGE_OUTBOX_EVENT_RESULTS = [
  "published", // confirmed AND marked published
  "retry_scheduled",
  "dead_lettered",
  "lease_lost", // guarded UPDATE matched no row (incl. confirmed but not marked)
  "db_error", // mark/reschedule UPDATE failed; the lease expires and the row is retried
] as const;
export type MessageOutboxEventResult = (typeof MESSAGE_OUTBOX_EVENT_RESULTS)[number];

/** What the relay recorded in PostgreSQL per claimed row. Alert on increase(). */
export const messageOutboxEventsTotal = new Counter({
  name: "message_outbox_events_total",
  help: "Outbox relay outcome per claimed message, by result",
  labelNames: ["result"] as const,
  registers: [metricsRegistry],
});

export const messageOutboxPendingMessages = new Gauge({
  name: "message_outbox_pending_messages",
  help: "message_outbox rows not yet published or dead-lettered (sampled by the relay)",
  registers: [metricsRegistry],
});

export const messageOutboxOldestPendingAge = new Gauge({
  name: "message_outbox_oldest_pending_age_seconds",
  help: "Age of the oldest pending message_outbox row since created_at (sampled by the relay)",
  registers: [metricsRegistry],
});

/** State, not a counter: survives restarts and stays > 0 until an operator re-queues. */
export const messageOutboxDeadLetteredMessages = new Gauge({
  name: "message_outbox_dead_lettered_messages",
  help: "message_outbox rows dead-lettered by the relay and never published (sampled)",
  registers: [metricsRegistry],
});

export const messageOutboxBacklogRefreshedAt = new Gauge({
  name: "message_outbox_backlog_last_refresh_timestamp_seconds",
  help: "Unix time of the last successful message_outbox backlog sample",
  registers: [metricsRegistry],
});

export const REVIEW_DELIVERY_OUTCOMES = [
  "succeeded",
  "superseded",
  "duplicate",
  "job_missing",
  "invalid_message",
  "failed",
  "exhausted",
  "retry_scheduled",
  "lease_busy",
  "lease_lost",
  "infrastructure_retry",
  "requeued",
  "shutdown_released", // generation aborted by a graceful shutdown: attempt refunded, requeued
  "handler_threw", // bug path in the consumer: requeued after a pause
] as const;
export type ReviewDeliveryOutcome = (typeof REVIEW_DELIVERY_OUTCOMES)[number];

export const reviewDeliveriesTotal = new Counter({
  name: "review_deliveries_total",
  help: "review.requested deliveries handled by the review consumer, by outcome",
  labelNames: ["outcome"] as const,
  registers: [metricsRegistry],
});

/**
 * Wall time of one generator call (incl. its in-process retries), for stub, fake and real
 * Gemini alike — the fake generator bypasses rag_stage_duration_seconds.
 */
export const reviewGenerationDuration = new Histogram({
  name: "review_generation_duration_seconds",
  help: "Review generator call duration by outcome",
  labelNames: ["outcome"] as const,
  // Up to the 90 s generation deadline.
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60, 90],
  registers: [metricsRegistry],
});

for (const result of MESSAGE_OUTBOX_PUBLISH_RESULTS) messageOutboxPublishTotal.inc({ result }, 0);
for (const result of MESSAGE_OUTBOX_EVENT_RESULTS) messageOutboxEventsTotal.inc({ result }, 0);
for (const outcome of REVIEW_DELIVERY_OUTCOMES) reviewDeliveriesTotal.inc({ outcome }, 0);
for (const outcome of ["ok", "error"] as const) reviewGenerationDuration.zero({ outcome });

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
