import { describe, expect, it, vi } from "vitest";

// env.ts builds `config` from process.env at import time; give it the required
// PG_* values so the import succeeds. The tests below call loadConfig() directly.
vi.stubEnv("PG_DATABASE", "movies");
vi.stubEnv("PG_PRIMARY_HOST", "localhost");

const { loadConfig } = await import("./env.ts");

const required = { PG_DATABASE: "movies", PG_PRIMARY_HOST: "localhost" };

describe("loadConfig", () => {
  it("applies defaults for server, log and redis", () => {
    const config = loadConfig({ ...required });

    expect(config.server).toEqual({ port: 3000, shutdownDelayMs: 0 });
    expect(config.log).toEqual({ level: "info" });
    expect(config.redis).toEqual({
      url: "redis://localhost:6379",
      username: undefined,
      password: undefined,
    });
  });

  it("reads explicit values", () => {
    const config = loadConfig({
      ...required,
      PORT: "8080",
      LOG_LEVEL: "debug",
      SHUTDOWN_DELAY_MS: "5000",
      REDIS_URL: "rediss://cache.internal:6380",
      REDIS_USERNAME: "app",
      REDIS_PASSWORD: "secret-value",
    });

    expect(config.server).toEqual({ port: 8080, shutdownDelayMs: 5000 });
    expect(config.log.level).toBe("debug");
    expect(config.redis).toEqual({
      url: "rediss://cache.internal:6380",
      username: "app",
      password: "secret-value",
    });
  });

  it("service name defaults to movies-api; worker metrics port to 3002", () => {
    const config = loadConfig({ ...required });

    expect(config.serviceName).toBe("movies-api");
    expect(config.worker).toEqual({ metricsPort: 3002 });
  });

  it("reads SERVICE_NAME and WORKER_METRICS_PORT", () => {
    const config = loadConfig({
      ...required,
      SERVICE_NAME: "movies-worker",
      WORKER_METRICS_PORT: "9500",
    });

    expect(config.serviceName).toBe("movies-worker");
    expect(config.worker.metricsPort).toBe(9500);
  });

  it("rejects an unknown SERVICE_NAME (it becomes a metric label)", () => {
    expect(() => loadConfig({ ...required, SERVICE_NAME: "anything-else" })).toThrow(
      /SERVICE_NAME/,
    );
  });

  it("returns a frozen config", () => {
    const config = loadConfig({ ...required });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.redis)).toBe(true);
  });

  it.each([
    ["PORT", "0"],
    ["PORT", "70000"],
    ["PORT", "abc"],
    ["LOG_LEVEL", "verbose"],
    ["SHUTDOWN_DELAY_MS", "-1"],
    ["SHUTDOWN_DELAY_MS", "15000"],
    ["REDIS_URL", "http://localhost:6379"],
    ["REDIS_URL", "not a url"],
    ["REDIS_USERNAME", ""],
    ["REDIS_PASSWORD", ""],
  ])("rejects %s=%j", (name, value) => {
    expect(() => loadConfig({ ...required, [name]: value })).toThrow(
      new RegExp(`Invalid environment configuration: .*${name}`),
    );
  });

  it("never includes values in the error message", () => {
    const secret = "super-secret-password";
    let message = "";

    try {
      loadConfig({ ...required, REDIS_URL: `http://user:${secret}@host` });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/REDIS_URL/);
    expect(message).not.toContain(secret);
  });

  it("still requires PG_* (no default for the source of truth)", () => {
    expect(() => loadConfig({})).toThrow(/PG_DATABASE/);
  });
});
