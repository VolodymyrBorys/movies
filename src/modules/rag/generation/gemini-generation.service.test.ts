import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only external I/O is replaced: the Gemini client and the backoff sleep.
// Retry / timeout / cancellation logic under test stays real.
const { generateContent, sleep } = vi.hoisted(() => ({
  generateContent: vi.fn(),
  sleep: vi.fn(),
}));

vi.mock("../../../infrastructure/gemini/gemini.client.ts", () => ({
  geminiClient: { models: { generateContent } },
}));

vi.mock("node:timers/promises", () => ({ setTimeout: sleep }));

const { GeminiGenerationService } = await import(
  "./gemini-generation.service.ts"
);

type SleepOptions = { signal?: AbortSignal } | undefined;
type GenerateArgs = { model: string; contents: string; config: { abortSignal: AbortSignal } };

const input = { question: "How does recovery work?", context: "WAL replay." };

function apiError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

/** Never resolves; rejects with the signal's reason when the request signal aborts. */
function pendingUntilAborted({ config }: GenerateArgs): Promise<never> {
  return new Promise((_, reject) => {
    config.abortSignal.addEventListener(
      "abort",
      () => reject(config.abortSignal.reason),
      { once: true },
    );
  });
}

describe("GeminiGenerationService", () => {
  const service = new GeminiGenerationService();

  beforeEach(() => {
    generateContent.mockReset();
    sleep.mockReset();
    // Default backoff: resolves immediately, but honours cancellation like the real one.
    sleep.mockImplementation(async (_ms: number, _value: unknown, options: SleepOptions) => {
      options?.signal?.throwIfAborted();
    });
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("success", () => {
    it("returns the trimmed answer and the model in one call", async () => {
      generateContent.mockResolvedValue({ text: "  answer  " });

      const result = await service.generate(input);

      expect(generateContent).toHaveBeenCalledTimes(1);
      const [args] = generateContent.mock.calls[0] as [GenerateArgs];
      expect(result).toEqual({ answer: "answer", model: args.model });
      expect(args.contents).toContain(input.context);
      expect(args.contents).toContain(input.question);
      expect(args.config.abortSignal).toBeInstanceOf(AbortSignal);
      expect(args.config.abortSignal.aborted).toBe(false);
    });

    it("clears the per-attempt timeout timer", async () => {
      vi.useFakeTimers();
      generateContent.mockResolvedValue({ text: "answer" });

      await service.generate(input);

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("validation", () => {
    it.each([
      [{ question: "  ", context: "ctx" }, "Question cannot be empty"],
      [{ question: "q", context: "  " }, "Context cannot be empty"],
    ])("rejects %o without calling Gemini", async (bad, message) => {
      await expect(service.generate(bad)).rejects.toThrow(message);
      expect(generateContent).not.toHaveBeenCalled();
    });
  });

  describe("retries", () => {
    it("retries retryable errors with exponential backoff, then succeeds", async () => {
      generateContent
        .mockRejectedValueOnce(apiError(503))
        .mockRejectedValueOnce(apiError(503))
        .mockResolvedValueOnce({ text: "answer" });

      const result = await service.generate(input);

      expect(result.answer).toBe("answer");
      expect(generateContent).toHaveBeenCalledTimes(3);
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 2_000]);
    });

    it("adds bounded jitter to the backoff delay", async () => {
      vi.mocked(Math.random).mockReturnValue(0.999);
      generateContent
        .mockRejectedValueOnce(apiError(429))
        .mockResolvedValueOnce({ text: "answer" });

      await service.generate(input);

      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_249]);
    });

    it("rethrows the original error after the last attempt", async () => {
      const error = apiError(503);
      generateContent.mockRejectedValue(error);

      await expect(service.generate(input)).rejects.toBe(error);
      expect(generateContent).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(2);
    });

    it.each([400, 401, 403, 404])("does not retry HTTP %i", async (status) => {
      generateContent.mockRejectedValue(apiError(status));

      await expect(service.generate(input)).rejects.toThrow(`HTTP ${status}`);
      expect(generateContent).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it("does not retry an empty model response", async () => {
      generateContent.mockResolvedValue({ text: "   " });

      await expect(service.generate(input)).rejects.toThrow("empty response");
      expect(generateContent).toHaveBeenCalledTimes(1);
    });

    it("passes no signal to backoff when the caller gave none", async () => {
      generateContent
        .mockRejectedValueOnce(apiError(503))
        .mockResolvedValueOnce({ text: "answer" });

      await service.generate(input);

      expect(sleep.mock.calls[0]?.[2]).toBeUndefined();
    });
  });

  describe("timeout", () => {
    it("fails after 60s per attempt and does not retry", async () => {
      vi.useFakeTimers();
      generateContent.mockImplementation(pendingUntilAborted);

      const assertion = expect(service.generate(input)).rejects.toThrow(
        "Gemini request timed out after 60000ms",
      );
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;

      expect(generateContent).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });
  });

  describe("caller cancellation", () => {
    it("does not call Gemini when the signal is already aborted", async () => {
      await expect(
        service.generate({ ...input, signal: AbortSignal.abort() }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(generateContent).not.toHaveBeenCalled();
    });

    it("aborts the in-flight request and does not retry", async () => {
      const caller = new AbortController();
      generateContent.mockImplementation((args: GenerateArgs) => {
        const pending = pendingUntilAborted(args);
        caller.abort();
        return pending;
      });

      await expect(
        service.generate({ ...input, signal: caller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(generateContent).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it("cancellation wins over a retryable error: no backoff, no retry", async () => {
      const caller = new AbortController();
      const error = apiError(503);
      generateContent.mockImplementation(async () => {
        caller.abort();
        throw error;
      });

      await expect(
        service.generate({ ...input, signal: caller.signal }),
      ).rejects.toBe(error);
      expect(generateContent).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it("interrupts the backoff wait and makes no further attempt", async () => {
      const caller = new AbortController();
      generateContent.mockRejectedValue(apiError(503));
      sleep.mockImplementationOnce(
        async (_ms: number, _value: unknown, options: SleepOptions) => {
          expect(options?.signal).toBe(caller.signal);
          caller.abort();
          options?.signal?.throwIfAborted();
        },
      );

      await expect(
        service.generate({ ...input, signal: caller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(generateContent).toHaveBeenCalledTimes(1);
    });
  });
});
