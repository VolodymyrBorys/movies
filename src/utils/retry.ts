import { setTimeout as sleep } from "node:timers/promises";

interface RetryOptions {
  maxAttempts: number;
  shouldRetry: (error: unknown) => boolean;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export async function retry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const {
    maxAttempts,
    shouldRetry,
    baseDelayMs = 50,
    maxDelayMs = 500,
  } = options;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts must be a positive integer");
  }

  for (let attempt = 1; ; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= maxAttempts || !shouldRetry(error)) {
        throw error;
      }

      const cap = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);

      // Full jitter: випадкова затримка від 0 до cap.
      const delayMs = Math.floor(Math.random() * (cap + 1));

      await sleep(delayMs);
    }
  }
}
