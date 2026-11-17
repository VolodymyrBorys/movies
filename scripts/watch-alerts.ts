// Watches Prometheus alerts (and optionally /readyz) during an alert drill and prints
// state transitions with timestamps. Ctrl+C prints a summary + Drill log lines.
//
// Read-only: only GET requests to Prometheus and the app. Changes nothing.
//
//   node scripts/watch-alerts.ts                      # all alerts
//   node scripts/watch-alerts.ts RedisDown CacheErrors
//
// Env: PROM_URL (default http://localhost:9090), APP_URL (default http://localhost:3000,
//      set APP_URL= to skip /readyz polling), INTERVAL_MS (default 5000).

const PROM_URL = process.env.PROM_URL ?? "http://localhost:9090";
const APP_URL = process.env.APP_URL ?? "http://localhost:3000";
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 5_000);
const REQUEST_TIMEOUT_MS = 3_000;

if (!Number.isInteger(INTERVAL_MS) || INTERVAL_MS < 1_000) {
  throw new Error("INTERVAL_MS must be an integer >= 1000");
}

const filter = new Set(process.argv.slice(2));

type AlertState = "pending" | "firing";

interface PromAlert {
  labels: Record<string, string>;
  state: AlertState | "inactive";
  activeAt?: string;
}

interface Timeline {
  name: string;
  labels: string;
  startedAt: Date; // first seen pending/firing (Prometheus activeAt when available)
  firingAt: Date | null;
  resolvedAt: Date | null;
  state: AlertState | "resolved";
}

const timelines = new Map<string, Timeline>();
const watchStartedAt = new Date();
let promReachable: boolean | null = null;
let lastReadyz: string | null = null;

const time = (d: Date) => d.toTimeString().slice(0, 8);
const secs = (from: Date, to: Date) => `${Math.round((to.getTime() - from.getTime()) / 1000)}s`;

function log(message: string): void {
  console.log(`${time(new Date())}  ${message}`);
}

function isPromAlert(value: unknown): value is PromAlert {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.labels === "object" &&
    v.labels !== null &&
    (v.state === "pending" || v.state === "firing" || v.state === "inactive")
  );
}

async function fetchAlerts(): Promise<PromAlert[]> {
  const res = await fetch(`${PROM_URL}/api/v1/alerts`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Prometheus HTTP ${res.status}`);

  const body: unknown = await res.json();
  const alerts = (body as { data?: { alerts?: unknown } }).data?.alerts;
  if (!Array.isArray(alerts)) throw new Error("Unexpected /api/v1/alerts response");

  return alerts.filter(isPromAlert);
}

function keyOf(alert: PromAlert): { key: string; name: string; labels: string } {
  const { alertname = "?", ...rest } = alert.labels;
  const labels = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join(",");
  return { key: `${alertname}{${labels}}`, name: alertname, labels };
}

async function pollAlerts(now: Date): Promise<void> {
  let alerts: PromAlert[];
  try {
    alerts = await fetchAlerts();
    if (promReachable !== true) log(`Prometheus reachable at ${PROM_URL}`);
    promReachable = true;
  } catch (error) {
    if (promReachable !== false) {
      log(`Prometheus NOT reachable (${error instanceof Error ? error.message : String(error)})`);
    }
    promReachable = false;
    return;
  }

  const seen = new Set<string>();

  for (const alert of alerts) {
    if (alert.state === "inactive") continue;
    const { key, name, labels } = keyOf(alert);
    if (filter.size > 0 && !filter.has(name)) continue;
    seen.add(key);

    const existing = timelines.get(key);

    if (existing === undefined || existing.state === "resolved") {
      const startedAt = alert.activeAt ? new Date(alert.activeAt) : now;
      timelines.set(key, {
        name,
        labels,
        startedAt,
        firingAt: alert.state === "firing" ? now : null,
        resolvedAt: null,
        state: alert.state,
      });
      log(`${key}  → ${alert.state}${alert.activeAt ? ` (active since ${time(startedAt)})` : ""}`);
      continue;
    }

    if (existing.state === "pending" && alert.state === "firing") {
      existing.state = "firing";
      existing.firingAt = now;
      log(`${key}  pending → firing (after ${secs(existing.startedAt, now)})`);
    }
  }

  for (const [key, t] of timelines) {
    if (t.state !== "resolved" && !seen.has(key)) {
      const from = t.state;
      t.state = "resolved";
      t.resolvedAt = now;
      log(`${key}  ${from} → resolved${from === "pending" ? " (never fired)" : ""}`);
    }
  }
}

async function pollReadyz(): Promise<void> {
  if (APP_URL === "") return;

  let status: string;
  try {
    const res = await fetch(`${APP_URL}/readyz`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const body = (await res.json().catch(() => null)) as { checks?: Record<string, string> } | null;
    const checks = body?.checks
      ? Object.entries(body.checks).map(([k, v]) => `${k}=${v}`).join(" ")
      : "";
    status = `${res.status} ${checks}`.trim();
  } catch (error) {
    status = `unreachable (${error instanceof Error ? error.name : "error"})`;
  }

  if (status !== lastReadyz) {
    log(`/readyz ${status}`);
    lastReadyz = status;
  }
}

function printSummary(): void {
  const end = new Date();
  console.log(`\n=== Summary (${time(watchStartedAt)} – ${time(end)}) ===`);

  if (timelines.size === 0) {
    console.log("No alerts became pending or firing.");
    return;
  }

  const date = end.toISOString().slice(0, 10);
  for (const t of timelines.values()) {
    const fired = t.firingAt ? `fired after ${secs(t.startedAt, t.firingAt)}` : "never fired";
    const resolved = t.resolvedAt
      ? `resolved ${secs(t.firingAt ?? t.startedAt, t.resolvedAt)} after ${t.firingAt ? "firing" : "pending"}`
      : `still ${t.state}`;
    const labels = t.labels ? ` {${t.labels}}` : "";
    console.log(`${date} · <drill> · ${t.name}${labels} · ${fired} · ${resolved}`);
  }
  console.log("\nReplace <drill> and paste into the Drill log in docs/progress/observability.md.");
}

let stopping = false;
process.on("SIGINT", () => {
  if (stopping) process.exit(1);
  stopping = true;
});

log(
  `Watching ${filter.size > 0 ? [...filter].join(", ") : "all alerts"} every ${INTERVAL_MS / 1000}s` +
    (APP_URL === "" ? "" : `, plus ${APP_URL}/readyz`) +
    ". Ctrl+C for summary.",
);

while (!stopping) {
  const now = new Date();
  await Promise.all([pollAlerts(now), pollReadyz()]);

  const deadline = Date.now() + INTERVAL_MS;
  while (!stopping && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

printSummary();
