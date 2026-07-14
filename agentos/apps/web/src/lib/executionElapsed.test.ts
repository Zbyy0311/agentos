import test from 'node:test';
import assert from 'node:assert/strict';
import { getElapsedSeconds, shouldRefreshElapsed } from './executionElapsed.js';

test('freezes elapsed seconds at completedAt for terminal executions', () => {
  const execution = {
    startedAt: '2026-07-14T00:00:00.000Z',
    completedAt: '2026-07-14T00:01:05.000Z',
  };

  assert.equal(getElapsedSeconds(execution, Date.parse('2026-07-14T02:00:00.000Z')), 65);
});

test('uses now for a running execution', () => {
  const execution = { startedAt: '2026-07-14T00:00:00.000Z' };

  assert.equal(getElapsedSeconds(execution, Date.parse('2026-07-14T00:00:12.400Z')), 12);
});

test('returns zero for missing, invalid, or negative timestamps', () => {
  assert.equal(getElapsedSeconds({}, Date.now()), 0);
  assert.equal(getElapsedSeconds({ startedAt: 'not-a-date' }, Date.now()), 0);
  assert.equal(getElapsedSeconds({
    startedAt: '2026-07-14T00:01:00.000Z',
    completedAt: '2026-07-14T00:00:00.000Z',
  }), 0);
});

test('refreshes only executions that are not terminal', () => {
  assert.equal(shouldRefreshElapsed('running_cli', true), true);
  assert.equal(shouldRefreshElapsed('streaming_response', true), true);
  assert.equal(shouldRefreshElapsed('completed', false), false);
  assert.equal(shouldRefreshElapsed('waiting_user', true), false);
  assert.equal(shouldRefreshElapsed('failed', false), false);
  assert.equal(shouldRefreshElapsed('cancelled', false), false);
});
