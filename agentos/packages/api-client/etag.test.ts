import assert from 'node:assert/strict';
import test from 'node:test';
import { createETagTracker, ifMatchHeaders, readETag } from './src/etag.ts';

test('readETag returns the strong tag and strips the weak prefix', () => {
  assert.equal(readETag(new Response(null, { headers: { ETag: '"abc-123"' } })), '"abc-123"');
  assert.equal(readETag(new Response(null, { headers: { ETag: 'W/"abc-123"' } })), '"abc-123"');
  assert.equal(readETag(new Response(null)), undefined);
  assert.equal(readETag(new Response(null, { headers: { ETag: '   ' } })), undefined);
});

test('ifMatchHeaders quotes bare values and passes through quoted tags', () => {
  assert.deepEqual(ifMatchHeaders('abc'), { 'If-Match': '"abc"' });
  assert.deepEqual(ifMatchHeaders('"abc"'), { 'If-Match': '"abc"' });
  assert.deepEqual(ifMatchHeaders('W/"abc"'), { 'If-Match': 'W/"abc"' });
});

test('tracker keeps the latest etag and emits conditional headers', () => {
  const tracker = createETagTracker();
  assert.deepEqual(tracker.headers(), {});
  tracker.updateFrom(new Response(null, { headers: { ETag: '"v1"' } }));
  assert.equal(tracker.current(), '"v1"');
  assert.deepEqual(tracker.headers(), { 'If-Match': '"v1"' });
  // A response without an ETag keeps the previous value.
  tracker.updateFrom(new Response(null));
  assert.equal(tracker.current(), '"v1"');
});
