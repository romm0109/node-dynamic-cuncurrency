// src/observability.ts
/**
 * No-op backend used when no observability is configured.
 */
export class NoOpBackend {
    recordMetrics(_metrics) {
        // intentionally empty
    }
}
/**
 * Logs pool metrics to console. Useful for development and debugging.
 */
export class ConsoleLogBackend {
    lastLogTime = 0;
    minIntervalMs;
    constructor(minIntervalMs = 1000) {
        this.minIntervalMs = minIntervalMs;
    }
    recordMetrics(metrics) {
        const now = Date.now();
        if (now - this.lastLogTime < this.minIntervalMs)
            return;
        this.lastLogTime = now;
        console.log(`[adaptive-concurrency] c=${metrics.concurrency.toFixed(1)} ` +
            `active=${metrics.active} queued=${metrics.queued} ` +
            `ok=${metrics.completed} fail=${metrics.failed} ` +
            `tmo=${metrics.timedOut}`);
    }
}
/**
 * Collects metrics in memory for testing and programmatic inspection.
 */
export class InMemoryBackend {
    snapshots = [];
    events = [];
    recordMetrics(metrics) {
        this.snapshots.push({ ...metrics });
    }
    onEnqueue(queueDepth) {
        this.events.push({ type: 'enqueue', data: { queueDepth } });
    }
    onStart() {
        this.events.push({ type: 'start' });
    }
    onSuccess(durationMs) {
        this.events.push({ type: 'success', data: { durationMs } });
    }
    onError(severity, durationMs) {
        this.events.push({ type: 'error', data: { severity, durationMs } });
    }
    onQueueTimeout(waitTimeMs) {
        this.events.push({ type: 'queueTimeout', data: { waitTimeMs } });
    }
    onConcurrencyChange(oldLimit, newLimit) {
        this.events.push({ type: 'concurrencyChange', data: { oldLimit, newLimit } });
    }
    clear() {
        this.snapshots.length = 0;
        this.events.length = 0;
    }
}
