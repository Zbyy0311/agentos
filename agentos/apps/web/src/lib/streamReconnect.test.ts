import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_RECONNECT_ATTEMPTS,
  UnexpectedStreamEndError,
  getReconnectDelay,
  retryWithExponentialBackoff,
  shouldReconnect,
} from './streamReconnect.ts';

test('uses capped exponential reconnect delays', () => {
  assert.deepEqual(
    Array.from({ length: MAX_RECONNECT_ATTEMPTS }, (_, index) => getReconnectDelay(index)),
    [1000, 2000, 4000, 8000, 16000],
  );
  assert.equal(getReconnectDelay(99), 16000);
});

test('retries an unexpected EOF and succeeds on the third connection', async () => {
  let attempts = 0;
  const delays: number[] = [];
  const result = await retryWithExponentialBackoff(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new UnexpectedStreamEndError();
      return 'recovered';
    },
    { sleep: async delay => { delays.push(delay); } },
  );

  assert.equal(result, 'recovered');
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1000, 2000]);
});

test('does not retry user cancellation, AbortError, or terminal HTTP errors', () => {
  assert.equal(shouldReconnect(new UnexpectedStreamEndError(), { userCancelled: true }), false);
  assert.equal(shouldReconnect(new DOMException('aborted', 'AbortError')), false);
  assert.equal(shouldReconnect(new Error('bad request'), { status: 400 }), false);
  assert.equal(shouldReconnect(new Error('server unavailable'), { status: 503 }), true);
});

test('stops after five reconnect attempts', async () => {
  let attempts = 0;
  await assert.rejects(
    retryWithExponentialBackoff(
      async () => { attempts += 1; throw new UnexpectedStreamEndError(); },
      { sleep: async () => {} },
    ),
    UnexpectedStreamEndError,
  );
  assert.equal(attempts, MAX_RECONNECT_ATTEMPTS + 1);
});
