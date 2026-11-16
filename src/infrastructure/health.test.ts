import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CheckTimeoutError,
  checkReadiness,
  type ReadinessDeps,
} from "./health.ts";

const ok = () => Promise.resolve();
const fail = (message: string) => () => Promise.reject(new Error(message));
const never = () => new Promise<void>(() => {});

function deps(overrides: Partial<ReadinessDeps> = {}): ReadinessDeps {
  return {
    pingPostgresWrite: ok,
    pingPostgresRead: ok,
    pingRedis: ok,
    isShuttingDown: () => false,
    timeoutMs: 800,
    onCheckFailed: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("checkReadiness", () => {
  it("is ready when all dependencies are up", async () => {
    const result = await checkReadiness(deps());

    expect(result).toEqual({
      ready: true,
      shuttingDown: false,
      checks: { postgres_write: "up", postgres_read: "up", redis: "up" },
    });
  });

  it.each([
    ["postgres_write", { pingPostgresWrite: fail("primary down") }],
    ["postgres_read", { pingPostgresRead: fail("replica down") }],
  ] as const)("is not ready when %s is down", async (name, override) => {
    const d = deps(override);

    const result = await checkReadiness(d);

    expect(result.ready).toBe(false);
    expect(result.checks[name]).toBe("down");
    expect(d.onCheckFailed).toHaveBeenCalledWith(name, expect.any(Error));
  });

  it("stays ready when only Redis is down (cache with PostgreSQL fallback)", async () => {
    const d = deps({ pingRedis: fail("redis down") });

    const result = await checkReadiness(d);

    expect(result.ready).toBe(true);
    expect(result.checks.redis).toBe("down");
    // Reported, not swallowed.
    expect(d.onCheckFailed).toHaveBeenCalledWith("redis", expect.any(Error));
  });

  it("marks a hanging check as down after the timeout", async () => {
    vi.useFakeTimers();
    const d = deps({ pingPostgresWrite: never, timeoutMs: 800 });

    const pending = checkReadiness(d);
    await vi.advanceTimersByTimeAsync(799);
    // Not resolved before the timeout: race still pending.
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(result.ready).toBe(false);
    expect(result.checks.postgres_write).toBe("down");
    expect(d.onCheckFailed).toHaveBeenCalledWith(
      "postgres_write",
      expect.any(CheckTimeoutError),
    );
  });

  it("clears timers when checks finish first", async () => {
    vi.useFakeTimers();

    await checkReadiness(deps());

    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not report a timeout for a check that already failed", async () => {
    vi.useFakeTimers();
    const d = deps({ pingRedis: fail("redis down") });

    await checkReadiness(d);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(d.onCheckFailed).toHaveBeenCalledTimes(1);
  });

  it("is not ready while shutting down and skips dependency checks", async () => {
    const pingPostgresWrite = vi.fn(ok);
    const d = deps({ isShuttingDown: () => true, pingPostgresWrite });

    const result = await checkReadiness(d);

    expect(result).toEqual({
      ready: false,
      shuttingDown: true,
      checks: {
        postgres_write: "skipped",
        postgres_read: "skipped",
        redis: "skipped",
      },
    });
    expect(pingPostgresWrite).not.toHaveBeenCalled();
  });
});
