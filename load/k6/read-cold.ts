// P2.2 cold read path: every request asks for a page whose cache key was never used, so it
// misses Redis and runs the keyset query on PostgreSQL (and then writes the page to Redis).
//
//   k6 run -e RATE=100 -e DURATION=2m -e RUN_LABEL=r100 load/k6/read-cold.ts
//
// How keys stay unique (cache key = list version + limit + sort + cursor):
//   - setup() walks COLD_CURSOR_PAGES pages with limit=100 and keeps each nextCursor.
//     Those pages get cached, but only under limit=100.
//   - The test requests the same cursors with limit 10..59 (never 100). A cursor is a
//     position (created_at, id), valid for any limit, so each (cursor, limit) pair is a key
//     nobody has requested: COLD_CURSOR_PAGES × 50 unique keys.
//   - Iteration i uses pair i (scenario-wide counter, unique across VUs). The run is cold
//     only while rate × duration <= unique keys; the script refuses to start otherwise.
// Verify on the server side: cache_requests_total{result="hit"} should stay ~0 during the run.
//
// Coverage: 2000 pages × 100 = the newest 200k of 1M rows. Deeper pages cost the same with
// keyset pagination (index range scan from the cursor), which is the point of P0 step 9.

import http from "k6/http";
import exec from "k6/execution";
import { check } from "k6";
import type { Options } from "k6/options";
import {
  BASE_URL,
  durationSeconds,
  envDuration,
  envInt,
  LOAD_TAGS,
  type MeasuredSetupData,
  SLO_THRESHOLDS,
  SUMMARY_TREND_STATS,
  writeSummary,
} from "./lib/common.ts";

const RATE = envInt("RATE", 50);
const DURATION = envDuration("DURATION", "2m");
const CURSOR_PAGES = envInt("COLD_CURSOR_PAGES", 2000);
const PRE_VUS = envInt("PRE_VUS", Math.max(10, Math.ceil(RATE / 5)));
const MAX_VUS = envInt("MAX_VUS", Math.max(50, RATE * 2));

const LIMIT_MIN = 10;
const LIMIT_VARIANTS = 50; // limits 10..59; setup uses 100, so no overlap
const SETUP_LIMIT = 100;

const plannedRequests = RATE * durationSeconds(DURATION);
const uniqueKeys = CURSOR_PAGES * LIMIT_VARIANTS;
if (plannedRequests > uniqueKeys) {
  throw new Error(
    `RATE × DURATION = ${plannedRequests} requests > ${uniqueKeys} unique keys: ` +
      `raise COLD_CURSOR_PAGES or shorten the run, otherwise later requests hit the cache`,
  );
}

export const options: Options = {
  // Walking 2000 pages one by one takes a while (and is not measured).
  setupTimeout: "5m",
  scenarios: {
    read_cold: {
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

interface ColdSetupData extends MeasuredSetupData {
  cursors: string[];
}

// Setup traffic has no LOAD_TAGS, so it stays out of thresholds and reported numbers.
const SETUP_PARAMS = { tags: { name: "setup: walk cursors" }, timeout: "10s" };
const PARAMS = { tags: { name: "GET /v1/movies?cursor", ...LOAD_TAGS }, timeout: "10s" };

export function setup(): ColdSetupData {
  const cursors: string[] = [];
  let cursor: string | null = null;

  while (cursors.length < CURSOR_PAGES) {
    // Explicit types: cursor → query → res → next → cursor is circular for inference.
    const query: string = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
    const res = http.get(`${BASE_URL}/v1/movies?limit=${SETUP_LIMIT}${query}`, SETUP_PARAMS);
    if (res.status !== 200) {
      throw new Error(`setup page ${cursors.length + 1} answered ${res.status}`);
    }
    const next: unknown = res.json("nextCursor");
    if (typeof next !== "string") {
      throw new Error(`only ${cursors.length} pages available, need COLD_CURSOR_PAGES=${CURSOR_PAGES}`);
    }
    cursors.push(next);
    cursor = next;
  }

  return { cursors, measuredFrom: new Date().toISOString() };
}

export default function (data: ColdSetupData): void {
  const i = exec.scenario.iterationInTest;
  const pages = data.cursors.length;
  const cursor = data.cursors[i % pages];
  if (cursor === undefined) {
    throw new Error(`no cursor for iteration ${i}`);
  }
  const limit = LIMIT_MIN + (Math.floor(i / pages) % LIMIT_VARIANTS);

  const res = http.get(
    `${BASE_URL}/v1/movies?limit=${limit}&cursor=${encodeURIComponent(cursor)}`,
    PARAMS,
  );
  check(res, { "status 200": (r) => r.status === 200 });
}

export const handleSummary = writeSummary("read-cold", {
  rate: RATE,
  duration: DURATION,
  cursorPages: CURSOR_PAGES,
  uniqueKeys,
  preAllocatedVUs: PRE_VUS,
  maxVUs: MAX_VUS,
});
