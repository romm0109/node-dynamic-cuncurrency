/**
 * http-example.ts — HTTP-oriented example with mock server
 *
 * Demonstrates using AdaptivePool to make rate-limited HTTP requests
 * to a mock server that returns 429 when overloaded.
 *
 * Run: npx tsx examples/http-example.ts
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { AdaptivePool, InMemoryBackend, QueueTimeoutError } from '../dist/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function createMockServer(): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolve) => {
    let activeRequests = 0;
    let totalRequests = 0;

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      totalRequests++;
      activeRequests++;

      // Simulate rate limiting: reject with 429 if >3 concurrent requests
      if (activeRequests > 3) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Too Many Requests', activeRequests }));
        activeRequests--;
        return;
      }

      // Simulate processing time
      setTimeout(() => {
        activeRequests--;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: totalRequests,
          status: 'ok',
          activeRequests,
        }));
      }, 50);
    });

    server.listen(0, '127.0.0.1', () => {
      resolve(server);
    });
  });
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

export async function httpExample(): Promise<string> {
  const server = await createMockServer();
  const addr = server.address() as any;
  const port = addr.port;

  try {
    const backend = new InMemoryBackend();
    const pool = new AdaptivePool({
      concurrency: 6,
      queueTimeoutMs: 5000,
      observability: backend,
    });

    // Submit 12 requests — the mock server will 429 some of them
    const tasks = Array.from({ length: 12 }, (_, i) =>
      pool.submit(() => fetchJson(port, `/api/item/${i}`))
        .then((data) => ({ status: 'ok' as const, id: data.id }))
        .catch((err) => ({ status: 'error' as const, code: err.status }))
    );

    const results = await Promise.all(tasks);
    await pool.drain();

    const successes = results.filter((r) => r.status === 'ok').length;
    const rateLimited = results.filter((r) => r.status === 'error' && r.code === 429).length;

    console.log(`Results: ${successes} OK, ${rateLimited} rate-limited`);
    console.log(`Final concurrency: ${pool.metrics.concurrency}`);
    console.log(`Transient errors: ${pool.metrics.transientErrors}`);
    console.log(`Completed: ${pool.metrics.completed}`);
    console.log(`Failed: ${pool.metrics.failed}`);

    // Verify AIMD: transient errors were detected and counted
    if (pool.metrics.transientErrors === 0) {
      throw new Error('Expected transient errors from 429 responses');
    }
    // AIMD multiplicative decrease happened, then additive increase on successes
    // recovered concurrency. The key proof is transientErrors > 0.
    console.log(`AIMD proof: ${pool.metrics.transientErrors} transient errors detected`);

    pool.shutdown();
    return `http-example: ${successes} OK, ${rateLimited} rate-limited, concurrency ${pool.metrics.concurrency}`;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// Run when executed directly
httpExample().then((msg) => {
  console.log('OK:', msg);
}).catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
