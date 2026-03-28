// src/pool.ts
import { DefaultHttpErrorClassifier, QueueTimeoutError } from './errors.js';
import { NoOpBackend } from './observability.js';
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
export class AdaptivePool {
    concurrencyLimit;
    minConcurrency;
    maxConcurrency;
    increaseBy;
    decreaseFactor;
    queueTimeoutMs;
    maxQueueSize;
    classifier;
    observability;
    activeCount = 0;
    queue = [];
    _completed = 0;
    _failed = 0;
    _timedOut = 0;
    _transientErrors = 0;
    _fatalErrors = 0;
    _drainResolvers = [];
    _shutdown = false;
    constructor(options = {}) {
        this.concurrencyLimit = options.concurrency ?? 10;
        this.minConcurrency = options.minConcurrency ?? 1;
        this.maxConcurrency = this.concurrencyLimit;
        this.increaseBy = options.increaseBy ?? 1;
        this.decreaseFactor = options.decreaseFactor ?? 0.5;
        this.queueTimeoutMs = options.queueTimeoutMs ?? 30_000;
        this.maxQueueSize = options.maxQueueSize ?? Infinity;
        this.classifier = options.errorClassifier ?? new DefaultHttpErrorClassifier();
        this.observability = options.observability ?? new NoOpBackend();
    }
    /**
     * Submit a task to the pool. Returns a promise that resolves with the
     * task's result or rejects with an error.
     *
     * If the pool is at its concurrency limit, the task is queued. If the
     * queue timeout elapses before the task starts, a {@link QueueTimeoutError}
     * is thrown.
     */
    submit(task) {
        if (this._shutdown) {
            return Promise.reject(new Error('Pool is shut down'));
        }
        if (this.activeCount < Math.floor(this.concurrencyLimit)) {
            return this.execute(task);
        }
        if (this.queue.length >= this.maxQueueSize) {
            return Promise.reject(new QueueTimeoutError(0));
        }
        return this.enqueue(task);
    }
    /**
     * Wait for all queued and active tasks to complete.
     */
    drain() {
        if (this.activeCount === 0 && this.queue.length === 0) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this._drainResolvers.push(resolve);
        });
    }
    /**
     * Permanently shut down the pool. Rejects all queued tasks.
     */
    shutdown() {
        this._shutdown = true;
        for (const item of this.queue) {
            if (item.timer !== undefined)
                clearTimeout(item.timer);
            item.reject(new Error('Pool shut down'));
        }
        this.queue.length = 0;
        this.emitMetrics();
    }
    /**
     * Current snapshot of pool metrics.
     */
    get metrics() {
        return this.snapshotMetrics();
    }
    /**
     * Current effective concurrency limit (may be fractional).
     */
    get concurrency() {
        return this.concurrencyLimit;
    }
    // ── private ──────────────────────────────────────────────
    enqueue(task) {
        return new Promise((resolve, reject) => {
            const item = {
                task,
                resolve,
                reject,
                enqueuedAt: Date.now(),
            };
            if (this.queueTimeoutMs > 0 && this.queueTimeoutMs !== Infinity) {
                item.timer = setTimeout(() => {
                    const idx = this.queue.indexOf(item);
                    const waitTime = Date.now() - item.enqueuedAt;
                    if (idx !== -1) {
                        this.queue.splice(idx, 1);
                        this._timedOut++;
                        this.observability.onQueueTimeout?.(waitTime);
                        this.emitMetrics();
                    }
                    reject(new QueueTimeoutError(waitTime));
                }, this.queueTimeoutMs);
            }
            this.queue.push(item);
            this.observability.onEnqueue?.(this.queue.length);
        });
    }
    async execute(task) {
        this.activeCount++;
        this.observability.onStart?.();
        this.emitMetrics();
        const start = Date.now();
        try {
            const value = await task();
            const duration = Date.now() - start;
            this._completed++;
            this.observability.onSuccess?.(duration);
            this.increaseConcurrency();
            return value;
        }
        catch (err) {
            const duration = Date.now() - start;
            this._failed++;
            const severity = this.classifier.classify(err);
            if (severity === 'transient' || severity === 'unknown') {
                this._transientErrors++;
                this.decreaseConcurrency();
            }
            else {
                this._fatalErrors++;
            }
            this.observability.onError?.(severity, duration);
            throw err;
        }
        finally {
            this.activeCount--;
            this.emitMetrics();
            this.processQueue();
            this.checkDrain();
        }
    }
    processQueue() {
        const slot = Math.floor(this.concurrencyLimit) - this.activeCount;
        for (let i = 0; i < slot && this.queue.length > 0; i++) {
            const item = this.queue.shift();
            if (item.timer !== undefined)
                clearTimeout(item.timer);
            // Fire-and-forget: errors propagate via the item's own reject
            this.execute(item.task).then(item.resolve, item.reject);
        }
    }
    increaseConcurrency() {
        const old = this.concurrencyLimit;
        this.concurrencyLimit = Math.min(this.concurrencyLimit + this.increaseBy, this.maxConcurrency);
        if (this.concurrencyLimit !== old) {
            this.observability.onConcurrencyChange?.(old, this.concurrencyLimit);
        }
    }
    decreaseConcurrency() {
        const old = this.concurrencyLimit;
        this.concurrencyLimit = Math.max(this.concurrencyLimit * (1 - this.decreaseFactor), this.minConcurrency);
        if (this.concurrencyLimit !== old) {
            this.observability.onConcurrencyChange?.(old, this.concurrencyLimit);
        }
    }
    checkDrain() {
        if (this.activeCount === 0 && this.queue.length === 0) {
            const resolvers = this._drainResolvers;
            this._drainResolvers = [];
            for (const r of resolvers)
                r();
        }
    }
    snapshotMetrics() {
        return {
            concurrency: this.concurrencyLimit,
            active: this.activeCount,
            queued: this.queue.length,
            completed: this._completed,
            failed: this._failed,
            timedOut: this._timedOut,
            transientErrors: this._transientErrors,
            fatalErrors: this._fatalErrors,
        };
    }
    emitMetrics() {
        this.observability.recordMetrics(this.snapshotMetrics());
    }
}
