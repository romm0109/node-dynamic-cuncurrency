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
export declare class NoOpBackend implements ObservabilityBackend {
    recordMetrics(_metrics: PoolMetrics): void;
}
/**
 * Logs pool metrics to console. Useful for development and debugging.
 */
export declare class ConsoleLogBackend implements ObservabilityBackend {
    private lastLogTime;
    private readonly minIntervalMs;
    constructor(minIntervalMs?: number);
    recordMetrics(metrics: PoolMetrics): void;
}
/**
 * Collects metrics in memory for testing and programmatic inspection.
 */
export declare class InMemoryBackend implements ObservabilityBackend {
    readonly snapshots: PoolMetrics[];
    readonly events: Array<{
        type: string;
        data?: any;
    }>;
    recordMetrics(metrics: PoolMetrics): void;
    onEnqueue?(queueDepth: number): void;
    onStart?(): void;
    onSuccess?(durationMs: number): void;
    onError?(severity: string, durationMs: number): void;
    onQueueTimeout?(waitTimeMs: number): void;
    onConcurrencyChange?(oldLimit: number, newLimit: number): void;
    clear(): void;
}
