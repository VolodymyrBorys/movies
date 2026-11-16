import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// HTTP-level test for probe endpoints: real app, router and readiness logic.
// Only PG/Redis/logger are replaced. Needs local port binding (supertest).

vi.mock("../infrastructure/logger.ts", async () => {
  const { pino } = await import("pino");
  return { logger: pino({ level: "silent" }) };
});

vi.mock("../infrastructure/postgres.ts", () => ({
  PG: { ping: vi.fn() },
}));

vi.mock("../infrastructure/redis.ts", () => ({
  REDIS: { ping: vi.fn() },
}));

const { app } = await import("../app.ts");
const { PG } = await import("../infrastructure/postgres.ts");
const { REDIS } = await import("../infrastructure/redis.ts");
const health = await import("../infrastructure/health.ts");

const pgPing = vi.mocked(PG.ping);
const redisPing = vi.mocked(REDIS.ping);

beforeEach(() => {
  vi.clearAllMocks();
  pgPing.mockResolvedValue(undefined);
  redisPing.mockResolvedValue(undefined);
});

describe("GET /healthz", () => {
  it("returns 200 without touching dependencies", async () => {
    pgPing.mockRejectedValue(new Error("db down"));

    const res = await request(app).get("/healthz");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(pgPing).not.toHaveBeenCalled();
    expect(redisPing).not.toHaveBeenCalled();
  });

  it("is not under /v1", async () => {
    const res = await request(app).get("/v1/healthz");
    expect(res.status).toBe(404);
  });
});

describe("GET /readyz", () => {
  it("returns 200 when PostgreSQL write and read pools respond", async () => {
    const res = await request(app).get("/readyz");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ready",
      shuttingDown: false,
      checks: { postgres_write: "up", postgres_read: "up", redis: "up" },
    });
    expect(pgPing).toHaveBeenCalledWith("write");
    expect(pgPing).toHaveBeenCalledWith("read");
  });

  it("returns 503 when PostgreSQL is down", async () => {
    pgPing.mockImplementation(async (pool) => {
      if (pool === "write") throw new Error("primary down");
    });

    const res = await request(app).get("/readyz");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("not_ready");
    expect(res.body.checks.postgres_write).toBe("down");
  });

  it("returns 200 with redis=down when only Redis is down", async () => {
    redisPing.mockRejectedValue(new Error("redis down"));

    const res = await request(app).get("/readyz");

    expect(res.status).toBe(200);
    expect(res.body.checks.redis).toBe("down");
  });

  // Keep last: shutdown state is process-wide and one-way.
  it("returns 503 after shutdown starts", async () => {
    health.markShuttingDown();

    const res = await request(app).get("/readyz");

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: "not_ready", shuttingDown: true });
    expect(pgPing).not.toHaveBeenCalled();
  });
});
