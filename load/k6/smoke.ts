// P2.0 smoke: 1 VU, read-only. Proves the scripts, the endpoints and the summary output
// work before any load. Does NOT call RAG endpoints (billable) or write anything.
//
//   k6 run load/k6/smoke.ts

import http from "k6/http";
import exec from "k6/execution";
import { check, sleep } from "k6";
import type { Options } from "k6/options";
import {
  BASE_URL,
  envDuration,
  type MeasuredSetupData,
  SUMMARY_TREND_STATS,
  writeSummary,
} from "./lib/common.ts";

const DURATION = envDuration("DURATION", "30s");

export const options: Options = {
  scenarios: {
    smoke: { executor: "constant-vus", vus: 1, duration: DURATION },
  },
  thresholds: {
    http_req_failed: ["rate==0"],
    checks: ["rate==1"],
  },
  summaryTrendStats: SUMMARY_TREND_STATS,
};

interface MovieListBody {
  data: Array<{ id: string }>;
  nextCursor: string | null;
}

function isMovieListBody(value: unknown): value is MovieListBody {
  if (typeof value !== "object" || value === null) return false;
  const body = value as { data?: unknown; nextCursor?: unknown };
  return (
    Array.isArray(body.data) &&
    body.data.every(
      (movie: unknown) =>
        typeof movie === "object" && movie !== null && typeof (movie as { id?: unknown }).id === "string",
    ) &&
    (typeof body.nextCursor === "string" || body.nextCursor === null)
  );
}

// 404 for a missing id is expected: don't count it as a failed request.
const EXPECT_404 = {
  responseCallback: http.expectedStatuses(404),
  tags: { name: "GET /v1/movies/:id (missing)" },
};

export function setup(): MeasuredSetupData {
  return { measuredFrom: new Date().toISOString() };
}

export default function (): void {
  check(http.get(`${BASE_URL}/healthz`, { tags: { name: "GET /healthz" } }), {
    "healthz 200": (r) => r.status === 200,
  });

  const ready = http.get(`${BASE_URL}/readyz`, { tags: { name: "GET /readyz" } });
  const readyOk = check(ready, { "readyz 200": (r) => r.status === 200 });
  // The body names the failing dependency (postgres_write / postgres_read / shuttingDown).
  if (!readyOk && exec.scenario.iterationInTest === 0) {
    console.warn(`readyz answered ${ready.status}: ${String(ready.body)}`);
  }

  const first = http.get(`${BASE_URL}/v1/movies?limit=20`, { tags: { name: "GET /v1/movies" } });
  const body: unknown = first.status === 200 ? first.json() : null;
  const firstMovie = isMovieListBody(body) ? body.data[0] : undefined;
  const firstOk = check(first, {
    "list 200": (r) => r.status === 200,
    "list has 20 movies and a cursor": () =>
      isMovieListBody(body) && body.data.length === 20 && typeof body.nextCursor === "string",
  });

  if (firstOk && isMovieListBody(body) && firstMovie && body.nextCursor !== null) {
    const second = http.get(
      `${BASE_URL}/v1/movies?limit=20&cursor=${encodeURIComponent(body.nextCursor)}`,
      { tags: { name: "GET /v1/movies?cursor" } },
    );
    const secondBody: unknown = second.status === 200 ? second.json() : null;
    check(second, {
      "page 2 200": (r) => r.status === 200,
      "page 2 starts after page 1": () =>
        isMovieListBody(secondBody) && secondBody.data[0]?.id !== firstMovie.id,
    });

    const byId = http.get(`${BASE_URL}/v1/movies/${firstMovie.id}`, {
      tags: { name: "GET /v1/movies/:id" },
    });
    check(byId, {
      "by id 200": (r) => r.status === 200,
      // k6 canonicalizes header names ("Etag").
      "by id has ETag": (r) => /^"\d+"$/.test(r.headers.Etag ?? r.headers.ETag ?? ""),
    });
  }

  check(http.get(`${BASE_URL}/v1/movies/00000000-0000-4000-8000-000000000000`, EXPECT_404), {
    "missing id 404": (r) => r.status === 404,
  });

  sleep(1);
}

export const handleSummary = writeSummary("smoke", { duration: DURATION });
