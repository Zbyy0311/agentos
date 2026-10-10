import assert from 'node:assert/strict';
import test from 'node:test';
import { StreamingTextStore } from './streamingTextStore';

test('append accumulates text and notifies subscribers with the full snapshot', () => {
  const store = new StreamingTextStore();
  const seen: string[] = [];
  store.subscribe(text => seen.push(text));

  store.append('a');
  store.append('bc');

  assert.equal(store.getSnapshot(), 'abc');
  assert.deepEqual(seen, ['', 'a', 'abc']);
});

test('subscribe replays the current snapshot immediately', () => {
  const store = new StreamingTextStore('partial');
  const seen: string[] = [];
  store.subscribe(text => seen.push(text));
  assert.deepEqual(seen, ['partial']);
});

test('clear empties the store once and notifies only when text existed', () => {
  const store = new StreamingTextStore('x');
  const seen: string[] = [];
  store.subscribe(text => seen.push(text));

  store.clear();
  store.clear();

  assert.equal(store.getSnapshot(), '');
  assert.deepEqual(seen, ['x', '']);
});

test('unsubscribed listeners stop receiving updates', () => {
  const store = new StreamingTextStore();
  const seen: string[] = [];
  const unsubscribe = store.subscribe(text => seen.push(text));

  store.append('a');
  unsubscribe();
  store.append('b');

  assert.deepEqual(seen, ['', 'a']);
  assert.equal(store.getSnapshot(), 'ab');
});

test('append ignores empty fragments without notifying', () => {
  const store = new StreamingTextStore();
  const seen: string[] = [];
  store.subscribe(text => seen.push(text));

  store.append('');

  assert.equal(store.getSnapshot(), '');
  assert.deepEqual(seen, ['']);
});
