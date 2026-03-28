/**
 * tests/basic-async.test.ts — Tests for the basic async example
 *
 * Imports and runs the documented example, verifying correct output.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptivePool, InMemoryBackend, QueueTimeoutError } from '../dist/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('basic-async example', () => {
  it('should run all tasks respecting concurrency limit', async () => {
    const backend = new InMemoryBackend();
    const pool = new AdaptivePool<string>({
      concurrency: 3,
      observability: backend,
    });

    const results: string[] = [];
    const tasks = Array.from({ length: 9 }, (_, i) =>
      pool.submit(async () => {
        await sleep(30);
        const msg = `task-${i}`;
        results.push(msg);
        return msg;
      })
    );

    const resolved = await Promise.all(tasks);
    await pool.drain();

    // All 9 tasks completed
    assert.equal(resolved.length, 9);
    assert.equal(results.length, 9);
    assert.equal(pool.metrics.completed, 9);
    assert.equal(pool.metrics.failed, 0);

    // Concurrency was never exceeded
    const maxActive = Math.max(...backend.snapshots.map((s) => s.active));
    assert.ok(maxActive <= 3, `Max active ${maxActive} exceeded concurrency limit of 3`);

    // Each result is unique
    const unique = new Set(resolved);
    assert.equal(unique.size, 9);

    pool.shutdown();
  });

  it('should allow concurrency to increase on successive successes', async () => {
    const pool = new AdaptivePool({ concurrency: 2 });

    // Run tasks that complete instantly
    for (let i = 0; i < 20; i++) {
      await pool.submit(() => Promise.resolve(i));
    }
    await pool.drain();

    // Concurrency should have stayed at max (2) since all succeeded
    assert.equal(pool.metrics.concurrency, 2);
    assert.equal(pool.metrics.completed, 20);

    pool.shutdown();
  });

  it('should decrease concurrency on transient errors', async () => {
    const pool = new AdaptivePool({
      concurrency: 10,
      decreaseFactor: 0.5,
    });

    // Cause a transient error (status 503)
    for (let i = 0; i < 5; i++) {
      try {
        await pool.submit(() =>
          Promise.reject({ status: 503, message: ' overloaded' })
        );
      } catch {
        // expected
      }
    }
    await pool.drain();

    // Concurrency should have decreased: 10 → 5 → 2.5 → 1.25 → 1
    assert.ok(
      pool.metrics.concurrency < 10,
      `Expected concurrency < 10, got ${pool.metrics.concurrency}`
    );
    assert.equal(pool.metrics.transientErrors, 5);

    pool.shutdown();
  });

  it('should not decrease concurrency on fatal errors', async () => {
    const pool = new AdaptivePool({ concurrency: 10 });

    // Fatal error: 401 Unauthorized
    for (let i = 0; i < 5; i++) {
      try {
        await pool.submit(() =>
          Promise.reject({ status: 401, message: 'Unauthorized' })
        );
      } catch {
        // expected
      }
    }
    await pool.drain();

    // Concurrency should NOT change for fatal errors
    assert.equal(pool.metrics.concurrency, 10);
    assert.equal(pool.metrics.fatalErrors, 5);
    assert.equal(pool.metrics.transientErrors, 0);

    pool.shutdown();
  });
});
