// P2.1 cached read path: GET /v1/movies (first page, limit 20, desc) at a fixed arrival
// rate. One cache key → almost every request is a Redis hit. Run once per RATE ("stairs")
// to find the knee: the lowest rate where p99 or errors break the SLO, or k6 drops iterations.
//
//   k6 run -e RATE=200 -e DURATION=2m -e RUN_LABEL=r200 load/k6/read-cached.ts
// (-e, not shell env: `k6 inspect` ignores system env vars, -e works for every command.)
//
// Expected artefact: the key's TTL is 60 s + jitter, so roughly once a minute the key
// expires and concurrent requests miss together (small stampede on one key) — visible as
// cache misses > 0 in Prometheus. That is the current design, measured here, fixed in P4.

import http from "k6/http";
import { check } from "k6";
import type { Options } from "k6/options";
import {
  BASE_URL,
  envDuration,
  envInt,
  LOAD_TAGS,
  type MeasuredSetupData,
  SLO_THRESHOLDS,
  SUMMARY_TREND_STATS,
  writeSummary,
} from "./lib/common.ts";

const RATE = envInt("RATE", 100);
const DURATION = envDuration("DURATION", "2m");
// VUs needed ≈ rate × latency (s). Pre-allocate generously; if k6 still runs out,
// dropped_iterations > 0 and the threshold fails the run.
const PRE_VUS = envInt("PRE_VUS", Math.max(10, Math.ceil(RATE / 10)));
const MAX_VUS = envInt("MAX_VUS", Math.max(50, RATE));

export const options: Options = {
  scenarios: {
    read_cached: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: PRE_VUS,
      maxVUs: MAX_VUS,
    },
  },
  thresholds: SLO_THRESHOLDS,
  summaryTrendStats: SUMMARY_TREND_STATS,
};

const LIST_URL = `${BASE_URL}/v1/movies?limit=20`;
const PARAMS = { tags: { name: "GET /v1/movies", ...LOAD_TAGS }, timeout: "10s" };

export function setup(): MeasuredSetupData {
  // Warm the key so the run starts on the cached path (not measured: no LOAD_TAGS).
  const res = http.get(LIST_URL, { tags: { name: "setup: warm-up" }, timeout: "10s" });
  if (res.status !== 200) {
    throw new Error(`warm-up GET ${LIST_URL} answered ${res.status}`);
  }
  return { measuredFrom: new Date().toISOString() };
}

export default function (): void {
  check(http.get(LIST_URL, PARAMS), { "status 200": (r) => r.status === 200 });
}

export const handleSummary = writeSummary("read-cached", {
  rate: RATE,
  duration: DURATION,
  preAllocatedVUs: PRE_VUS,
  maxVUs: MAX_VUS,
});
