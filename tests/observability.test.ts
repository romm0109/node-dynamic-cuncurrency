/**
 * tests/observability.test.ts — Tests for observability integration
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptivePool, InMemoryBackend, NoOpBackend } from '../dist/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('observability integration', () => {
  it('should record metrics snapshots via InMemoryBackend', async () => {
    const backend = new InMemoryBackend();
    const pool = new AdaptivePool({ concurrency: 2, observability: backend });

    await pool.submit(() => Promise.resolve('done'));
    await pool.drain();

    assert.ok(backend.snapshots.length > 0, 'Expected at least one metrics snapshot');

    const last = backend.snapshots[backend.snapshots.length - 1];
    assert.equal(last.completed, 1);
    assert.equal(last.active, 0);
    assert.equal(last.concurrency, 2);

    pool.shutdown();
  });

  it('should fire onSuccess events for successful tasks', async () => {
    const backend = new InMemoryBackend();
    const pool = new AdaptivePool({ concurrency: 2, observability: backend });

    await pool.submit(() => Promise.resolve('ok'));
    await pool.drain();

    const successEvents = backend.events.filter((e) => e.type === 'success');
    assert.equal(successEvents.length, 1);
    assert.ok(successEvents[0].data.durationMs >= 0);

    pool.shutdown();
  });

  it('should fire onError events for failed tasks', async () => {
    const backend = new InMemoryBackend();
    const pool = new AdaptivePool({ concurrency: 2, observability: backend });

    try {
      await pool.submit(() => Promise.reject({ status: 503 }));
    } catch {
      // expected
    }
    await pool.drain();

    const errorEvents = backend.events.filter((e) => e.type === 'error');
    assert.equal(errorEvents.length, 1);
    assert.equal(errorEvents[0].data.severity, 'transient');

    pool.shutdown();
  });

  it('should fire onStart events', async () => {
    const backend = new InMemoryBackend();
    const pool = new AdaptivePool({ concurrency: 2, observability: backend });

    await pool.submit(() => Promise.resolve('x'));
    await pool.drain();

    const startEvents = backend.events.filter((e) => e.type === 'start');
    assert.equal(startEvents.length, 1);

    pool.shutdown();
  });

  it('should fire onConcurrencyChange on AIMD decrease', async () => {
    const backend = new InMemoryBackend();
    const pool = new AdaptivePool({
      concurrency: 10,
      decreaseFactor: 0.5,
      observability: backend,
    });

    try {
      await pool.submit(() => Promise.reject({ status: 503 }));
    } catch {
      // expected
    }
    await pool.drain();

    const changeEvents = backend.events.filter((e) => e.type === 'concurrencyChange');
    assert.ok(changeEvents.length >= 1, 'Expected at least one concurrency change event');
    const evt = changeEvents[0].data;
    assert.ok(evt.oldLimit > evt.newLimit, `Expected decrease: ${evt.oldLimit} → ${evt.newLimit}`);

    pool.shutdown();
  });

  it('should not fire onConcurrencyChange when concurrency is already at max', async () => {
    const backend = new InMemoryBackend();
    const pool = new AdaptivePool({ concurrency: 2, observability: backend });

    // All successes → concurrency stays at max (2)
    await pool.submit(() => Promise.resolve('a'));
    await pool.submit(() => Promise.resolve('b'));
    await pool.drain();

    const changeEvents = backend.events.filter((e) => e.type === 'concurrencyChange');
    assert.equal(changeEvents.length, 0, 'Expected no concurrency change when already at max');

    pool.shutdown();
  });

  it('should use NoOpBackend by default (no errors)', async () => {
    const pool = new AdaptivePool({ concurrency: 2 });
    // Should not throw — NoOpBackend silently accepts metrics
    await pool.submit(() => Promise.resolve('ok'));
    await pool.drain();
    assert.equal(pool.metrics.completed, 1);
    pool.shutdown();
  });

  it('should expose correct metrics shape', async () => {
    const backend = new InMemoryBackend();
    const pool = new AdaptivePool({ concurrency: 3, observability: backend });

    await pool.submit(() => Promise.resolve('ok'));
    await pool.drain();

    const m = pool.metrics;
    assert.equal(typeof m.concurrency, 'number');
    assert.equal(typeof m.active, 'number');
    assert.equal(typeof m.queued, 'number');
    assert.equal(typeof m.completed, 'number');
    assert.equal(typeof m.failed, 'number');
    assert.equal(typeof m.timedOut, 'number');
    assert.equal(typeof m.transientErrors, 'number');
    assert.equal(typeof m.fatalErrors, 'number');

    pool.shutdown();
  });
});
