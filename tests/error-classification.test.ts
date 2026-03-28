/**
 * tests/error-classification.test.ts — Tests for error classification defaults
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultHttpErrorClassifier, ClassifiedError } from '../dist/index.js';

describe('DefaultHttpErrorClassifier', () => {
  const classifier = new DefaultHttpErrorClassifier();

  it('should classify 429 as transient', () => {
    assert.equal(classifier.classify({ status: 429 }), 'transient');
  });

  it('should classify 502 as transient', () => {
    assert.equal(classifier.classify({ status: 502 }), 'transient');
  });

  it('should classify 503 as transient', () => {
    assert.equal(classifier.classify({ status: 503 }), 'transient');
  });

  it('should classify 504 as transient', () => {
    assert.equal(classifier.classify({ status: 504 }), 'transient');
  });

  it('should classify 500 as transient (server error)', () => {
    assert.equal(classifier.classify({ status: 500 }), 'transient');
  });

  it('should classify 400 as fatal', () => {
    assert.equal(classifier.classify({ status: 400 }), 'fatal');
  });

  it('should classify 401 as fatal', () => {
    assert.equal(classifier.classify({ status: 401 }), 'fatal');
  });

  it('should classify 403 as fatal', () => {
    assert.equal(classifier.classify({ status: 403 }), 'fatal');
  });

  it('should classify 404 as fatal', () => {
    assert.equal(classifier.classify({ status: 404 }), 'fatal');
  });

  it('should classify 422 as fatal', () => {
    assert.equal(classifier.classify({ status: 422 }), 'fatal');
  });

  it('should classify 200 as unknown (success is not an error)', () => {
    // 2xx is not 4xx so falls through to unknown
    assert.equal(classifier.classify({ status: 200 }), 'unknown');
  });

  it('should support statusCode field', () => {
    assert.equal(classifier.classify({ statusCode: 429 }), 'transient');
  });

  it('should classify ECONNRESET as transient', () => {
    const err = new Error('connection reset');
    (err as any).code = 'ECONNRESET';
    assert.equal(classifier.classify(err), 'transient');
  });

  it('should classify ECONNREFUSED as transient', () => {
    const err = new Error('connection refused');
    (err as any).code = 'ECONNREFUSED';
    assert.equal(classifier.classify(err), 'transient');
  });

  it('should classify ETIMEDOUT as transient', () => {
    const err = new Error('timed out');
    (err as any).code = 'ETIMEDOUT';
    assert.equal(classifier.classify(err), 'transient');
  });

  it('should classify EPIPE as transient', () => {
    const err = new Error('broken pipe');
    (err as any).code = 'EPIPE';
    assert.equal(classifier.classify(err), 'transient');
  });

  it('should classify ENOTFOUND as transient', () => {
    const err = new Error('not found');
    (err as any).code = 'ENOTFOUND';
    assert.equal(classifier.classify(err), 'transient');
  });

  it('should classify AbortError by name as transient', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    assert.equal(classifier.classify(err), 'transient');
  });

  it('should classify TimeoutError by name as transient', () => {
    const err = new Error('timed out');
    err.name = 'TimeoutError';
    assert.equal(classifier.classify(err), 'transient');
  });

  it('should classify unknown errors as unknown', () => {
    assert.equal(classifier.classify('just a string'), 'unknown');
    assert.equal(classifier.classify(42), 'unknown');
    assert.equal(classifier.classify(null), 'unknown');
  assert.equal(classifier.classify(undefined), 'unknown');
  });

  it('should pass through ClassifiedError severity', () => {
    const classified = new ClassifiedError('test', 'fatal');
    assert.equal(classifier.classify(classified), 'fatal');

    const classifiedTransient = new ClassifiedError('test', 'transient');
    assert.equal(classifier.classify(classifiedTransient), 'transient');
  });
});
