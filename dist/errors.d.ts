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
export declare class ClassifiedError extends Error {
    readonly severity: ErrorSeverity;
    readonly cause: unknown;
    constructor(message: string, severity: ErrorSeverity, cause?: unknown);
}
/**
 * Error thrown when a queued task times out before execution begins.
 */
export declare class QueueTimeoutError extends Error {
    readonly waitTimeMs: number;
    constructor(waitTimeMs: number);
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
export declare class DefaultHttpErrorClassifier implements ErrorClassifier {
    classify(error: unknown): ErrorSeverity;
}
