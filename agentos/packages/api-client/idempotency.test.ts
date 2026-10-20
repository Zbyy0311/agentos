import assert from 'node:assert/strict';
import test from 'node:test';
import { idempotencyHeaders, newIdempotencyKey } from './src/idempotency.ts';

test('generates UUID-shaped unique keys', () => {
  const key = newIdempotencyKey();
  assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(newIdempotencyKey(), newIdempotencyKey());
});

test('optionally prefixes the key with an operation scope', () => {
  const key = newIdempotencyKey('approval-resolve');
  assert.match(key, /^approval-resolve:[0-9a-f-]{36}$/);
});

test('emits the Idempotency-Key header', () => {
  assert.deepEqual(idempotencyHeaders('k1'), { 'Idempotency-Key': 'k1' });
});
