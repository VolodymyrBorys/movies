// Shared settings for the k6 scenarios (P2). k6 (>= 1.0) runs .ts directly by stripping
// types; type checking is `npx tsc -p load/k6` (own tsconfig: k6 is not Node — no process,
// fs or Node timers; k6 globals like __ENV must not leak into the app's types).
//
// Open model everywhere (constant-arrival-rate): k6 starts iterations at a fixed rate no
// matter how slow responses are, so a slow server cannot reduce the offered load and hide
// its own tail latency (coordinated omission, see scripts/load-test.ts for the closed model).

import type { Options } from "k6/options";

export const BASE_URL = (__ENV.BASE_URL || "http://localhost:3000").replace(/\/+$/, "");

/** Positive integer from an env variable, with a default; fails the run on bad input. */
export function envInt(name: string, fallback: number): number {
  const raw = __ENV[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

const DURATION_PATTERN = /^(\d+)(ms|s|m|h)$/;
const DURATION_UNIT_SECONDS = { ms: 0.001, s: 1, m: 60, h: 3600 } as const;

/** k6 duration string ("90s", "2m"). */
export function envDuration(name: string, fallback: string): string {
  const raw = __ENV[name];
  if (raw === undefined || raw === "") return fallback;
  if (!DURATION_PATTERN.test(raw)) {
    throw new Error(`${name} must look like 90s / 2m, got "${raw}"`);
  }
  return raw;
}

export function durationSeconds(value: string): number {
  const match = DURATION_PATTERN.exec(value);
  if (!match) {
    throw new Error(`invalid duration "${value}"`);
  }
  const unit = match[2] as keyof typeof DURATION_UNIT_SECONDS;
  return Number(match[1]) * DURATION_UNIT_SECONDS[unit];
}

// Measured requests carry this tag; setup() traffic (warm-up, cursor walk) does not, so it
// stays out of thresholds and of the reported numbers (k6 records setup requests too).
export const LOAD_TAGS = { phase: "load" } as const;
const LOAD = "{phase:load}";

// SLO of GET /v1/movies (observability/prometheus/rules/slo.rules.yml): availability 99.5%,
// 99% of requests <= 250 ms. A run that breaks them is marked failed (exit code 99) but
// is not aborted: when searching for the knee we want the numbers past the limit too.
export const SLO_THRESHOLDS: NonNullable<Options["thresholds"]> = {
  [`http_req_failed${LOAD}`]: ["rate<0.005"],
  [`http_req_duration${LOAD}`]: ["p(99)<250"],
  [`http_reqs${LOAD}`]: ["count>0"],
  // A dropped iteration = k6 had no free VU to start it: the offered rate was NOT reached,
  // so the run measures the generator, not the service. Must stay 0 for a valid result.
  dropped_iterations: ["count<1"],
};

export const SUMMARY_TREND_STATS = ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max", "count"];

/** Data every setup() returns: the start of the measured window (setup traffic excluded). */
export interface MeasuredSetupData {
  measuredFrom: string;
}

// The parts of k6's end-of-test summary object this module reads (k6 has no exported type
// for it). Values are per-metric stats, e.g. { med, "p(99)", rate, count }.
interface SummaryMetric {
  values: Record<string, number>;
  thresholds?: Record<string, { ok: boolean }>;
}

export interface SummaryData {
  metrics: Record<string, SummaryMetric>;
  setup_data?: Partial<MeasuredSetupData> & Record<string, unknown>;
  [key: string]: unknown;
}

type SummaryParams = Record<string, string | number>;

function num(value: number | undefined, digits = 2): string {
  return typeof value === "number" ? value.toFixed(digits) : "n/a";
}

function metric(data: SummaryData, name: string): Record<string, number> {
  return data.metrics[name]?.values ?? {};
}

/** The measured-only submetric when the scenario defines it (thresholds), else the total. */
function loadMetric(data: SummaryData, name: string): Record<string, number> {
  return data.metrics[`${name}${LOAD}`] ? metric(data, `${name}${LOAD}`) : metric(data, name);
}

/**
 * Writes the full k6 summary as JSON to docs/perf/runs/ (or SUMMARY_DIR) and prints a
 * compact text summary. Self-contained: no remote jslib import at run time.
 */
export function writeSummary(scenarioName: string, params: SummaryParams) {
  return function handleSummary(data: SummaryData): Record<string, string> {
    const finishedAt = new Date();
    const dir = (__ENV.SUMMARY_DIR || "docs/perf/runs").replace(/\/+$/, "");
    const label = __ENV.RUN_LABEL ? `-${__ENV.RUN_LABEL}` : "";
    const stamp = finishedAt.toISOString().replace(/[:.]/g, "-");
    const file = `${dir}/${stamp}-${scenarioName}${label}.json`;

    // setup_data may hold thousands of cursors: keep only the measurement window.
    const measuredFrom = data.setup_data?.measuredFrom ?? null;
    delete data.setup_data;

    const duration = loadMetric(data, "http_req_duration");
    const failed = loadMetric(data, "http_req_failed");
    const reqs = loadMetric(data, "http_reqs");
    const dropped = metric(data, "dropped_iterations");
    const vusMax = metric(data, "vus_max");
    const checks = metric(data, "checks");

    const thresholds = Object.entries(data.metrics).flatMap(([name, m]) =>
      Object.entries(m.thresholds ?? {}).map(
        ([expr, t]) => `${t.ok ? "ok  " : "FAIL"} ${name}: ${expr}`,
      ),
    );

    const report = {
      scenario: scenarioName,
      label: __ENV.RUN_LABEL || null,
      params,
      baseUrl: BASE_URL,
      // Prometheus window for the server-side comparison (setup traffic excluded).
      measuredFrom,
      finishedAt: finishedAt.toISOString(),
      k6: data,
    };

    const text = [
      "",
      `scenario ${scenarioName}${label}  params ${JSON.stringify(params)}`,
      `window   ${measuredFrom ?? "?"} .. ${finishedAt.toISOString()}`,
      `requests ${reqs.count ?? 0}  rate ${num(reqs.rate)}/s  failed ${num((failed.rate ?? 0) * 100, 3)}%  ` +
        `checks ${num((checks.rate ?? 0) * 100, 3)}%`,
      `latency  ms  med ${num(duration.med)}  p90 ${num(duration["p(90)"])}  p95 ${num(duration["p(95)"])}  ` +
        `p99 ${num(duration["p(99)"])}  max ${num(duration.max)}`,
      `dropped_iterations ${dropped.count ?? 0}  vus_max ${vusMax.value ?? vusMax.max ?? "n/a"}`,
      ...thresholds,
      `summary  ${file}`,
      "",
    ].join("\n");

    return {
      stdout: text,
      [file]: JSON.stringify(report, null, 2),
    };
  };
}
