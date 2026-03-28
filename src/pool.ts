// src/pool.ts

import { ErrorClassifier, DefaultHttpErrorClassifier, ErrorSeverity, QueueTimeoutError, ClassifiedError } from './errors.js';
import { ObservabilityBackend, PoolMetrics, NoOpBackend } from './observability.js';

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

interface QueuedTask<T> {
  task: () => Promise<T>;
  resolve: (result: T) => void;
  reject: (error: unknown) => void;
  enqueuedAt: number;
  timer?: ReturnType<typeof setTimeout>;
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
export class AdaptivePool<T = unknown> {
  private concurrencyLimit: number;
  private readonly minConcurrency: number;
  private readonly maxConcurrency: number;
  private readonly increaseBy: number;
  private readonly decreaseFactor: number;
  private readonly queueTimeoutMs: number;
  private readonly maxQueueSize: number;
  private readonly classifier: ErrorClassifier;
  private readonly observability: ObservabilityBackend;

  private activeCount = 0;
  private queue: QueuedTask<T>[] = [];
  private _completed = 0;
  private _failed = 0;
  private _timedOut = 0;
  private _transientErrors = 0;
  private _fatalErrors = 0;
  private _drainResolvers: Array<() => void> = [];
  private _shutdown = false;

  constructor(options: AdaptivePoolOptions = {}) {
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
  submit(task: () => Promise<T>): Promise<T> {
    if (this._shutdown) {
      return Promise.reject(new Error('Pool is shut down'));
    }

    if (this.activeCount < Math.floor(this.concurrencyLimit)) {
      return this.execute(task);
    }

    if (this.queue.length >= this.maxQueueSize) {
      return Promise.reject(
        new QueueTimeoutError(0)
      );
    }

    return this.enqueue(task);
  }

  /**
   * Wait for all queued and active tasks to complete.
   */
  drain(): Promise<void> {
    if (this.activeCount === 0 && this.queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._drainResolvers.push(resolve);
    });
  }

  /**
   * Permanently shut down the pool. Rejects all queued tasks.
   */
  shutdown(): void {
    this._shutdown = true;
    for (const item of this.queue) {
      if (item.timer !== undefined) clearTimeout(item.timer);
      item.reject(new Error('Pool shut down'));
    }
    this.queue.length = 0;
    this.emitMetrics();
  }

  /**
   * Current snapshot of pool metrics.
   */
  get metrics(): PoolMetrics {
    return this.snapshotMetrics();
  }

  /**
   * Current effective concurrency limit (may be fractional).
   */
  get concurrency(): number {
    return this.concurrencyLimit;
  }

  // ── private ──────────────────────────────────────────────

  private enqueue(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const item: QueuedTask<T> = {
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

  private async execute(task: () => Promise<T>): Promise<T> {
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
    } catch (err) {
      const duration = Date.now() - start;
      this._failed++;
      const severity = this.classifier.classify(err);

      if (severity === 'transient' || severity === 'unknown') {
        this._transientErrors++;
        this.decreaseConcurrency();
      } else {
        this._fatalErrors++;
      }

      this.observability.onError?.(severity, duration);
      throw err;
    } finally {
      this.activeCount--;
      this.emitMetrics();
      this.processQueue();
      this.checkDrain();
    }
  }

  private processQueue(): void {
    const slot = Math.floor(this.concurrencyLimit) - this.activeCount;
    for (let i = 0; i < slot && this.queue.length > 0; i++) {
      const item = this.queue.shift()!;
      if (item.timer !== undefined) clearTimeout(item.timer);

      // Fire-and-forget: errors propagate via the item's own reject
      this.execute(item.task).then(item.resolve, item.reject);
    }
  }

  private increaseConcurrency(): void {
    const old = this.concurrencyLimit;
    this.concurrencyLimit = Math.min(
      this.concurrencyLimit + this.increaseBy,
      this.maxConcurrency
    );
    if (this.concurrencyLimit !== old) {
      this.observability.onConcurrencyChange?.(old, this.concurrencyLimit);
    }
  }

  private decreaseConcurrency(): void {
    const old = this.concurrencyLimit;
    this.concurrencyLimit = Math.max(
      this.concurrencyLimit * (1 - this.decreaseFactor),
      this.minConcurrency
    );
    if (this.concurrencyLimit !== old) {
      this.observability.onConcurrencyChange?.(old, this.concurrencyLimit);
    }
  }

  private checkDrain(): void {
    if (this.activeCount === 0 && this.queue.length === 0) {
      const resolvers = this._drainResolvers;
      this._drainResolvers = [];
      for (const r of resolvers) r();
    }
  }

  private snapshotMetrics(): PoolMetrics {
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

  private emitMetrics(): void {
    this.observability.recordMetrics(this.snapshotMetrics());
  }
}
