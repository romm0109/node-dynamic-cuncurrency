// src/errors.ts

/**
 * Error severity levels used for concurrency decisions.
 *
 * - `transient` — The downstream may recover (e.g. 429, 503, timeout).
 *   Triggers additive-increase/multiplicative-decrease (AIMD) back-off.
 * - `fatal` — The request will never succeed with current parameters (e.g. 401, 403, 400).
 *   Does NOT affect concurrency; the error propagates immediately.
 * - `unknown` — The pool cannot classify the error (safe default).
 *   Treated as transient for safety, reducing concurrency conservatively.
 */
export type ErrorSeverity = 'transient' | 'fatal' | 'unknown';

/**
 * A classified error wrapping the original with a severity tag.
 */
export class ClassifiedError extends Error {
  public readonly severity: ErrorSeverity;
  public readonly cause: unknown;

  constructor(message: string, severity: ErrorSeverity, cause?: unknown) {
    super(message);
    this.name = 'ClassifiedError';
    this.severity = severity;
    this.cause = cause;
  }
}

/**
 * Error thrown when a queued task times out before execution begins.
 */
export class QueueTimeoutError extends Error {
  public readonly waitTimeMs: number;

  constructor(waitTimeMs: number) {
    super(`Task timed out in queue after ${waitTimeMs}ms`);
    this.name = 'QueueTimeoutError';
    this.waitTimeMs = waitTimeMs;
  }
}

export interface ErrorClassifier {
  classify(error: unknown): ErrorSeverity;
}

/**
 * Default classifier that inspects HTTP-like errors for status codes.
 *
 * Rules:
 * | Status pattern        | Severity   |
 * |----------------------|------------|
 * | 429, 502, 503, 504   | transient  |
 * | 400, 401, 403, 404, 422 | fatal   |
 * | ECONNRESET, ECONNREFUSED, ETIMEDOUT | transient |
 * | AbortError           | transient  |
 * | anything else        | unknown    |
 */
export class DefaultHttpErrorClassifier implements ErrorClassifier {
  classify(error: unknown): ErrorSeverity {
    if (error instanceof ClassifiedError) {
      return error.severity;
    }

    // HTTP status code inspection
    const status = (error as any)?.status ?? (error as any)?.statusCode;
    if (typeof status === 'number') {
      if ([429, 502, 503, 504].includes(status)) return 'transient';
      if (status >= 400 && status < 500) return 'fatal';
      if (status >= 500) return 'transient';
    }

    // Error code inspection
    const code = (error as any)?.code;
    if (typeof code === 'string') {
      if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND'].includes(code)) {
        return 'transient';
      }
    }

    // Error name inspection
    if (error instanceof Error) {
      if (error.name === 'AbortError') return 'transient';
      if (error.name === 'TimeoutError') return 'transient';
    }

    return 'unknown';
  }
}
