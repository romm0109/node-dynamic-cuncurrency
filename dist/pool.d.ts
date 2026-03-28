import { ErrorClassifier } from './errors.js';
import { ObservabilityBackend, PoolMetrics } from './observability.js';
export interface AdaptivePoolOptions {
    /**
     * Initial and maximum concurrency limit.
     * The pool starts here and never exceeds this value.
     * @default 10
     */
    concurrency?: number;
    /**
     * Minimum concurrency floor. The pool will never drop below this.
     * @default 1
     */
    minConcurrency?: number;
    /**
     * AIMD additive increase: how many slots to add per success.
     * A value of 1 means "add 1 slot per successful task."
     * @default 1
     */
    increaseBy?: number;
    /**
     * AIMD multiplicative decrease factor on transient errors.
     * New limit = current * (1 - decreaseFactor).
     * @default 0.5
     */
    decreaseFactor?: number;
    /**
     * Queue timeout in ms. Tasks waiting longer than this are rejected
     * with a {@link QueueTimeoutError}.
     * Set to 0 or Infinity to disable.
     * @default 30000
     */
    queueTimeoutMs?: number;
    /**
     * Maximum queue depth. Tasks submitted when the queue is full are
     * immediately rejected with a {@link QueueTimeoutError}.
     * @default Infinity
     */
    maxQueueSize?: number;
    /**
     * Custom error classifier. Defaults to {@link DefaultHttpErrorClassifier}.
     */
    errorClassifier?: ErrorClassifier;
    /**
     * Observability backend for metrics collection.
     * Defaults to a no-op backend.
     */
    observability?: ObservabilityBackend;
}
export interface TaskResult<T> {
    success: boolean;
    value?: T;
    error?: Error;
    durationMs: number;
}
/**
 * An adaptive concurrency pool using AIMD (Additive Increase / Multiplicative Decrease).
 *
 * The pool dynamically adjusts its concurrency limit based on task outcomes:
 * - On success: limit increases by `increaseBy` (additive increase).
 * - On transient error: limit is multiplied by `(1 - decreaseFactor)` (multiplicative decrease).
 * - On fatal error: no concurrency change; the error propagates immediately.
 * - On unknown error: treated as transient (conservative default).
 *
 * @typeParam T - The return type of tasks submitted to the pool.
 *
 * @example
 * ```ts
 * import { AdaptivePool } from 'adaptive-concurrency';
 *
 * const pool = new AdaptivePool({ concurrency: 5 });
 * const results = await Promise.all([
 *   pool.submit(() => fetch('/api/1')),
 *   pool.submit(() => fetch('/api/2')),
 * ]);
 * await pool.drain();
 * pool.shutdown();
 * ```
 */
export declare class AdaptivePool<T = unknown> {
    private concurrencyLimit;
    private readonly minConcurrency;
    private readonly maxConcurrency;
    private readonly increaseBy;
    private readonly decreaseFactor;
    private readonly queueTimeoutMs;
    private readonly maxQueueSize;
    private readonly classifier;
    private readonly observability;
    private activeCount;
    private queue;
    private _completed;
    private _failed;
    private _timedOut;
    private _transientErrors;
    private _fatalErrors;
    private _drainResolvers;
    private _shutdown;
    constructor(options?: AdaptivePoolOptions);
    /**
     * Submit a task to the pool. Returns a promise that resolves with the
     * task's result or rejects with an error.
     *
     * If the pool is at its concurrency limit, the task is queued. If the
     * queue timeout elapses before the task starts, a {@link QueueTimeoutError}
     * is thrown.
     */
    submit(task: () => Promise<T>): Promise<T>;
    /**
     * Wait for all queued and active tasks to complete.
     */
    drain(): Promise<void>;
    /**
     * Permanently shut down the pool. Rejects all queued tasks.
     */
    shutdown(): void;
    /**
     * Current snapshot of pool metrics.
     */
    get metrics(): PoolMetrics;
    /**
     * Current effective concurrency limit (may be fractional).
     */
    get concurrency(): number;
    private enqueue;
    private execute;
    private processQueue;
    private increaseConcurrency;
    private decreaseConcurrency;
    private checkDrain;
    private snapshotMetrics;
    private emitMetrics;
}
