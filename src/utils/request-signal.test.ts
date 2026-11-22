import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClientDisconnectedError,
  createRequestSignal,
  RequestDeadlineExceededError,
  ServerShuttingDownError,
} from "./request-signal.ts";

/** Minimal ServerResponse stand-in: 'close' + writableFinished, like Node's http.ServerResponse. */
class FakeResponse extends EventEmitter {
  writableFinished = false;

  finish(): void {
    this.writableFinished = true;
    this.emit("close");
  }

  disconnect(): void {
    this.emit("close");
  }
}

describe("createRequestSignal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts with RequestDeadlineExceededError exactly at the deadline", () => {
    const signal = createRequestSignal(new FakeResponse(), { timeoutMs: 1_000 });

    vi.advanceTimersByTime(999);
    expect(signal.aborted).toBe(false);

    vi.advanceTimersByTime(1);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(RequestDeadlineExceededError);
    expect(signal.reason).toMatchObject({ timeoutMs: 1_000 });
  });

  it("aborts with ClientDisconnectedError when the connection closes before the response finished", () => {
    const res = new FakeResponse();
    const signal = createRequestSignal(res, { timeoutMs: 1_000 });

    res.disconnect();

    expect(signal.reason).toBeInstanceOf(ClientDisconnectedError);
  });

  it("does not abort after a completed response and clears the deadline timer", () => {
    const res = new FakeResponse();
    const signal = createRequestSignal(res, { timeoutMs: 1_000 });

    res.finish();
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(5_000);
    expect(signal.aborted).toBe(false);
  });

  it("aborts with ServerShuttingDownError when the shutdown signal aborts", () => {
    const shutdown = new AbortController();
    const signal = createRequestSignal(new FakeResponse(), {
      timeoutMs: 1_000,
      shutdownSignal: shutdown.signal,
    });

    expect(signal.aborted).toBe(false);
    shutdown.abort();

    expect(signal.reason).toBeInstanceOf(ServerShuttingDownError);
  });

  it("is aborted immediately when shutdown already started", () => {
    const shutdown = new AbortController();
    shutdown.abort();

    const signal = createRequestSignal(new FakeResponse(), {
      timeoutMs: 1_000,
      shutdownSignal: shutdown.signal,
    });

    expect(signal.reason).toBeInstanceOf(ServerShuttingDownError);
  });

  it("keeps the first reason: a disconnect after the deadline stays a deadline", () => {
    const res = new FakeResponse();
    const signal = createRequestSignal(res, { timeoutMs: 1_000 });

    vi.advanceTimersByTime(1_000);
    res.disconnect();

    expect(signal.reason).toBeInstanceOf(RequestDeadlineExceededError);
  });

  it("removes its listener from the shutdown signal once the response closes", () => {
    const shutdown = new AbortController();
    const remove = vi.spyOn(shutdown.signal, "removeEventListener");
    const res = new FakeResponse();
    const signal = createRequestSignal(res, {
      timeoutMs: 1_000,
      shutdownSignal: shutdown.signal,
    });

    res.finish();
    shutdown.abort();

    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(signal.aborted).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects timeoutMs %s", (timeoutMs) => {
    expect(() => createRequestSignal(new FakeResponse(), { timeoutMs })).toThrow(
      RangeError,
    );
  });
});
