import assert from 'node:assert/strict';
import test from 'node:test';

import { applyGroupWalkEvent, emptyGroupWalk, type GroupWalkStreamState } from './groupWalkStream';

function run(events: Array<[string, Record<string, unknown>]>): GroupWalkStreamState {
  return events.reduce((state, [event, data]) => applyGroupWalkEvent(state, event, data), emptyGroupWalk());
}

test('group.plan records the plan, the skips, and the terminal reason without running a turn', () => {
  const state = run([
    ['group.plan', {
      interactionId: 'int1', speakers: ['codex', 'kimi'],
      skipped: [{ agentId: 'third', reason: 'not-orchestrated' }],
    }],
  ]);
  assert.equal(state.phase, 'walking');
  assert.deepEqual(state.plannedSpeakers, ['codex', 'kimi']);
  assert.deepEqual(state.skipped, [{ agentId: 'third', reason: 'not-orchestrated' }]);
  assert.equal(state.speakers.length, 0);
});

test('a speaker accumulates its checkpoint text and finalizes with its reply id', () => {
  const state = run([
    ['group.plan', { interactionId: 'int1', speakers: ['codex'], skipped: [] }],
    ['group.turn.start', { interactionId: 'int1', agentId: 'codex', turnId: 't1', messageId: 'm1' }],
    ['checkpoint', { agentId: 'codex', turnId: 't1', messageId: 'm1', cursor: 1, delta: 'Hel' }],
    ['checkpoint', { agentId: 'codex', turnId: 't1', messageId: 'm1', cursor: 2, delta: 'lo' }],
    ['group.turn.final', { interactionId: 'int1', agentId: 'codex', turnId: 't1', messageId: 'm1', replyId: 'r1' }],
    ['group.done', { interactionId: 'int1', endedBy: 'completed' }],
  ]);
  assert.equal(state.phase, 'done');
  assert.equal(state.endedBy, 'completed');
  assert.equal(state.speakers.length, 1);
  assert.equal(state.speakers[0]!.content, 'Hello');
  assert.equal(state.speakers[0]!.status, 'final');
  assert.equal(state.speakers[0]!.replyId, 'r1');
});

test('a failed turn is recorded failed and the walk ends with its reason', () => {
  const state = run([
    ['group.plan', { interactionId: 'int1', speakers: ['codex'], skipped: [] }],
    ['group.turn.start', { interactionId: 'int1', agentId: 'codex', turnId: 't1', messageId: 'm1' }],
    ['group.turn.failed', { interactionId: 'int1', agentId: 'codex', turnId: 't1', messageId: 'm1', replyId: null }],
    ['group.done', { interactionId: 'int1', endedBy: 'provider-failed' }],
  ]);
  assert.equal(state.phase, 'done');
  assert.equal(state.endedBy, 'provider-failed');
  assert.equal(state.speakers[0]!.status, 'failed');
  assert.equal(state.speakers[0]!.replyId, null);
});

test('a group.error marks the walk failed and group.done keeps it failed', () => {
  const state = run([
    ['group.error', { interactionId: 'int1', error: 'GROUP_WALK_NOT_ACTIVE' }],
    ['group.done', { interactionId: 'int1', endedBy: 'user-stop' }],
  ]);
  assert.equal(state.phase, 'failed');
  assert.equal(state.error, 'GROUP_WALK_NOT_ACTIVE');
  assert.equal(state.endedBy, 'user-stop');
});

test('unknown events and a checkpoint for an unknown turn are ignored safely', () => {
  const state = run([
    ['group.plan', { interactionId: 'int1', speakers: [], skipped: [] }],
    ['mystery.event', { anything: true }],
    ['checkpoint', { agentId: 'codex', turnId: 'unknown', messageId: 'm', cursor: 1, delta: 'x' }],
  ]);
  assert.equal(state.phase, 'walking');
  // The unknown-turn checkpoint creates no phantom speaker.
  assert.equal(state.speakers.length, 0);
});
