import type { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

// Regression (drill 2026-11-19): an idle pool client losing its connection made the pool
// emit "error" with no listener → uncaught exception → process exit.
// pg.Pool is replaced by an EventEmitter so the test needs no database.

const { pools, logError } = vi.hoisted(() => ({
  pools: [] as EventEmitter[],
  logError: vi.fn(),
}));

// vi.mock is hoisted above imports, so the factory loads EventEmitter itself.
vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");
  class FakePool extends EventEmitter {
    ended = false;
    query = async () => ({ rows: [] });
    constructor() {
      super();
      pools.push(this);
    }
  }
  return { Pool: FakePool };
});

vi.mock("./logger.ts", () => {
  const child = { info: vi.fn(), error: logError };
  return { logger: { child: () => child } };
});

// env.ts builds `config` from process.env at import time.
vi.stubEnv("PG_DATABASE", "movies");
vi.stubEnv("PG_PRIMARY_HOST", "localhost");

const { PG } = await import("./postgres.ts");
await PG.start();

function idleClientError(): Error {
  const error = Object.assign(
    new Error("terminating connection due to administrator command"),
    { code: "57P01" },
  );
  // pg-pool attaches the Client (with its connection password) before emitting.
  return Object.assign(error, { client: { password: "s3cret-password" } });
}

describe("PgService idle client errors", () => {
  it.each([
    ["write", 0],
    ["read", 1],
  ] as const)("%s pool: error event does not throw", (_name, index) => {
    const pool = pools[index];
    if (pool === undefined) throw new Error(`pool ${index} was not created`);

    expect(() => pool.emit("error", idleClientError())).not.toThrow();
  });

  it("logs pool name, code and message, but not the client", () => {
    logError.mockClear();
    pools[0]?.emit("error", idleClientError());

    expect(logError).toHaveBeenCalledWith(
      {
        pool: "write",
        code: "57P01",
        message: "terminating connection due to administrator command",
      },
      expect.any(String),
    );
    expect(JSON.stringify(logError.mock.calls)).not.toContain("s3cret-password");
  });
});
