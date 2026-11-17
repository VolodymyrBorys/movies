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
    const route = req.route ? `${req.baseUrl}${req.route.path}` : "unmatched";

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
