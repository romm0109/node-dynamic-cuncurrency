/**
 * tests/queue-timeout.test.ts — Tests for queue timeout semantics
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptivePool, QueueTimeoutError, InMemoryBackend } from '../dist/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('queue timeout semantics', () => {
  it('should reject queued tasks that exceed queueTimeoutMs', async () => {
    const pool = new AdaptivePool({
      concurrency: 1,
      queueTimeoutMs: 50,
    });

    // Block the single slot for 200ms
    const blocker = pool.submit(() => sleep(200));

    // This task should time out in queue after ~50ms
    await assert.rejects(
      () => pool.submit(() => Promise.resolve('late')),
      (err: unknown) => {
        assert.ok(err instanceof QueueTimeoutError);
        assert.ok(err.waitTimeMs >= 40, `waitTimeMs=${err.waitTimeMs} expected >= 40`);
        return true;
      }
    );

    // Wait for the blocker then clean up
    await blocker.catch(() => {});
    pool.shutdown();
  });

  it('should respect maxQueueSize by rejecting immediately', async () => {
    const pool = new AdaptivePool({
      concurrency: 1,
      maxQueueSize: 2,
      queueTimeoutMs: 30_000,  // long timeout, queue size is the limiter
    });

    // 1 active + 2 queued = 3 total
    const t1 = pool.submit(() => sleep(200));  // active
    const t2 = pool.submit(() => sleep(200));  // queued [0]
    const t3 = pool.submit(() => sleep(200));  // queued [1]

    // 4th should be rejected immediately (queue full)
    await assert.rejects(
      () => pool.submit(() => Promise.resolve('overflow')),
      (err: unknown) => {
        assert.ok(err instanceof QueueTimeoutError);
        assert.equal(err.waitTimeMs, 0, 'Should be rejected immediately, not timed out');
        return true;
      }
    );

    // Await all tasks to prevent unhandled rejections
    await Promise.allSettled([t1, t2, t3]);
    pool.shutdown();
  });

  it('should not time out tasks that start before the deadline', async () => {
    const pool = new AdaptivePool({
      concurrency: 2,
      queueTimeoutMs: 500,
    });

    // Two tasks run concurrently (within limit)
    const results = await Promise.all([
      pool.submit(() => sleep(50).then(() => 'a')),
      pool.submit(() => sleep(50).then(() => 'b')),
    ]);

    assert.deepEqual(results, ['a', 'b']);
    pool.shutdown();
  });

  it('should reject tasks after shutdown', async () => {
    const pool = new AdaptivePool({ concurrency: 1 });
    pool.shutdown();

    await assert.rejects(
      () => pool.submit(() => Promise.resolve('nope')),
      /Pool is shut down/
    );
  });

  it('should emit onQueueTimeout events via observability', async () => {
    const backend = new InMemoryBackend();
    const pool = new AdaptivePool({
      concurrency: 1,
      queueTimeoutMs: 30,
      observability: backend,
    });

    pool.submit(() => sleep(200));

    try {
      await pool.submit(() => Promise.resolve('x'));
    } catch {
      // expected timeout
    }

    await pool.drain();

    const timeoutEvents = backend.events.filter((e) => e.type === 'queueTimeout');
    assert.ok(timeoutEvents.length >= 1, `Expected at least 1 queueTimeout event, got ${timeoutEvents.length}`);

    pool.shutdown();
  });
});
