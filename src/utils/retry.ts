import { log } from "./logger";

/**
 * Promise-chain rate limiter.
 * Serializes async calls and enforces a minimum average request interval.
 * More robust than sleep-based limiters for concurrent workloads.
 */
export class RateLimiter {
  private readonly intervalMs: number;
  private tail: Promise<void> = Promise.resolve();
  private lastStartedAt = 0;

  constructor(requestsPerSecond: number) {
    if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0) {
      throw new Error("requestsPerSecond must be > 0");
    }
    this.intervalMs = 1000 / requestsPerSecond;
  }

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    let resolveOuter!: (value: T | PromiseLike<T>) => void;
    let rejectOuter!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveOuter = resolve;
      rejectOuter = reject;
    });

    this.tail = this.tail.then(async () => {
      const wait = Math.max(0, this.intervalMs - (Date.now() - this.lastStartedAt));
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastStartedAt = Date.now();
      try {
        resolveOuter(await fn());
      } catch (error) {
        rejectOuter(error);
      }
    });

    return result;
  }
}

/**
 * Retry with exponential backoff.
 * Handles 429 (rate limit) and transient errors with jitter.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    onRetry?: (attempt: number, error: Error) => void;
  },
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 1000;
  const maxDelayMs = options?.maxDelayMs ?? 10000;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt >= maxRetries) break;

      const is429 = lastError.message.includes("429");
      const delayMs = is429
        ? Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000)
        : Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt));

      log.warn(
        {
          attempt: attempt + 1,
          maxRetries,
          delayMs,
          is429,
          error: lastError.message.slice(0, 100),
        },
        "Retrying after error",
      );

      options?.onRetry?.(attempt + 1, lastError);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  throw lastError;
}
