# adaptive-concurrency — Usage Guide

An adaptive concurrency control library for Node.js async workloads.
Uses **AIMD** (Additive Increase / Multiplicative Decrease) to dynamically
adjust concurrency based on real-time task outcomes.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Factory-Per-Downstream Usage](#factory-per-downstream-usage)
3. [Queue Timeout Semantics](#queue-timeout-semantics)
4. [Error Classification Defaults](#error-classification-defaults)
5. [Observability Integration](#observability-integration)
6. [Adaptive vs Fixed Concurrency](#adaptive-vs-fixed-concurrency)
7. [API Reference](#api-reference)

---

## Quick Start

```ts
import { AdaptivePool } from 'adaptive-concurrency';

const pool = new AdaptivePool({ concurrency: 5 });

// Submit tasks — they run up to 5 at a time
const results = await Promise.all(
  Array.from({ length: 20 }, (_, i) =>
    pool.submit(() => doWork(i))
  )
);

await pool.drain();  // wait for everything to finish
pool.shutdown();     // clean up resources
```

See [`examples/basic-async.ts`](../examples/basic-async.ts) for a runnable version.

---

## Factory-Per-Downstream Usage

When your application talks to **multiple distinct downstream services**,
you typically want **independent** concurrency control for each one.
A slow or failing payment API should not throttle calls to your cache layer.

### The Problem with a Single Pool

```ts
// BAD: one pool for all downstreams
const pool = new AdaptivePool({ concurrency: 10 });
// If payments-service is slow, it consumes all slots
// and starves the cache-service
await pool.submit(() => callPaymentsService());
await pool.submit(() => callCacheService());
```

### Solution: PoolManager with a Factory Function

```ts
import { PoolManager } from 'adaptive-concurrency';

const manager = new PoolManager<string>((downstream) => {
  // Customize pool settings per downstream
  switch (downstream) {
    case 'payments':
      return { concurrency: 3, queueTimeoutMs: 5000 };
    case 'cache':
      return { concurrency: 20, queueTimeoutMs: 1000 };
    default:
      return { concurrency: 10 };
  }
});

// Each key gets its own pool, created lazily
await manager.submit('payments', () => chargeCard(order));
await manager.submit('cache', () => cache.get(userId));
await manager.submit('payments', () => refund(prev)); // reuses payments pool

await manager.drainAll();
manager.shutdownAll();
```

### Why Factory-Per-Downstream?

| Benefit | Explanation |
|---------|-------------|
| **Isolation** | A failing downstream cannot starve others |
| **Per-service tuning** | Different SLAs → different concurrency limits |
| **Independent AIMD** | Each pool adapts to its own error rates |
| **Lazy creation** | Pools are only created when first needed |
| **Per-service observability** | Metrics are scoped per downstream |

See [`examples/factory-per-downstream.ts`](../examples/factory-per-downstream.ts)
for a runnable example.

---

## Queue Timeout Semantics

When more tasks are submitted than the current concurrency limit allows,
excess tasks are placed in a **bounded queue**. Two mechanisms prevent
unbounded waiting:

### `queueTimeoutMs` — Wall-Clock Timeout

Tasks that wait longer than `queueTimeoutMs` are rejected with
a `QueueTimeoutError`:

```ts
const pool = new AdaptivePool({
  concurrency: 1,         // only 1 task at a time
  queueTimeoutMs: 100,    // 100ms patience
});

// Task 1 occupies the slot
pool.submit(() => sleep(200));

// Task 2 waits in queue → times out after ~100ms
try {
  await pool.submit(() => sleep(10));
} catch (err) {
  console.log(err instanceof QueueTimeoutError);  // true
  console.log((err as QueueTimeoutError).waitTimeMs); // ~100
}
```

### `maxQueueSize` — Depth Limit

Instead of (or in addition to) a time limit, you can cap the queue depth:

```ts
const pool = new AdaptivePool({
  concurrency: 1,
  maxQueueSize: 5,  // only 5 tasks can wait
});

// Submit 7 tasks (1 active + 5 queued + 1 rejected)
for (let i = 0; i < 7; i++) {
  pool.submit(() => sleep(100)).catch((err) => {
    console.log(`Task ${i} rejected: ${err.message}`);
  });
}
// Output: "Task 6 rejected: Task timed out in queue after 0ms"
```

### Important Behaviors

- **Timeout starts at enqueue time**, not submit time.
- **Timer is cleared** when a queued task begins execution.
- **Timed-out tasks are removed** from the queue, freeing depth for others.
- **Setting `queueTimeoutMs: Infinity`** disables time-based rejection.
- **Shutting down the pool** immediately rejects all queued tasks.

---

## Error Classification Defaults

The pool uses an `ErrorClassifier` to decide how to react to errors.
The default classifier (`DefaultHttpErrorClassifier`) handles common HTTP
and Node.js error patterns:

### Classification Rules

| Error Pattern | Severity | Effect on Concurrency |
|--------------|----------|----------------------|
| Status 429 (Too Many Requests) | `transient` | Multiplicative decrease |
| Status 502, 503, 504 | `transient` | Multiplicative decrease |
| Status 5xx (other) | `transient` | Multiplicative decrease |
| Status 4xx (400, 401, 403, 404, 422) | `fatal` | No change |
| `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT` | `transient` | Multiplicative decrease |
| `AbortError`, `TimeoutError` | `transient` | Multiplicative decrease |
| Everything else | `unknown` | Multiplicative decrease (conservative) |

### Why Fatal Errors Don't Reduce Concurrency

A 401 Unauthorized or 400 Bad Request will never succeed no matter how
many times you retry. Reducing concurrency would slow down all other
legitimate requests for no benefit.

### Custom Classifiers

```ts
import { AdaptivePool, ErrorClassifier, ErrorSeverity } from 'adaptive-concurrency';

const classifier: ErrorClassifier = {
  classify(error: unknown): ErrorSeverity {
    if (error instanceof MyRateLimitError) return 'transient';
    if (error instanceof ValidationError) return 'fatal';
    return 'unknown';
  },
};

const pool = new AdaptivePool({ errorClassifier: classifier });
```

---

## Observability Integration

The pool emits metrics through an `ObservabilityBackend`. Three backends
are included:

### Built-in Backends

```ts
import {
  NoOpBackend,       // silent (default)
  ConsoleLogBackend, // logs to stderr every ~1s
  InMemoryBackend,   // stores snapshots for testing
} from 'adaptive-concurrency';
```

### Using the InMemoryBackend (Testing)

```ts
import { AdaptivePool, InMemoryBackend } from 'adaptive-concurrency';

const backend = new InMemoryBackend();
const pool = new AdaptivePool({ observability: backend });

await pool.submit(() => doWork());
await pool.drain();

// Inspect recorded metrics
console.log(backend.snapshots);  // PoolMetrics[]
console.log(backend.events);     // { type, data }[]
```

### Custom Backend (Prometheus / OpenTelemetry)

```ts
import { ObservabilityBackend, PoolMetrics } from 'adaptive-concurrency';

class PrometheusBackend implements ObservabilityBackend {
  private concurrencyGauge: Gauge;
  private activeGauge: Gauge;
  private completedCounter: Counter;

  recordMetrics(m: PoolMetrics): void {
    this.concurrencyGauge.set(m.concurrency);
    this.activeGauge.set(m.active);
    this.completedCounter.inc(m.completed);
  }

  onError?(severity: string, durationMs: number): void {
    errorCounter.labels({ severity }).inc();
  }

  onConcurrencyChange?(oldLimit: number, newLimit: number): void {
    // Track AIMD adjustments
  }
}
```

### Available Hooks

| Hook | When Called | Payload |
|------|-----------|---------|
| `recordMetrics()` | After every state change | `PoolMetrics` snapshot |
| `onEnqueue()` | Task enters queue | `queueDepth: number` |
| `onStart()` | Task begins execution | — |
| `onSuccess()` | Task completes OK | `durationMs: number` |
| `onError()` | Task fails | `severity, durationMs` |
| `onQueueTimeout()` | Task times out in queue | `waitTimeMs: number` |
| `onConcurrencyChange()` | AIMD adjusts limit | `oldLimit, newLimit` |

---

## Adaptive vs Fixed Concurrency

### When to Use Adaptive Concurrency

| Scenario | Why Adaptive Wins |
|----------|-----------------|
| **Variable downstream capacity** | The downstream may slow down due to load, GC pauses, or deploys. Adaptive pools back off automatically. |
| **Multiple tenants on shared infrastructure** | One noisy tenant can cause server-side rate limiting. The pool adapts per-tenant. |
| **HTTP APIs with rate limits** | 429 responses trigger multiplicative decrease; when the limit window passes, the pool ramps back up. |
| **Unpredictable workloads** | You don't know the optimal concurrency upfront. The pool discovers it in real-time. |
| **Microservice meshes** | Each downstream service has different capacity; a single fixed limit is a lowest-common-denominator. |

### When Fixed Concurrency is Fine

| Scenario | Why Fixed is Simpler |
|----------|-------------------|
| **In-process CPU work** | Concurrency = CPU cores. No downstream to overwhelm. |
| **Local I/O (disk, SQLite)** | The bottleneck is the disk, not the network. A fixed limit based on disk queue depth is optimal. |
| **Known-stable downstream** | If the downstream has consistent latency and no rate limits, a fixed limit avoids unnecessary complexity. |
| **Very low throughput** | If you're making <10 req/s, adaptive control has little room to maneuver. |

### Decision Flow

```
Do you make network calls to external services?
  ├── No → Use fixed concurrency (or just Promise.all with a limit)
  └── Yes → Can the downstream rate-limit or slow down unpredictably?
       ├── No → Fixed is fine
       └── Yes → Use adaptive concurrency
```

---

## API Reference

### `AdaptivePool<T>`

| Member | Type | Description |
|--------|------|-------------|
| `constructor(options?)` | | Create a new pool |
| `submit(task)` | `Promise<T>` | Submit a task for execution |
| `drain()` | `Promise<void>` | Wait for all tasks to complete |
| `shutdown()` | `void` | Reject queued tasks, stop accepting new ones |
| `metrics` | `PoolMetrics` | Current metrics snapshot |
| `concurrency` | `number` | Current effective concurrency limit |

### `PoolManager<TKey>`

| Member | Type | Description |
|--------|------|-------------|
| `constructor(factory)` | | Create manager with per-key factory |
| `submit(key, task)` | `Promise<R>` | Submit to the pool for `key` |
| `getPool(key)` | `AdaptivePool` | Get or create pool for `key` |
| `drainAll()` | `Promise<void>` | Drain all pools |
| `shutdownAll()` | `void` | Shutdown all pools |
| `keys` | `TKey[]` | Active downstream keys |
| `size` | `number` | Number of active pools |

### `AdaptivePoolOptions`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `concurrency` | `number` | `10` | Initial + max concurrency |
| `minConcurrency` | `number` | `1` | Floor for AIMD decrease |
| `increaseBy` | `number` | `1` | Additive increase per success |
| `decreaseFactor` | `number` | `0.5` | Multiplicative decrease factor |
| `queueTimeoutMs` | `number` | `30000` | Queue wait timeout (ms) |
| `maxQueueSize` | `number` | `Infinity` | Max queue depth |
| `errorClassifier` | `ErrorClassifier` | `DefaultHttpErrorClassifier` | Error → severity mapping |
| `observability` | `ObservabilityBackend` | `NoOpBackend` | Metrics collector |
