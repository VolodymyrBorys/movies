import { performance } from "node:perf_hooks";

const URL = process.env.TARGET_URL ?? "http://localhost:3000/v1/movies";

const TOTAL_REQUESTS = Number(process.env.TOTAL_REQUESTS ?? 1000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 20);
const TIMEOUT_MS = 10_000;

if (
  !Number.isInteger(TOTAL_REQUESTS) ||
  TOTAL_REQUESTS < 1 ||
  !Number.isInteger(CONCURRENCY) ||
  CONCURRENCY < 1
) {
  throw new Error("TOTAL_REQUESTS and CONCURRENCY must be positive integers");
}

const latencies: any[] = [];
const statusCounts = new Map();
let completed = 0;
let failed = 0;
let nextRequestId = 0;

const testStartedAt = performance.now();

async function makeRequest() {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(URL, {
      method: "GET",
      signal: controller.signal,
    });

    // Читаємо body, щоб вимірювання охоплювало отримання відповіді.
    await response.arrayBuffer();

    const duration = performance.now() - startedAt;
    latencies.push(duration);

    const status = response.status;
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);

    if (!response.ok) {
      failed++;
    }
  } catch (error) {
    failed++;
    const reason = error instanceof Error ? error.name : String(error);

    statusCounts.set(reason, (statusCounts.get(reason) ?? 0) + 1);
  } finally {
    clearTimeout(timeout);
    completed++;
  }
}

async function worker() {
  while (true) {
    const requestId = nextRequestId++;

    if (requestId >= TOTAL_REQUESTS) return;

    await makeRequest();
  }
}

function percentile(values: any[], p: number) {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;

  return sorted[Math.max(0, index)];
}

const workers = Array.from(
  { length: Math.min(CONCURRENCY, TOTAL_REQUESTS) },
  () => worker(),
);

await Promise.all(workers);

const elapsedSeconds = (performance.now() - testStartedAt) / 1000;

console.log("\n=== Load test results ===");
console.log(`Target:       ${URL}`);
console.log(`Requests:     ${TOTAL_REQUESTS}`);
console.log(`Concurrency:  ${CONCURRENCY}`);
console.log(`Completed:    ${completed}`);
console.log(`Failed:       ${failed}`);
console.log(`Duration:     ${elapsedSeconds.toFixed(2)} s`);
console.log(`Throughput:   ${(completed / elapsedSeconds).toFixed(2)} req/s`);

console.log("\n=== Client-side latency ===");
console.log(`p50:  ${percentile(latencies, 50)?.toFixed(2) ?? "N/A"} ms`);
console.log(`p95:  ${percentile(latencies, 95)?.toFixed(2) ?? "N/A"} ms`);
console.log(`p99:  ${percentile(latencies, 99)?.toFixed(2) ?? "N/A"} ms`);
console.log(`max:  ${Math.max(0, ...latencies).toFixed(2)} ms`);

console.log("\n=== HTTP statuses / errors ===");
for (const [status, count] of statusCounts) {
  console.log(`${status}: ${count}`);
}
