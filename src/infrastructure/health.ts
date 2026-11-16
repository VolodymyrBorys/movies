// Liveness/readiness logic. Pure: dependencies are injected, so it is unit-testable
// without PostgreSQL/Redis. Wiring lives in src/routes/health.ts.
//
// Semantics:
// - liveness (/healthz): the process can serve HTTP. No dependency checks — restarting
//   the pod does not fix a database outage, it only adds a restart storm.
// - readiness (/readyz): this instance should receive traffic. Fails while shutting
//   down or when PostgreSQL (source of truth) is unreachable. Redis is cache-only with a
//   PostgreSQL fallback, so it is REPORTED but never makes the instance unready:
//   otherwise one cache outage would pull every pod out of rotation at once.

export type DependencyStatus = "up" | "down" | "skipped";

export type DependencyName = "postgres_write" | "postgres_read" | "redis";

export interface ReadinessResult {
  ready: boolean;
  shuttingDown: boolean;
  checks: Record<DependencyName, DependencyStatus>;
}

export interface ReadinessDeps {
  pingPostgresWrite: () => Promise<void>;
  pingPostgresRead: () => Promise<void>;
  pingRedis: () => Promise<void>;
  isShuttingDown: () => boolean;
  timeoutMs: number;
  /** Called for each failed check (error or timeout) so failures are not swallowed. */
  onCheckFailed?: (dependency: DependencyName, error: unknown) => void;
}

export class CheckTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Check timed out after ${timeoutMs} ms`);
    this.name = "CheckTimeoutError";
  }
}

let shuttingDown = false;

export function markShuttingDown(): void {
  shuttingDown = true;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

async function probe(
  name: DependencyName,
  check: () => Promise<void>,
  deps: ReadinessDeps,
): Promise<DependencyStatus> {
  let timer: NodeJS.Timeout | undefined;

  // `attempt` never rejects, so losing the race cannot become an unhandled rejection.
  // LAB: simplified — the timeout is soft: a slow query keeps running (and holds a pool
  // connection) until the pool's statement_timeout ends it.
  const attempt = check().then(
    () => "up" as const,
    (error: unknown) => {
      deps.onCheckFailed?.(name, error);
      return "down" as const;
    },
  );

  const timeout = new Promise<"down">((resolve) => {
    timer = setTimeout(() => {
      deps.onCheckFailed?.(name, new CheckTimeoutError(deps.timeoutMs));
      resolve("down");
    }, deps.timeoutMs);
  });

  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// LAB: simplified — checks run on every probe request. Production would usually cache
// the result for 1–2 s so frequent probes from many pods don't add load to PostgreSQL.
export async function checkReadiness(
  deps: ReadinessDeps,
): Promise<ReadinessResult> {
  if (deps.isShuttingDown()) {
    return {
      ready: false,
      shuttingDown: true,
      checks: {
        postgres_write: "skipped",
        postgres_read: "skipped",
        redis: "skipped",
      },
    };
  }

  const [postgresWrite, postgresRead, redis] = await Promise.all([
    probe("postgres_write", deps.pingPostgresWrite, deps),
    probe("postgres_read", deps.pingPostgresRead, deps),
    probe("redis", deps.pingRedis, deps),
  ]);

  return {
    ready: postgresWrite === "up" && postgresRead === "up",
    shuttingDown: false,
    checks: {
      postgres_write: postgresWrite,
      postgres_read: postgresRead,
      redis,
    },
  };
}
