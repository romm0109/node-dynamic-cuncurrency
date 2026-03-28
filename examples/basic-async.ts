/**
 * basic-async.ts — Generic async work example
 *
 * Demonstrates submitting tasks to an AdaptivePool and verifying
 * that concurrency is respected via InMemoryBackend observability.
 *
 * Run: npx tsx examples/basic-async.ts
 */

import { AdaptivePool, InMemoryBackend } from '../dist/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function basicAsyncExample(): Promise<string[]> {
  const backend = new InMemoryBackend();
  const pool = new AdaptivePool<string>({
    concurrency: 3,
    observability: backend,
  });

  const results: string[] = [];

  // Submit 9 tasks; only 3 run concurrently
  const tasks = Array.from({ length: 9 }, (_, i) =>
    pool.submit(async () => {
      await sleep(50);
      const msg = `task-${i}`;
      results.push(msg);
      return msg;
    })
  );

  await Promise.all(tasks);
  await pool.drain();

  // Verify max concurrency was observed
  const maxActive = Math.max(...backend.snapshots.map((s) => s.active));
  console.log(`Max concurrent tasks: ${maxActive}`);
  console.log(`All results: [${results.join(', ')}]`);
  console.log(`Total completed: ${pool.metrics.completed}`);
  console.log(`Final concurrency: ${pool.metrics.concurrency}`);

  pool.shutdown();

  if (maxActive > 3) {
    throw new Error(`Concurrency exceeded: ${maxActive} > 3`);
  }
  if (results.length !== 9) {
    throw new Error(`Expected 9 results, got ${results.length}`);
  }

  return results;
}

// Run when executed directly
basicAsyncExample().then((r) => {
  console.log('OK:', r.length, 'tasks completed');
}).catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
