import test from 'node:test';
import assert from 'node:assert/strict';
import { TypewriterQueue } from './typewriterQueue.js';

test('queues chunks and drains exactly one character at a time', () => {
  const queue = new TypewriterQueue();
  queue.enqueue('Codex');
  queue.enqueue(' 已完成');
  const output: string[] = [];
  while (queue.hasPending) output.push(queue.drainOne()!);
  assert.equal(output.join(''), 'Codex 已完成');
  assert.equal(queue.drainOne(), undefined);
});

test('flush returns only the remaining characters and resets the queue', () => {
  const queue = new TypewriterQueue();
  queue.enqueue('abc');
  assert.equal(queue.drainOne(), 'a');
  assert.equal(queue.flush(), 'bc');
  assert.equal(queue.hasPending, false);
});
