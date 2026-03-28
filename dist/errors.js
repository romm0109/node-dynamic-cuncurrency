// src/errors.ts
/**
 * A classified error wrapping the original with a severity tag.
 */
export class ClassifiedError extends Error {
    severity;
    cause;
    constructor(message, severity, cause) {
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
    waitTimeMs;
    constructor(waitTimeMs) {
        super(`Task timed out in queue after ${waitTimeMs}ms`);
        this.name = 'QueueTimeoutError';
        this.waitTimeMs = waitTimeMs;
    }
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
export class DefaultHttpErrorClassifier {
    classify(error) {
        if (error instanceof ClassifiedError) {
            return error.severity;
        }
        // HTTP status code inspection
        const status = error?.status ?? error?.statusCode;
        if (typeof status === 'number') {
            if ([429, 502, 503, 504].includes(status))
                return 'transient';
            if (status >= 400 && status < 500)
                return 'fatal';
            if (status >= 500)
                return 'transient';
        }
        // Error code inspection
        const code = error?.code;
        if (typeof code === 'string') {
            if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND'].includes(code)) {
                return 'transient';
            }
        }
        // Error name inspection
        if (error instanceof Error) {
            if (error.name === 'AbortError')
                return 'transient';
            if (error.name === 'TimeoutError')
                return 'transient';
        }
        return 'unknown';
    }
}
