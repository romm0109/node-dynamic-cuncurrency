// src/manager.ts

import { AdaptivePool, AdaptivePoolOptions } from './pool.js';

/**
 * Manages a separate {@link AdaptivePool} per downstream key.
 *
 * This is the recommended pattern when you talk to multiple distinct
 * downstream services. Each service gets its own concurrency controller,
 * so a slow or failing downstream does not affect the others.
 *
 * @example
 * ```ts
 * import { PoolManager } from 'adaptive-concurrency';
 *
 * const manager = new PoolManager<string>(() => ({ concurrency: 5 }));
 *
 * // Each API host gets its own pool with independent concurrency control
 * await manager.submit('api.example.com', () => fetch('https://api.example.com/data'));
 * await manager.submit('cdn.example.com', () => fetch('https://cdn.example.com/img'));
 *
 * // Drain all pools
 * await manager.drainAll();
 * ```
 */
export class PoolManager<TKey extends string = string> {
  private readonly pools = new Map<TKey, AdaptivePool>();
  private readonly factory: (key: TKey) => AdaptivePoolOptions;

  constructor(factory: (key: TKey) => AdaptivePoolOptions) {
    this.factory = factory;
  }

  /**
   * Get or create the pool for a given downstream key.
   */
  getPool(key: TKey): AdaptivePool {
    let pool = this.pools.get(key);
    if (!pool) {
      pool = new AdaptivePool(this.factory(key));
      this.pools.set(key, pool);
    }
    return pool;
  }

  /**
   * Submit a task to the pool associated with the given key.
   */
  submit<R>(key: TKey, task: () => Promise<R>): Promise<R> {
    return this.getPool(key).submit(task) as Promise<R>;
  }

  /**
   * Wait for all pools to drain.
   */
  async drainAll(): Promise<void> {
    await Promise.all([...this.pools.values()].map((p) => p.drain()));
  }

  /**
   * Shut down all pools.
   */
  shutdownAll(): void {
    for (const pool of this.pools.values()) {
      pool.shutdown();
    }
    this.pools.clear();
  }

  /**
   * List of all downstream keys that have active pools.
   */
  get keys(): TKey[] {
    return [...this.pools.keys()];
  }

  /**
   * Number of active pools.
   */
  get size(): number {
    return this.pools.size;
  }
}
