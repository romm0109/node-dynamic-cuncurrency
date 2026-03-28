// src/observability.ts

/**
 * Metrics emitted by the pool for external observability systems.
 */
export interface PoolMetrics {
  /** Current concurrency limit (float after AIMD adjustments) */
  concurrency: number;
  /** Number of tasks currently executing */
  active: number;
  /** Number of tasks waiting in the queue */
  queued: number;
  /** Total completed tasks (success + failure) */
  completed: number;
  /** Total failed tasks */
  failed: number;
  /** Total tasks that timed out while queued */
  timedOut: number;
  /** Number of transient errors observed */
  transientErrors: number;
  /** Number of fatal errors observed */
  fatalErrors: number;
}

/**
 * Abstract interface for observability backends.
 *
 * Implement this to feed metrics into Prometheus, Datadog,
 * OpenTelemetry, or a custom dashboard.
 */
export interface ObservabilityBackend {
  /** Called after every task completion or failure */
 recordMetrics(metrics: PoolMetrics): void;
  /** Called when a task is enqueued */
  onEnqueue?(queueDepth: number): void;
  /** Called when a task starts executing */
  onStart?(): void;
  /** Called when a task completes successfully */
  onSuccess?(durationMs: number): void;
  /** Called when a task fails */
  onError?(severity: string, durationMs: number): void;
  /** Called when a queued task times out */
  onQueueTimeout?(waitTimeMs: number): void;
  /** Called when the concurrency limit changes */
  onConcurrencyChange?(oldLimit: number, newLimit: number): void;
}

/**
 * No-op backend used when no observability is configured.
 */
export class NoOpBackend implements ObservabilityBackend {
  recordMetrics(_metrics: PoolMetrics): void {
    // intentionally empty
  }
}

/**
 * Logs pool metrics to console. Useful for development and debugging.
 */
export class ConsoleLogBackend implements ObservabilityBackend {
  private lastLogTime = 0;
  private readonly minIntervalMs: number;

  constructor(minIntervalMs = 1000) {
    this.minIntervalMs = minIntervalMs;
  }

  recordMetrics(metrics: PoolMetrics): void {
    const now = Date.now();
    if (now - this.lastLogTime < this.minIntervalMs) return;
    this.lastLogTime = now;
    console.log(
      `[adaptive-concurrency] c=${metrics.concurrency.toFixed(1)} ` +
      `active=${metrics.active} queued=${metrics.queued} ` +
      `ok=${metrics.completed} fail=${metrics.failed} ` +
      `tmo=${metrics.timedOut}`
    );
  }
}

/**
 * Collects metrics in memory for testing and programmatic inspection.
 */
export class InMemoryBackend implements ObservabilityBackend {
  public readonly snapshots: PoolMetrics[] = [];
  public readonly events: Array<{ type: string; data?: any }> = [];

  recordMetrics(metrics: PoolMetrics): void {
    this.snapshots.push({ ...metrics });
  }

  onEnqueue?(queueDepth: number): void {
    this.events.push({ type: 'enqueue', data: { queueDepth } });
  }

  onStart?(): void {
    this.events.push({ type: 'start' });
  }

  onSuccess?(durationMs: number): void {
    this.events.push({ type: 'success', data: { durationMs } });
  }

  onError?(severity: string, durationMs: number): void {
    this.events.push({ type: 'error', data: { severity, durationMs } });
  }

  onQueueTimeout?(waitTimeMs: number): void {
    this.events.push({ type: 'queueTimeout', data: { waitTimeMs } });
  }

  onConcurrencyChange?(oldLimit: number, newLimit: number): void {
    this.events.push({ type: 'concurrencyChange', data: { oldLimit, newLimit } });
  }

  clear(): void {
    this.snapshots.length = 0;
    this.events.length = 0;
  }
}
