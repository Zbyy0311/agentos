import assert from 'node:assert/strict';
import test from 'node:test';
import { indexPresence, PRESENCE_LABELS } from './agentPresence.js';

test('indexes presence for all agents and exposes stable labels', () => {
  const indexed = indexPresence([{ agentId: 'codex', state: 'working', updatedAt: '2026-01-01T00:00:00Z' }]);
  assert.equal(indexed.get('codex')?.state, 'working');
  assert.equal(PRESENCE_LABELS.waiting, 'Waiting');
});

