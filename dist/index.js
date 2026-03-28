// src/index.ts — public API
export { AdaptivePool } from './pool.js';
export { PoolManager } from './manager.js';
export { ClassifiedError, QueueTimeoutError, DefaultHttpErrorClassifier, } from './errors.js';
export { NoOpBackend, ConsoleLogBackend, InMemoryBackend, } from './observability.js';
