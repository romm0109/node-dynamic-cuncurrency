/**
 * tests/factory-per-downstream.test.ts — Tests for factory-per-downstream pattern
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PoolManager, InMemoryBackend } from '../dist/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('factory-per-downstream', () => {
  it('should create separate pools per key', async () => {
    const manager = new PoolManager<string>(() => ({ concurrency: 3 }));

    await manager.submit('service-a', () => Promise.resolve('a'));
    await manager.submit('service-b', () => Promise.resolve('b'));

    assert.equal(manager.size, 2);
    assert.deepEqual(manager.keys.sort(), ['service-a', 'service-b']);

    manager.shutdownAll();
  });

  it('should reuse existing pool for same key', async () => {
    const manager = new PoolManager<string>(() => ({ concurrency: 5 }));

    await manager.submit('same-key', () => Promise.resolve(1));
    await manager.submit('same-key', () => Promise.resolve(2));

    assert.equal(manager.size, 1);

    manager.shutdownAll();
  });

  it('should apply factory options per downstream', async () => {
    const manager = new PoolManager<string>((key) => {
      if (key === 'limited') return { concurrency: 1 };
      return { concurrency: 10 };
    });

    const limitedPool = manager.getPool('limited');
    const bigPool = manager.getPool('unlimited');

    assert.equal(limitedPool.concurrency, 1);
    assert.equal(bigPool.concurrency, 10);

    manager.shutdownAll();
  });

  it('should isolate failures between downstreams', async () => {
    const manager = new PoolManager<string>(() => ({ concurrency: 5 }));

    // Failing downstream
    try {
      await manager.submit('failing', () => Promise.reject({ status: 503 }));
    } catch {
      // expected
    }

    // Healthy downstream should not be affected
    const result = await manager.submit('healthy', () => Promise.resolve('ok'));
    assert.equal(result, 'ok');

    // Failing pool should have reduced concurrency
    const failingPool = manager.getPool('failing');
    const healthyPool = manager.getPool('healthy');

    assert.ok(
      failingPool.concurrency < 5,
      `Failing pool should have reduced concurrency: ${failingPool.concurrency}`
    );
    assert.equal(
      healthyPool.concurrency, 5,
      'Healthy pool should not be affected'
    );

    manager.shutdownAll();
  });

  it('should drain all pools', async () => {
    const manager = new PoolManager<string>(() => ({ concurrency: 3 }));

    manager.submit('a', () => sleep(30).then(() => 'a'));
    manager.submit('b', () => sleep(30).then(() => 'b'));

    // drainAll should resolve when all tasks complete
    const start = Date.now();
    await manager.drainAll();
    const elapsed = Date.now() - start;

    assert.ok(elapsed >= 20, `Expected ~30ms drain time, got ${elapsed}ms`);

    manager.shutdownAll();
  });

  it('should clear pools on shutdownAll', async () => {
    const manager = new PoolManager<string>(() => ({ concurrency: 3 }));

    manager.submit('x', () => Promise.resolve('x'));
    assert.equal(manager.size, 1);

    await manager.drainAll();
    manager.shutdownAll();

    assert.equal(manager.size, 0);
    assert.equal(manager.keys.length, 0);
  });
});
