/**
 * tests/http-example.test.ts — HTTP example test with mock server
 *
 * Imports the documented HTTP example and verifies it produces expected output.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { AdaptivePool, InMemoryBackend } from '../dist/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function createMockServer(
  maxConcurrent: number,
  processingMs: number
): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  return new Promise((resolve) => {
    let activeRequests = 0;
    let totalRequests = 0;

    const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      totalRequests++;
      activeRequests++;

      if (activeRequests > maxConcurrent) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Too Many Requests', activeRequests }));
        activeRequests--;
        return;
      }

      setTimeout(() => {
        activeRequests--;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: totalRequests, status: 'ok' }));
      }, processingMs);
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any;
      resolve({ server, port: addr.port });
    });
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function fetchJson(port: number, path: string): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`HTTP ${res.status}: ${body}`) as any;
    err.status = res.status;
    throw err;
  }
  return res.json();
}

describe('HTTP example with mock server', () => {
  let server: ReturnType<typeof createServer>;
  let port: number;

  beforeEach(async () => {
    const s = await createMockServer(3, 30);
    server = s.server;
    port = s.port;
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it('should complete all requests when concurrency stays under server limit', async () => {
    const pool = new AdaptivePool({
      concurrency: 3,
      queueTimeoutMs: 5000,
    });

    const tasks = Array.from({ length: 6 }, (_, i) =>
      pool.submit(() => fetchJson(port, `/item/${i}`))
    );

    const results = await Promise.all(tasks);
    await pool.drain();

    assert.equal(results.length, 6);
    assert.equal(pool.metrics.completed, 6);
    assert.equal(pool.metrics.failed, 0);

    pool.shutdown();
  });

  it('should detect and adapt to 429 rate limiting via AIMD', async () => {
    const backend = new InMemoryBackend();
    const pool = new AdaptivePool({
      concurrency: 10,
      queueTimeoutMs: 5000,
      observability: backend,
    });

    // Submit 10 concurrent requests — server allows max 3, so ~7 get 429
    const tasks = Array.from({ length: 10 }, (_, i) =>
      pool.submit(() => fetchJson(port, `/item/${i}`))
        .then((data) => ({ ok: true, id: data.id }))
        .catch((err) => ({ ok: false, code: err.status }))
    );

    const results = await Promise.all(tasks);
    await pool.drain();

    const successes = results.filter((r) => r.ok).length;
    const rateLimited = results.filter((r) => !r.ok && r.code === 429).length;

    // Some must have succeeded
    assert.ok(successes > 0, 'Expected at least some successful requests');
    // Some must have been rate limited
    assert.ok(rateLimited > 0, `Expected at least one 429 response, got ${rateLimited} rate limited`);

    // Pool should have detected transient errors
    assert.ok(
      pool.metrics.transientErrors > 0,
      `Expected transient errors > 0, got ${pool.metrics.transientErrors}`
    );

    // With 10 concurrency, 7+ 429s with default decreaseFactor=0.5 should
    // bring concurrency well below 10 even if 3 succeed (additive +1 each)
    assert.ok(
      pool.metrics.concurrency < 10,
      `Expected concurrency < 10 after ${rateLimited} 429s, got ${pool.metrics.concurrency}`
    );

    // Verify observability captured error events
    const errorEvents = backend.events.filter((e) => e.type === 'error');
    assert.ok(errorEvents.length > 0, 'Expected error events in observability');

    pool.shutdown();
  });

  it('should demonstrate recovery after transient errors', async () => {
    const pool = new AdaptivePool({
      concurrency: 6,
      queueTimeoutMs: 5000,
      decreaseFactor: 0.5,
    });

    // First batch: overload the server to trigger 429s
    const batch1 = Array.from({ length: 8 }, (_, i) =>
      pool.submit(() => fetchJson(port, `/batch1/${i}`))
        .catch(() => null)
    );
    await Promise.all(batch1);

    const concurrencyAfterErrors = pool.metrics.concurrency;

    // Second batch: fewer requests, should succeed now that concurrency is lower
    const batch2 = Array.from({ length: 3 }, (_, i) =>
      pool.submit(() => fetchJson(port, `/batch2/${i}`))
    );

    const batch2Results = await Promise.all(batch2);
    await pool.drain();

    // All batch2 requests should succeed (within server limits)
    assert.equal(batch2Results.length, 3);
    for (const r of batch2Results) {
      assert.equal(r.status, 'ok');
    }

    // Concurrency should have increased after successful batch2
    assert.ok(
      pool.metrics.concurrency >= concurrencyAfterErrors,
      `Expected concurrency to recover: ${concurrencyAfterErrors} → ${pool.metrics.concurrency}`
    );

    pool.shutdown();
  });

  it('should handle server that returns 500 errors', async () => {
    // Create a server that always returns 500
    const server500 = await new Promise<{ server: ReturnType<typeof createServer>; port: number }>((resolve) => {
      const s = createServer((_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      });
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address() as any;
        resolve({ server: s, port: addr.port });
      });
    });

    const pool = new AdaptivePool({ concurrency: 5 });

    for (let i = 0; i < 3; i++) {
      try {
        await pool.submit(() => fetchJson(server500.port, `/err/${i}`));
      } catch {
        // expected 500
      }
    }
    await pool.drain();

    // 500s are transient → concurrency should decrease
    assert.ok(pool.metrics.concurrency < 5);
    assert.equal(pool.metrics.transientErrors, 3);

    pool.shutdown();
    await closeServer(server500.server);
  });

  it('should not reduce concurrency for 404 errors', async () => {
    const server404 = await new Promise<{ server: ReturnType<typeof createServer>; port: number }>((resolve) => {
      const s = createServer((_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
      });
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address() as any;
        resolve({ server: s, port: addr.port });
      });
    });

    const pool = new AdaptivePool({ concurrency: 5 });

    for (let i = 0; i < 3; i++) {
      try {
        await pool.submit(() => fetchJson(server404.port, `/missing/${i}`));
      } catch {
        // expected 404
      }
    }
    await pool.drain();

    // 404 is fatal → concurrency should NOT change
    assert.equal(pool.metrics.concurrency, 5);
    assert.equal(pool.metrics.fatalErrors, 3);
    assert.equal(pool.metrics.transientErrors, 0);

    pool.shutdown();
    await closeServer(server404.server);
  });
});
